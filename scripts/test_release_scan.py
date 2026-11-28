"""Focused offline tests for exact Trivy-to-OCI image identity binding."""
import hashlib
import json
import unittest

import release_registry as rr
import release_scan as rs

SOURCE = "a" * 40
TREE = "b" * 40
VERSION = "2.25.0"
BUILD_DATE = "2026-11-24T12:24:36Z"
IMAGE = "ghcr.io/kha-kis/arr-dashboard"


def raw_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class FixtureRegistry:
    def __init__(self, arch="amd64"):
        self.arch = arch
        self.config = {
            "os": "linux",
            "architecture": arch,
            "config": {"Labels": {
                "org.opencontainers.image.revision": SOURCE,
                "org.opencontainers.image.version": VERSION,
                "org.opencontainers.image.created": BUILD_DATE,
            }},
        }
        self.config_bytes = raw_json(self.config)
        self.config_digest = digest(self.config_bytes)
        self.manifest = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"digest": self.config_digest, "size": len(self.config_bytes)},
            "layers": [],
        }
        self.manifest_bytes = raw_json(self.manifest)
        self.manifest_digest = digest(self.manifest_bytes)

    def _manifest(self, ref):
        if ref != self.manifest_digest:
            raise rr.QualificationError("fixture manifest reference mismatch")
        return self.manifest, self.manifest_bytes, self.manifest_digest

    def blob(self, ref, size, label):
        if ref != self.config_digest:
            raise rr.QualificationError("fixture config reference mismatch")
        rr._verify_bytes(self.config_bytes, ref, size, label)
        return self.config_bytes


def report(registry, image_id=None):
    ref = f"{IMAGE}@{registry.manifest_digest}"
    return {
        "ArtifactName": ref,
        "Metadata": {
            "ImageID": image_id or registry.config_digest,
            "Reference": ref,
            "RepoDigests": [ref],
            "RepoTags": [ref],
            "ImageConfig": {
                "architecture": registry.arch,
                "os": "linux",
                "config": {"Labels": {
                    "org.opencontainers.image.revision": SOURCE,
                    "org.opencontainers.image.version": VERSION,
                    "org.opencontainers.image.created": BUILD_DATE,
                }},
            },
            "OS": {"Family": "alpine", "Name": "3.24.4"},
        },
        "Results": [
            {"Class": "os-pkgs", "Type": "alpine", "Vulnerabilities": []},
            {"Class": "lang-pkgs", "Type": "node-pkg", "Vulnerabilities": []},
        ],
    }


class ReleaseScanTests(unittest.TestCase):
    def verify(self, item, registry, **overrides):
        args = {
            "architecture": registry.arch,
            "image_ref": f"{IMAGE}@{registry.manifest_digest}",
            "manifest_digest": registry.manifest_digest,
            "config_digest": registry.config_digest,
            "registry": registry,
            "expected_config": {"source": SOURCE, "version": VERSION, "buildDate": BUILD_DATE},
        }
        args.update(overrides)
        return rs.validate_report(item, **args)

    def test_accepts_manifest_or_config_image_id_when_exact_child_is_bound(self):
        for arch in ("amd64", "arm64"):
            registry = FixtureRegistry(arch)
            for image_id in (registry.manifest_digest, registry.config_digest):
                with self.subTest(arch=arch, image_id=image_id):
                    self.verify(report(registry, image_id), registry)

    def test_rejects_unrelated_or_contradictory_identity(self):
        registry = FixtureRegistry()
        mutations = (
            lambda value: value["Metadata"].update(ImageID="sha256:" + "0" * 64),
            lambda value: value["Metadata"].update(Reference="ghcr.io/kha-kis/arr-dashboard:latest"),
            lambda value: value["Metadata"].update(RepoDigests=[]),
            lambda value: value["Metadata"].update(RepoTags=["ghcr.io/kha-kis/arr-dashboard:latest"]),
            lambda value: value.update(ArtifactName="ghcr.io/kha-kis/arr-dashboard:latest"),
            lambda value: value["Metadata"]["ImageConfig"].update(architecture="arm64"),
        )
        for mutate in mutations:
            value = report(registry)
            mutate(value)
            with self.subTest(mutate=mutate):
                with self.assertRaises(rr.QualificationError):
                    self.verify(value, registry)

    def test_rejects_manifest_config_mismatch_and_bad_raw_bytes(self):
        registry = FixtureRegistry()
        wrong = "sha256:" + "0" * 64
        with self.assertRaises(rr.QualificationError):
            self.verify(report(registry), registry, config_digest=wrong)

        registry.manifest_bytes += b" "
        with self.assertRaises(rr.QualificationError):
            self.verify(report(registry), registry)

    def test_preserves_platform_coverage_eosl_and_severity_gates(self):
        registry = FixtureRegistry()
        for mutate in (
            lambda value: value["Metadata"]["OS"].update(EOSL=True),
            lambda value: value["Results"].pop(),
            lambda value: value["Results"][0]["Vulnerabilities"].append({"Severity": "HIGH"}),
            lambda value: value["Results"][0]["Vulnerabilities"].append({"Severity": "CRITICAL"}),
        ):
            value = report(registry)
            mutate(value)
            with self.subTest(mutate=mutate):
                with self.assertRaises(rr.QualificationError):
                    self.verify(value, registry)


if __name__ == "__main__":
    unittest.main()
