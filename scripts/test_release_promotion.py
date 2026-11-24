import hashlib
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile
from unittest.mock import patch

from release_promotion import (
    REGISTRIES, alias_plan, apply_aliases, discover_qualification, main, read_qualification,
    require_release_event, timestamp, verify_copy_plan,
)


INDEX = "sha256:" + "1" * 64
OLD = "sha256:" + "2" * 64
OTHER = "sha256:" + "3" * 64
REPOS = REGISTRIES


class FakeRegistry:
    def __init__(self, repository):
        self.repository = repository
        self.tags = {"2": OLD, "2.25": None, "latest": OLD}

    def tag_digest(self, tag):
        return self.tags.get(tag)


class RegistryFixture(unittest.TestCase):
    def setUp(self):
        self.registries = {repo: FakeRegistry(repo) for repo in REPOS}
        self.plan = alias_plan("2.25.0", {
            repo: {"2": OLD, "2.25": None, "latest": OLD} for repo in REPOS
        })
        self.writes = []
        self.events = []

    def write(self, repo, tag, digest):
        self.writes.append((repo, tag, digest))
        self.registries[repo].tags[tag] = digest

    def apply(self, writer=None):
        apply_aliases(self.registries, self.plan, INDEX, writer or self.write, self.events.append)


class PromotionTests(RegistryFixture):
    def test_version_precedes_floating_aliases_and_only_approved_index_is_used(self):
        self.apply()
        self.assertEqual(self.writes[:2], [(repo, "2.25.0", INDEX) for repo in REPOS])
        self.assertEqual(self.writes[-2:], [(repo, "latest", INDEX) for repo in REPOS])
        self.assertTrue(all(digest == INDEX for _, _, digest in self.writes))
        self.assertEqual(self.events[-1]["status"], "verified")

    def test_conflicting_existing_version_refuses_every_write(self):
        self.registries[REPOS[1]].tags["2.25.0"] = OTHER
        with self.assertRaises(ValueError):
            self.apply()
        self.assertEqual(self.writes, [])

    def test_unexpected_floating_change_refuses_every_write(self):
        self.registries[REPOS[1]].tags["latest"] = OTHER
        with self.assertRaises(ValueError):
            self.apply()
        self.assertEqual(self.writes, [])

    def test_operation_can_resume_with_original_preconditions(self):
        def interrupted(repo, tag, digest):
            self.write(repo, tag, digest)
            raise TimeoutError("write readback unavailable")

        with self.assertRaises(TimeoutError):
            self.apply(interrupted)
        self.assertEqual(self.events[-1]["status"], "incomplete")
        self.assertEqual(self.events[-1]["observed"][REPOS[0]]["2.25.0"], INDEX)
        self.assertIsNone(self.events[-1]["observed"][REPOS[1]]["2.25.0"])
        self.apply()
        self.assertEqual(self.writes.count((REPOS[0], "2.25.0", INDEX)), 1)
        self.assertEqual(self.events[-1]["status"], "verified")

    def test_reads_are_checked_again_before_write(self):
        def drifting(repo, tag, digest):
            self.write(repo, tag, digest)
            self.registries[REPOS[1]].tags["2.25.0"] = OTHER

        with self.assertRaises(ValueError):
            self.apply(drifting)
        self.assertEqual(self.writes, [(REPOS[0], "2.25.0", INDEX)])
        self.assertEqual(self.events[-1]["status"], "incomplete")

    def test_registry_read_errors_are_never_treated_as_absence(self):
        with patch.object(self.registries[REPOS[1]], "tag_digest", side_effect=OSError):
            with self.assertRaises(OSError):
                self.apply()
        self.assertFalse(self.writes)
        self.assertTrue(self.events[-1]["readErrors"])

    def test_bad_expectations_refuse(self):
        with self.assertRaises(ValueError):
            alias_plan("2.25.0", {REPOS[0]: {"latest": OLD}})


SOURCE = "a" * 40
TREE = "b" * 40
TAG = "c" * 40
VERSION = "2.25.0"
REPO = "Kha-kis/arr-dashboard"
REF = "refs/tags/v" + VERSION
BEFORE = "2026-11-24T12:00:00Z"
TAGGED = "2026-11-24T12:01:00Z"
CUTOFF = timestamp(TAGGED)


class TagEventTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.event_path = Path(directory.name) / "event.json"
        self.env = {
            "GITHUB_REPOSITORY": REPO, "GITHUB_EVENT_NAME": "push",
            "GITHUB_ACTOR": "Kha-kis", "GITHUB_TRIGGERING_ACTOR": "Kha-kis",
            "GITHUB_REF": REF, "GITHUB_REF_PROTECTED": "true", "GITHUB_SHA": SOURCE,
            "GITHUB_RUN_ID": "81",
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_EVENT_PATH": str(self.event_path),
        }
        self.event = {
            "ref": REF, "before": "0" * 40, "after": TAG,
            "created": True, "deleted": False, "forced": False,
            "sender": {"login": "Kha-kis"}, "repository": {"full_name": REPO},
        }
        self.api = {
            "git/ref/tags/v2.25.0": {"ref": REF, "object": {"type": "tag", "sha": TAG}},
            f"git/tags/{TAG}": {"tag": "v2.25.0", "object": {"type": "commit", "sha": SOURCE},
                                "tagger": {"date": TAGGED}},
            "git/ref/heads/main": {"object": {"sha": SOURCE}},
            "actions/runs/81": {"id": 81, "event": "push", "head_sha": SOURCE, "created_at": TAGGED},
            "actions/workflows/196258923": {"state": "disabled_manually"},
        }
        self.package = VERSION

    def authorize(self, **env):
        self.event_path.write_text(json.dumps(self.event))
        with (patch.dict(os.environ, {**self.env, **env}, clear=True),
              patch("release_promotion.get_api", side_effect=self.api.__getitem__),
              patch("release_promotion.output", side_effect=[SOURCE.encode(),
                    json.dumps({"version": self.package}).encode()])):
            return require_release_event()

    def test_canonical_tag_and_deliberate_owner_rerun(self):
        self.assertEqual(self.authorize(), (VERSION, SOURCE, TAG, CUTOFF))
        self.assertEqual(self.authorize(GITHUB_RUN_ATTEMPT="2"), (VERSION, SOURCE, TAG, CUTOFF))

    def test_untrusted_or_non_tag_path_refused(self):
        cases = [
            {"GITHUB_REPOSITORY": "fork/arr-dashboard"},
            {"GITHUB_EVENT_NAME": "workflow_dispatch"},
            {"GITHUB_REF": "refs/heads/main"},
            {"GITHUB_REF_PROTECTED": "false"},
            {"GITHUB_REF": "refs/tags/v2.25.0-rc.1"},
            {"GITHUB_ACTOR": "another-account"},
            {"GITHUB_TRIGGERING_ACTOR": "another-account"},
            {"GITHUB_SHA": "d" * 40},
        ]
        for env in cases:
            with self.subTest(env=env), self.assertRaises(ValueError):
                self.authorize(**env)

    def test_tag_deletion_update_or_wrong_event_identity_refused(self):
        for key, value in (("created", False), ("deleted", True), ("forced", True),
                           ("before", TAG), ("after", "d" * 40)):
            with self.subTest(key=key), patch.dict(self.event, {key: value}), self.assertRaises(ValueError):
                self.authorize()

    def test_advanced_main_and_lightweight_tag_refused(self):
        with patch.dict(self.api, {"git/ref/heads/main": {"object": {"sha": TAG}}}):
            with self.assertRaisesRegex(ValueError, "current main"):
                self.authorize()
        self.api["git/ref/tags/v2.25.0"]["object"]["type"] = "commit"
        with self.assertRaisesRegex(ValueError, "annotated"):
            self.authorize()

    def test_version_and_legacy_workflow_hold(self):
        self.package = "2.24.1"
        with self.assertRaisesRegex(ValueError, "package version"):
            self.authorize()
        self.package = VERSION
        self.api["actions/workflows/196258923"]["state"] = "active"
        with self.assertRaisesRegex(ValueError, "retire the historical"):
            self.authorize()


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.run = {
            "id": 39, "run_attempt": 1, "workflow_id": 99, "event": "workflow_dispatch",
            "head_branch": "main", "head_repository": {"full_name": REPO},
            "head_sha": SOURCE, "status": "completed", "conclusion": "success", "updated_at": BEFORE,
        }
        self.record = {"source": SOURCE, "indexDigest": INDEX}
        raw = json.dumps(self.record).encode()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as writer:
            writer.writestr("release-qualification.json", raw)
        self.archive = archive.getvalue()
        self.sha = hashlib.sha256(raw).hexdigest()
        self.meta = {"id": 123, "name": "release-qualification-attempt-1", "size_in_bytes": len(self.archive),
                     "digest": "sha256:" + hashlib.sha256(self.archive).hexdigest(),
                     "created_at": BEFORE, "expired": False}

    def read(self):
        values = {"actions/runs/39/attempts/1": self.run,
                  "actions/runs/39/artifacts?name=release-qualification-attempt-1&per_page=2": {
                      "total_count": 1, "artifacts": [self.meta]}}
        with (patch("release_promotion.get_api", side_effect=values.__getitem__),
              patch("release_promotion.output", return_value=self.archive) as download):
            try:
                return read_qualification(39, SOURCE, CUTOFF, 99)
            finally:
                self.downloaded = download.called

    def test_exact_canonical_pre_tag_archive(self):
        self.assertEqual(self.read(), (self.record, self.sha))
        self.assertTrue(self.downloaded)

    def test_failed_wrong_source_or_post_tag_stage_never_downloads(self):
        for key, value in (("head_sha", TAG), ("workflow_id", 91), ("run_attempt", 2)):
            with self.subTest(key=key), patch.dict(self.run, {key: value}), self.assertRaises(ValueError):
                self.read()
            self.assertFalse(self.downloaded)
        for key, value in (("conclusion", "failure"), ("updated_at", TAGGED)):
            with self.subTest(key=key), patch.dict(self.run, {key: value}):
                self.assertIsNone(self.read())
            self.assertFalse(self.downloaded)

    def test_expired_late_and_tampered_archive_refused(self):
        for key, value in (("expired", True), ("created_at", TAGGED), ("digest", OTHER)):
            with self.subTest(key=key), patch.dict(self.meta, {key: value}), self.assertRaises(ValueError):
                self.read()


