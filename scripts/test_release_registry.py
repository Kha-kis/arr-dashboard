"""Offline structural and graph regression tests for release_registry."""
import hashlib
import json
import unittest
from unittest.mock import patch

import release_registry as rr

SOURCE = "a" * 40
TREE = "b" * 40
BUILD_DATE = "2026-11-23T01:02:03Z"
VERSION = "2.25.0"
INDEX_PLACEHOLDER = "sha256:" + "0" * 64


def raw_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def receipt(arch, native_index=INDEX_PLACEHOLDER):
    return {
        "architecture": arch,
        "indexDigest": native_index,
        "manifestDigest": digest((arch + "-manifest").encode()),
        "configDigest": digest((arch + "-config").encode()),
        "source": SOURCE,
        "tree": TREE,
        "version": VERSION,
        "buildDate": BUILD_DATE,
        "assets": {"web": "1" * 64, "sqlite": "2" * 64, "postgresql": "3" * 64},
        "scan": {
            "highCritical": 0,
            "osPackages": True,
            "nodePackages": True,
            "reportSha256": "4" * 64,
        },
        "runtime": {
            "healthy": True,
            "cleanStop": True,
            "restart": True,
            "browserCases": 15,
        },
    }


class MemoryRegistry(rr.Registry):
    def __init__(self, graph):
        self.image = "fixture"
        self.manifests = graph["manifests"]
        self.blobs = graph["blobs"]

    def _manifest(self, reference):
        if reference not in self.manifests:
            raise rr.QualificationError("fixture manifest missing")
        raw = self.manifests[reference]
        return rr._object(raw, "fixture manifest"), raw, digest(raw)

    def blob(self, blob_digest, size, label):
        if blob_digest not in self.blobs:
            raise rr.QualificationError("fixture blob missing")
        data = self.blobs[blob_digest]
        rr._verify_bytes(data, blob_digest, size, label)
        return data

    def blob_head(self, blob_digest):
        if blob_digest not in self.blobs:
            raise rr.QualificationError("fixture layer missing")


def build_graph(bad_provenance=False, sbom_missing_source=True):
    manifests = {}
    blobs = {}

    def add_blob(data):
        blob_digest = digest(data)
        blobs[blob_digest] = data
        return {"digest": blob_digest, "size": len(data)}

    def add_manifest(value):
        data = raw_json(value)
        manifest_digest = digest(data)
        manifests[manifest_digest] = data
        return {"digest": manifest_digest, "size": len(data)}

    runtime = {}
    attestation_descriptors = {}
    configs = {}
    native_indexes = {}
    for arch in ("amd64", "arm64"):
        config = {
            "os": "linux",
            "architecture": arch,
            "created": "deliberately-not-the-release-date",
            "config": {
                "Labels": {
                    "org.opencontainers.image.revision": SOURCE,
                    "org.opencontainers.image.version": VERSION,
                    "org.opencontainers.image.created": BUILD_DATE,
                }
            },
        }
        config_desc = add_blob(raw_json(config))
        configs[arch] = config_desc["digest"]
        layer_desc = add_blob((arch + "-runtime-layer").encode())
        runtime_desc = add_manifest(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {
                    **config_desc,
                    "mediaType": "application/vnd.oci.image.config.v1+json",
                },
                "layers": [
                    {
                        **layer_desc,
                        "mediaType": "application/vnd.oci.image.layer.v1.tar",
                    }
                ],
            }
        )
        runtime_desc["mediaType"] = "application/vnd.oci.image.manifest.v1+json"
        runtime_desc["platform"] = {"os": "linux", "architecture": arch}
        runtime[arch] = runtime_desc
        child_hex = runtime_desc["digest"].removeprefix("sha256:")
        sbom = {
            "_type": "https://in-toto.io/Statement/v1",
            "subject": [{"name": "arr-dashboard", "digest": {"sha256": child_hex}}],
            "predicateType": "https://spdx.dev/Document",
            "predicate": {},
        }
        source = "b" * 40 if bad_provenance else SOURCE
        provenance = {
            "_type": "https://in-toto.io/Statement/v1",
            "subject": [{"name": "arr-dashboard", "digest": {"sha256": child_hex}}],
            "predicateType": "https://slsa.dev/provenance/v1",
            "predicate": {
                "buildDefinition": {
                    "externalParameters": {
                        "request": {
                            "root": {
                                "request": {
                                    "args": {
                                        "vcs:source": "https://github.com/Kha-kis/arr-dashboard",
                                        "vcs:revision": source,
                                        "build-arg:COMMIT_SHA": source,
                                    }
                                }
                            }
                        }
                    }
                }
            },
        }
        sbom_desc = add_blob(raw_json(sbom))
        provenance_desc = add_blob(raw_json(provenance))
        attestation_config = add_blob(b"{}")
        attestation_manifest = add_manifest(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {
                    **attestation_config,
                    "mediaType": "application/vnd.oci.empty.v1+json",
                },
                "layers": [
                    {
                        **sbom_desc,
                        "mediaType": "application/vnd.in-toto+json",
                    },
                    {
                        **provenance_desc,
                        "mediaType": "application/vnd.in-toto+json",
                    },
                ],
            }
        )
        attestation_descriptor = {
            **attestation_manifest,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "platform": {"os": "unknown", "architecture": "unknown"},
            "annotations": {
                "vnd.docker.reference.type": "attestation-manifest",
                "vnd.docker.reference.digest": runtime_desc["digest"],
            },
        }
        attestation_descriptors[arch] = attestation_descriptor
        native_value = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [runtime_desc, attestation_descriptor],
        }
        native_desc = add_manifest(native_value)
        native_indexes[arch] = native_desc["digest"]

    final_index = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [
            runtime["amd64"],
            attestation_descriptors["amd64"],
            runtime["arm64"],
            attestation_descriptors["arm64"],
        ],
    }
    final_desc = add_manifest(final_index)
    receipts = {
        arch: receipt(arch, native_indexes[arch]) for arch in ("amd64", "arm64")
    }
    for arch in ("amd64", "arm64"):
        receipts[arch]["manifestDigest"] = runtime[arch]["digest"]
        receipts[arch]["configDigest"] = configs[arch]
    return MemoryRegistry({"manifests": manifests, "blobs": blobs}), final_desc, receipts


