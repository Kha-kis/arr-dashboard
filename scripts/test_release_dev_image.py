"""Offline dev publication identity and race controls; never invoke a registry."""

from pathlib import Path
import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import dev_image


SOURCE = "a" * 40
INDEX = "sha256:" + "b" * 64
OLD = "sha256:" + "c" * 64
OTHER = "sha256:" + "d" * 64


class Registry:
    def __init__(self, value=OLD):
        self.tags = {"dev": value, "dev-a-1-1": INDEX}

    def tag_digest(self, tag):
        return self.tags.get(tag)


class DevImageTests(unittest.TestCase):
    def setUp(self):
        self.context = {
            "GITHUB_REPOSITORY": dev_image.REPOSITORY,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_SHA": SOURCE,
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_RUN_ID": "1",
            "GITHUB_RUN_ATTEMPT": "1",
        }
        self.event = {"inputs": {"source_sha": SOURCE}}
        self.registries = {repo: Registry() for repo in dev_image.REGISTRIES}
        self.baseline = {repo: OLD for repo in dev_image.REGISTRIES}
        self.writes = []

    def write(self, repo, index):
        self.writes.append((repo, index))
        self.registries[repo].tags["dev"] = index

    def promote(self, check=lambda: None, write=None):
        dev_image.promote(self.registries, self.baseline, INDEX, check, write or self.write)

    def test_manual_requires_full_exact_dispatch_source_and_canonical_main(self):
        self.assertEqual(dev_image.select_source(self.context, self.event), SOURCE)
        for key, value in [("GITHUB_REPOSITORY", "other/repo"), ("GITHUB_REF", "refs/heads/next"), ("GITHUB_SHA", "b" * 40)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                dev_image.select_source({**self.context, key: value}, self.event)
        for source in [None, "", "main", "a" * 7, "A" * 40, "b" * 40]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                dev_image.select_source(self.context, {"inputs": {"source_sha": source}})

    def test_ci_uses_successful_canonical_push_head_not_workflow_default_sha(self):
        context = {**self.context, "GITHUB_EVENT_NAME": "workflow_run", "GITHUB_SHA": "b" * 40}
        run = {"head_sha": SOURCE, "head_branch": "main", "head_repository": {"full_name": dev_image.REPOSITORY}, "event": "push", "conclusion": "success", "name": "CI", "status": "completed"}
        self.assertEqual(dev_image.select_source(context, {"workflow_run": run}), SOURCE)
        for key, value in [("head_branch", "next"), ("head_repository", {"full_name": "fork/repo"}), ("event", "pull_request"), ("conclusion", "failure"), ("name", "Other"), ("status", "in_progress"), ("head_sha", "main")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                dev_image.select_source(context, {"workflow_run": {**run, key: value}})

    def test_observed_main_advance_and_competing_runs_fail_closed(self):
        def api(path):
            if path.startswith("git/ref/"):
                return {"object": {"sha": SOURCE}}
            return [{"workflow_runs": [{"id": 1, "status": "in_progress"}]}]
        dev_image.check_authority(SOURCE, "1", api)
        for state in ["queued", "in_progress", "waiting", "pending", "requested"]:
            def competing(path):
                return api(path) if path.startswith("git/ref/") else [{"workflow_runs": [{"id": 2, "status": state}]}]
            with self.subTest(state=state), self.assertRaises(ValueError):
                dev_image.check_authority(SOURCE, "1", competing)
        with self.assertRaises(ValueError):
            dev_image.check_authority("b" * 40, "1", api)
        with self.assertRaises(RuntimeError):
            dev_image.check_authority(SOURCE, "1", lambda path: (_ for _ in ()).throw(RuntimeError("API unavailable")))

    def test_success_and_initial_empty_registries(self):
        self.promote()
        self.assertEqual(len(self.writes), 2)
        for repo in self.registries:
            self.registries[repo].tags["dev"] = None
        self.baseline = {repo: None for repo in self.registries}
        self.writes.clear()
        self.promote()
        self.assertEqual(len(self.writes), 2)

    def test_observed_competing_alias_never_overwritten(self):
        for repo in self.registries:
            with self.subTest(repo=repo):
                self.registries[repo].tags["dev"] = OTHER
                with self.assertRaises(ValueError):
                    self.promote()
                self.assertEqual(self.writes, [])
                self.registries[repo].tags["dev"] = OLD

    def test_main_advance_during_build_prevents_all_alias_writes(self):
        with self.assertRaisesRegex(ValueError, "advanced"):
            self.promote(check=lambda: (_ for _ in ()).throw(ValueError("main advanced")))
        self.assertEqual(self.writes, [])

    def test_main_advance_between_registries_stops_without_rollback(self):
        count = 0
        def check():
            nonlocal count
            count += 1
            if count == 3:
                raise ValueError("main advanced")
        with self.assertRaisesRegex(ValueError, "advanced"):
            self.promote(check=check)
        self.assertEqual(len(self.writes), 1)
        self.assertEqual([r.tags["dev"] for r in self.registries.values()], [INDEX, OLD])

    def test_competitor_between_registry_writes_and_readback_failure_stop(self):
        second = dev_image.REGISTRIES[1]
        def write(repo, index):
            self.write(repo, index)
            self.registries[second].tags["dev"] = OTHER
        with self.assertRaises(ValueError):
            self.promote(write=write)
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(self.registries[second].tags["dev"], OTHER)

    def test_readback_conflict_and_write_error_never_claim_success(self):
        for write in [lambda repo, index: self.registries[repo].tags.update(dev=OTHER), lambda repo, index: (_ for _ in ()).throw(RuntimeError("write failed"))]:
            self.setUp()
            with self.assertRaises((ValueError, RuntimeError)):
                self.promote(write=write)

    def test_digest_and_baseline_must_be_complete(self):
        for baseline in [{}, {**self.baseline, "other/repo": OLD}, {**self.baseline, dev_image.REGISTRIES[0]: "unknown"}]:
            with self.assertRaises(ValueError):
                dev_image.promote(self.registries, baseline, INDEX, lambda: None, self.write)
        with self.assertRaises(ValueError):
            dev_image.promote(self.registries, self.baseline, "latest", lambda: None, self.write)
        self.assertEqual(self.writes, [])

    def test_actual_commands_prepare_checkout_and_publish_with_offline_boundaries(self):
        with tempfile.TemporaryDirectory() as folder:
            event = Path(folder) / "event.json"
            event.write_text(json.dumps(self.event))
            outputs = Path(folder) / "outputs"
            context = {**self.context, "GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(outputs),
                       "RUNNER_TEMP": folder, "BUILD_DIGEST": INDEX}
            def read(*args):
                if args[:3] == ("git", "rev-parse", "HEAD"):
                    return SOURCE
                if args[:2] == ("git", "status"):
                    return ""
                self.assertEqual(args[:4], ("gh", "api", "--paginate", "--slurp"))
                if "git/ref/heads/main" in args[-1]:
                    return json.dumps([{"object": {"sha": SOURCE}}])
                return json.dumps([{"workflow_runs": [{"id": 1, "status": "in_progress"}]}])
            tag = f"dev-{SOURCE}-1-1"
            for registry in self.registries.values():
                registry.tags[tag] = INDEX
            def write(args, **kwargs):
                self.assertEqual(args[:5], ["docker", "buildx", "imagetools", "create", "--prefer-index=false"])
                self.assertEqual(args[5], "--tag")
                repo = args[6].removesuffix(":dev")
                self.assertEqual(args[7], f"{repo}@{INDEX}")
                self.assertTrue(kwargs["check"])
                self.write(repo, INDEX)
            with patch.dict(os.environ, context, clear=True), patch.object(dev_image, "output", side_effect=read), patch.object(dev_image, "Registry", side_effect=self.registries.__getitem__), patch.object(dev_image.subprocess, "run", side_effect=write), contextlib.redirect_stdout(io.StringIO()) as log:
                for command in ["prepare", "assert-source", "publish"]:
                    with patch("sys.argv", ["dev_image.py", command]):
                        dev_image.main()
                self.assertIn(f"source={SOURCE}\n", outputs.read_text())
                self.assertIn(f"tag={tag}\n", outputs.read_text())
                self.assertEqual(len(self.writes), 2)
                self.assertEqual(log.getvalue().count('"observedDev"'), 2)
                # A baseline copied from another attempt cannot authorize any write.
                with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}), patch("sys.argv", ["dev_image.py", "publish"]):
                    with self.assertRaisesRegex(ValueError, "different run/source"):
                        dev_image.main()
                self.assertEqual(len(self.writes), 2)

    def test_checkout_mismatch_and_dirty_tree_fail_closed(self):
        for head, status in [("b" * 40, ""), (SOURCE, " M Dockerfile"), (SOURCE, "?? injected")]:
            with self.subTest(head=head, status=status), patch.object(dev_image, "output", side_effect=[head, status]), self.assertRaises(ValueError):
                dev_image.assert_checkout(SOURCE)