def qualified_record(stage_id=39, **overrides):
    return {
        "version": VERSION, "source": SOURCE, "tree": TREE, "runId": stage_id, "runAttempt": 1,
        "indexDigest": INDEX,
        "expectedAliases": {repo: {"2": OLD, "2.25": None, "latest": OLD} for repo in REPOS},
        **overrides,
    }


class DiscoveryTests(unittest.TestCase):
    def discover(self, runs, records, total=None):
        found = {"total_count": len(runs) if total is None else total, "workflow_runs": runs}
        workflow = {"id": 99, "path": ".github/workflows/docker-stage.yml", "state": "active"}
        with (patch("release_promotion.get_api", side_effect=[workflow, found]) as api,
              patch("release_promotion.read_qualification",
                    side_effect=lambda stage_id, *args: (records[stage_id], "1" * 64))):
            try:
                return discover_qualification(VERSION, SOURCE, TREE, CUTOFF)
            finally:
                self.api = api

    def run_before(self, stage_id, when=BEFORE):
        return {"id": stage_id, "run_attempt": 1, "created_at": when, "updated_at": when}

    def test_deterministic_equivalent_stage_and_no_post_tag_selection(self):
        records = {i: qualified_record(i) for i in (39, 40)}
        stage, *_ = self.discover([self.run_before(40), self.run_before(70, TAGGED), self.run_before(39)], records)
        self.assertEqual(stage, 39)
        self.assertIn(f"head_sha={SOURCE}&branch=main&event=workflow_dispatch&per_page=100", self.api.call_args.args[0])

    def test_later_rerun_cannot_hide_an_original_qualification(self):
        # The list endpoint exposes the latest attempt. The original successful
        # attempt and its incompatible immutable receipt still exist.
        original = {"id": 40, "run_attempt": 2, "created_at": BEFORE, "updated_at": TAGGED}
        with self.assertRaisesRegex(ValueError, "incompatible"):
            self.discover([self.run_before(39), original],
                          {39: qualified_record(), 40: qualified_record(40, indexDigest=OTHER)})

    def test_missing_stale_or_incomplete_discovery_fails_closed(self):
        for runs, total in (([], 0), ([self.run_before(40, TAGGED)], 1), ([], 101)):
            with self.subTest(total=total), self.assertRaises(ValueError):
                self.discover(runs, {}, total)

    def test_version_tree_and_ambiguous_records_fail_closed(self):
        prior = qualified_record()
        for changes in ({"version": "2.24.1"}, {"tree": TAG}, {"indexDigest": OTHER}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.discover([self.run_before(39), self.run_before(40)],
                              {39: prior, 40: qualified_record(40, **changes)})


class WriteBoundaryTests(RegistryFixture):
    def workflow(self, mode, *, selection=None, graph_error=None, attempt="1"):
        record = qualified_record()
        group = (39, record, "1" * 64, self.plan)
        correct = f"{TAG}:39:" + "1" * 64 + f":{INDEX}"
        with TemporaryDirectory() as directory:
            path = Path(directory) / "output"
            with (patch.dict(os.environ, {"GITHUB_OUTPUT": str(path), "GITHUB_RUN_ATTEMPT": attempt,
                        "PREFLIGHT_SELECTION": correct if selection is None else selection}),
                  patch("release_promotion.require_release_event",
                        return_value=(VERSION, SOURCE, TAG, CUTOFF)),
                  patch("release_promotion.output", return_value=TREE.encode()),
                  patch("release_promotion.discover_qualification", return_value=group),
                  patch("release_promotion.verify_qualification", side_effect=graph_error),
                  patch("release_promotion.Registry", side_effect=self.registries.__getitem__),
                  patch("release_promotion.verify_copy_plan") as verify,
                  patch("release_promotion.copy_index", side_effect=self.write),
                  patch("release_promotion.emit_record", side_effect=self.events.append)):
                main(mode)
                if mode == "promote":
                    self.assertEqual(verify.call_count, 2)
            if mode == "preflight":
                self.assertEqual(path.read_text().strip(), "selection=" + correct)

    def test_preflight_and_tag_promotion_use_the_qualified_digest(self):
        self.workflow("preflight")
        self.assertEqual(self.writes, [])
        self.workflow("promote")
        self.assertEqual(len(self.writes), 8)
        self.assertTrue(all(index == INDEX for _, _, index in self.writes))

    def test_invalid_graph_or_changed_selection_never_writes(self):
        with self.assertRaisesRegex(ValueError, "missing blob"):
            self.workflow("promote", graph_error=ValueError("missing blob"))
        with self.assertRaisesRegex(ValueError, "preflight"):
            self.workflow("promote", selection="different")
        self.assertEqual(self.writes, [])

    def test_existing_partial_state_requires_deliberate_rerun(self):
        self.registries[REPOS[0]].tags["2.25.0"] = INDEX
        with self.assertRaisesRegex(ValueError, "deliberate rerun"):
            self.workflow("promote")
        self.assertEqual(self.writes, [])
        self.workflow("promote", attempt="2")
        self.assertEqual(len(self.writes), 7)

    def test_copy_plan_requires_identity_before_write(self):
        fixture = b'{"schemaVersion":2,"manifests":[]}'
        digest = "sha256:" + hashlib.sha256(fixture).hexdigest()
        with patch("release_promotion.output", return_value=fixture + bytes([10])) as command:
            verify_copy_plan(REPOS[0], digest)
            command.assert_called_once_with("docker", "buildx", "imagetools", "create", "--prefer-index=false", "--dry-run",
                                            f"{REPOS[0]}@{digest}")
        with patch("release_promotion.output", return_value=fixture + b"changed"):
            with self.assertRaises(ValueError):
                verify_copy_plan(REPOS[0], digest)


if __name__ == "__main__":
    unittest.main()