class RegistryTests(unittest.TestCase):
    def test_allowlisted_canonical_images(self):
        self.assertEqual(
            rr.Registry("khak1s/arr-dashboard").image,
            "docker.io/khak1s/arr-dashboard",
        )
        self.assertEqual(
            rr.Registry("ghcr.io/kha-kis/arr-dashboard").image,
            "ghcr.io/kha-kis/arr-dashboard",
        )
        with self.assertRaises(rr.QualificationError):
            rr.Registry("attacker.example/khak1s/arr-dashboard")

    def test_bearer_realm_and_scope_are_pinned(self):
        registry = rr.Registry("khak1s/arr-dashboard")
        challenges = (
            'Bearer realm="http://auth.docker.io/token",service="registry.docker.io",scope="repository:khak1s/arr-dashboard:pull"',
            'Bearer realm="https://attacker.example/token",service="registry.docker.io",scope="repository:khak1s/arr-dashboard:pull"',
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:elsewhere/repo:pull"',
        )
        for challenge in challenges:
            with self.subTest(challenge=challenge):
                with self.assertRaises(rr.QualificationError):
                    registry._bearer_token(challenge)

    def test_redirect_urls_reject_downgrade_credentials_and_fragment(self):
        for url in (
            "http://cdn.example/blob",
            "https://user:pass@cdn.example/blob",
            "https://cdn.example/blob#fragment",
        ):
            with self.subTest(url=url):
                with self.assertRaises(rr.QualificationError):
                    rr._https_url(url)

    def test_successfully_qualifies_native_and_final_descriptor_sets(self):
        registry, final_index, receipts = build_graph()
        expected = {
            "source": SOURCE,
            "tree": TREE,
            "version": VERSION,
            "buildDate": BUILD_DATE,
        }
        result = registry.qualify_graph(
            final_index["digest"], receipts["amd64"], receipts["arm64"], expected
        )
        self.assertEqual(
            result["amd64Details"]["nativeIndexDigest"],
            receipts["amd64"]["indexDigest"],
        )
        self.assertEqual(
            result["arm64Details"]["nativeIndexDigest"],
            receipts["arm64"]["indexDigest"],
        )
        self.assertEqual(
            result["indexRef"],
            f"fixture@{final_index['digest']}",
        )
        self.assertEqual(
            result["amd64"],
            f"fixture@{receipts['amd64']['manifestDigest']}",
        )

    def test_native_index_cannot_be_substituted_with_combined_index(self):
        registry, final_index, receipts = build_graph()
        receipts["amd64"]["indexDigest"] = final_index["digest"]
        with self.assertRaisesRegex(rr.QualificationError, "unexpected OCI attestation descriptor"):
            registry.qualify_graph(
                final_index["digest"], receipts["amd64"], receipts["arm64"],
                {"source": SOURCE, "tree": TREE, "version": VERSION, "buildDate": BUILD_DATE},
            )

    def test_provenance_must_bind_exact_source_revision(self):
        registry, final_index, receipts = build_graph(bad_provenance=True)
        with self.assertRaisesRegex(rr.QualificationError, "source revision"):
            registry.qualify_graph(
                final_index["digest"], receipts["amd64"], receipts["arm64"],
                {"source": SOURCE, "tree": TREE, "version": VERSION, "buildDate": BUILD_DATE},
            )

    def test_provenance_requires_exact_source_host_and_path(self):
        statement = {
            "predicate": {
                "buildDefinition": {
                    "externalParameters": {
                        "request": {
                            "root": {
                                "request": {
                                    "args": {
                                        "vcs:source": "https://evilgithub.com/Kha-kis/arr-dashboard",
                                        "vcs:revision": SOURCE,
                                        "build-arg:COMMIT_SHA": SOURCE,
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        self.assertFalse(rr.Registry._source_matches(statement, SOURCE))

    def test_config_uses_created_label_and_linux_platform(self):
        config = {
            "os": "linux",
            "architecture": "arm64",
            "created": "wrong",
            "config": {"Labels": {
                "org.opencontainers.image.revision": SOURCE,
                "org.opencontainers.image.version": VERSION,
                "org.opencontainers.image.created": BUILD_DATE,
            }},
        }
        rr.Registry._verify_config(
            config, "arm64",
            {"source": SOURCE, "version": VERSION, "buildDate": BUILD_DATE},
        )
        config["os"] = "windows"
        with self.assertRaises(rr.QualificationError):
            rr.Registry._verify_config(
                config, "arm64",
                {"source": SOURCE, "version": VERSION, "buildDate": BUILD_DATE},
            )

    def test_native_receipt_requires_scan_runtime_and_assets(self):
        expected = {
            "source": SOURCE, "tree": TREE, "version": VERSION, "buildDate": BUILD_DATE
        }
        good = receipt("amd64")
        rr._validate_receipt(good, "amd64", expected)
        bad = receipt("amd64")
        bad["runtime"]["browserCases"] = 14
        with self.assertRaises(rr.QualificationError):
            rr._validate_receipt(bad, "amd64", expected)

    def test_qualification_compares_run_identity_numerically_and_checks_both_repos(self):
        manifest = {
            "version": VERSION, "source": SOURCE, "tree": TREE,
            "buildDate": BUILD_DATE, "runId": "20", "runAttempt": "2",
            "indexDigest": INDEX_PLACEHOLDER,
            "platforms": {"amd64": receipt("amd64"), "arm64": receipt("arm64")},
        }
        with patch.object(rr.Registry, "qualify_graph", return_value={"verified": True}) as check:
            result = rr.verify_qualification(
                manifest, version=VERSION, source=SOURCE, tree=TREE,
                run_id=20, run_attempt=2, index_digest=INDEX_PLACEHOLDER,
            )
        self.assertIn("docker.io/khak1s/arr-dashboard", result)
        self.assertIn("ghcr.io/kha-kis/arr-dashboard", result)
        self.assertEqual(check.call_count, 2)
        with self.assertRaises(rr.QualificationError):
            rr.verify_qualification(
                manifest, version=VERSION, source=SOURCE, tree=TREE,
                run_id=21, run_attempt=2, index_digest=INDEX_PLACEHOLDER,
            )


if __name__ == "__main__":
    unittest.main()