class WorkflowContractTests(unittest.TestCase):
    def test_exact_source_serialized_staging_and_digest_scan_contract(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/docker-dev.yml").read_text()
        for expected in [
            "source_sha:", "required: true", "group: dev-image-registry-publication",
            "cancel-in-progress: false", "actions: read", "ref: ${{ github.workflow_sha }}",
            "ref: ${{ steps.identity.outputs.source }}", "persist-credentials: false",
            "python3 -B scripts/dev_image.py prepare", "python3 -B scripts/dev_image.py assert-source",
            "python3 -B scripts/dev_image.py publish", "COMMIT_SHA=${{ steps.identity.outputs.source }}",
            "${{ env.DOCKERHUB_IMAGE }}@${{ steps.build.outputs.digest }}",
            "BUILD_DIGEST: ${{ steps.build.outputs.digest }}",
        ]:
            self.assertIn(expected, workflow)
        self.assertNotIn("${{ env.DOCKERHUB_IMAGE }}:dev\n", workflow)
        self.assertNotIn("${{ env.GHCR_IMAGE }}:dev\n", workflow)
        self.assertNotIn("COMMIT_SHA=${{ github.sha }}", workflow)
        self.assertLess(workflow.index("scripts/dev_image.py assert-source"), workflow.index("push: true"))
        self.assertLess(workflow.index("Run Trivy vulnerability scanner"), workflow.index("scripts/dev_image.py publish"))


if __name__ == "__main__":
    unittest.main()
