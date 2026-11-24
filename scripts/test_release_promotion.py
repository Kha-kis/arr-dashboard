import hashlib
import io
import json
import os
import unittest
import zipfile
from unittest.mock import patch

from release_promotion import alias_plan, apply_aliases, main, read_qualification, require_environment_approval, verify_copy_plan


INDEX = "sha256:" + "1" * 64
OLD = "sha256:" + "2" * 64
OTHER = "sha256:" + "3" * 64
REPOS = ("khak1s/arr-dashboard", "ghcr.io/kha-kis/arr-dashboard")


class FakeRegistry:
    def __init__(self, repository):
        self.repository = repository
        self.tags = {"2": OLD, "2.25": None, "latest": OLD}

    def tag_digest(self, tag):
        return self.tags.get(tag)


class PromotionTests(unittest.TestCase):
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


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "id": 19,
            "name": "stable-release",
            "can_admins_bypass": False,
            "protection_rules": [
                {"type": "required_reviewers", "reviewers": [{"type": "User", "reviewer": {"id": 7}}]}
            ],
        }

        self.comment = "Promote v2.25.0 " + INDEX + " " + "1" * 64
        self.approvals = [{
            "state": "approved", "user": {"id": 7}, "environments": [{"id": 19}],
            "comment": self.comment,
        }]

    def test_explicit_environment_approval(self):
        require_environment_approval(self.env, self.approvals, self.comment)

    def test_unprotected_or_bypassable_environment_refuses(self):
        for patch_fields in ({"protection_rules": []}, {"can_admins_bypass": True}):
            with self.assertRaises(ValueError):
                require_environment_approval({**self.env, **patch_fields}, self.approvals, self.comment)

    def test_get_environment_api_without_optional_bypass_metadata(self):
        self.env.pop("can_admins_bypass")
        require_environment_approval(self.env, self.approvals, self.comment)

    def test_generic_or_wrong_index_approval_refuses(self):
        for comment in ("Approved", self.comment.replace(INDEX, OTHER)):
            with self.assertRaises(ValueError):
                require_environment_approval(self.env, [{**self.approvals[0], "comment": comment}], self.comment)

    def test_no_approval_or_other_environment_refuses(self):
        for history in ([], [{**self.approvals[0], "environments": [{"id": 11}]}],
                        [{**self.approvals[0], "user": {"id": 8}}]):
            with self.assertRaises(ValueError):
                require_environment_approval(self.env, history, self.comment)


class QualificationRecordTests(unittest.TestCase):
    def setUp(self):
        self.source = "a" * 40
        self.run = {
            "id": 39, "run_attempt": 1, "workflow_id": 99, "event": "workflow_dispatch",
            "head_branch": "main", "head_repository": {"full_name": "Kha-kis/arr-dashboard"},
            "head_sha": self.source, "status": "completed", "conclusion": "success",
        }
        self.artifact = {"id": 123, "name": "release-qualification-attempt-1",
                         "size_in_bytes": 512, "expired": False}
        self.record = {"source": self.source, "indexDigest": INDEX}
        raw = json.dumps(self.record).encode()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as writer:
            writer.writestr("release-qualification.json", raw)
        self.archive = archive.getvalue()
        self.sha = hashlib.sha256(raw).hexdigest()

    def api(self, path):
        values = {
            "actions/workflows/docker-combined.yml": {"id": 99},
            "actions/runs/39/attempts/1": self.run,
            "actions/runs/39/artifacts?name=release-qualification-attempt-1&per_page=2": {
                "total_count": 1, "artifacts": [self.artifact],
            },
        }
        return values[path]

    def read(self, expected_sha=None):
        with patch("release_promotion.get_api", side_effect=self.api), patch(
            "release_promotion.output", return_value=self.archive
        ) as download:
            try:
                return read_qualification("39", "1", self.source, expected_sha or self.sha)
            finally:
                self.downloaded = download.called

    def test_exact_archive_and_receipt_hash(self):
        self.assertEqual(self.read(), self.record)
        self.assertTrue(self.downloaded)

    def test_failed_stage_never_downloads(self):
        self.run["conclusion"] = "failure"
        with self.assertRaises(ValueError):
            self.read()
        self.assertFalse(self.downloaded)

    def test_untrusted_workflow_never_downloads(self):
        self.run["workflow_id"] = 100
        with self.assertRaises(ValueError):
            self.read()
        self.assertFalse(self.downloaded)

    def test_wrong_receipt_hash_refuses(self):
        with self.assertRaises(ValueError):
            self.read("0" * 64)

    def test_expired_artifact_refuses(self):
        self.artifact["expired"] = True
        with self.assertRaises(ValueError):
            self.read()
        self.assertFalse(self.downloaded)


class WriteBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "RELEASE_VERSION": "2.25.0", "STAGE_RUN_ID": "39", "STAGE_RUN_ATTEMPT": "1",
            "QUALIFICATION_SHA256": "1" * 64, "QUALIFIED_INDEX_DIGEST": INDEX,
            "EXPECTED_ALIASES": json.dumps({
                repo: {"2.25": None, "2": OLD, "latest": OLD} for repo in REPOS
            }),
        }

    def test_missing_approval_prevents_artifact_download_and_write(self):
        with (patch.dict(os.environ, self.env),
              patch("release_promotion.require_dispatch", return_value=("a" * 40, "81")),
              patch("release_promotion.approved", side_effect=ValueError("missing approval")),
              patch("release_promotion.read_qualification") as read,
              patch("release_promotion.apply_aliases") as apply):
            with self.assertRaisesRegex(ValueError, "missing approval"):
                main("promote")
            read.assert_not_called()
            apply.assert_not_called()

    def test_invalid_qualification_graph_prevents_every_write(self):
        with (patch.dict(os.environ, self.env),
              patch("release_promotion.require_dispatch", return_value=("a" * 40, "81")),
              patch("release_promotion.approved"), patch("release_promotion.require_tag"),
              patch("release_promotion.output", side_effect=[b'{"version":"2.25.0"}', b"b" * 40]),
              patch("release_promotion.read_qualification", return_value={}),
              patch("release_registry.verify_qualification", side_effect=ValueError("missing blob")),
              patch("release_promotion.copy_index") as copy,
              patch("release_promotion.apply_aliases") as apply):
            with self.assertRaisesRegex(ValueError, "missing blob"):
                main("promote")
            copy.assert_not_called()
            apply.assert_not_called()

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
