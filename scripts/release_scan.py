#!/usr/bin/env python3
"""Bind a Trivy report to an independently verified immutable OCI child image."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import release_registry as rr

REFERENCE = re.compile(r"^ghcr\.io/kha-kis/arr-dashboard@sha256:[0-9a-f]{64}$")


def validate_report(
    report: dict[str, Any],
    *,
    architecture: str,
    image_ref: str,
    manifest_digest: str,
    config_digest: str,
    registry: rr.Registry,
    expected_config: dict[str, Any],
) -> None:
    """Validate OCI ancestry and Trivy identity for one immutable image."""
    if architecture not in ("amd64", "arm64"):
        raise rr.QualificationError("unsupported scan architecture")
    if not REFERENCE.fullmatch(image_ref):
        raise rr.QualificationError("scan image reference is not an immutable GHCR child")
    if image_ref != f"ghcr.io/kha-kis/arr-dashboard@{manifest_digest}":
        raise rr.QualificationError("scan reference does not match the expected manifest")
    rr._digest(manifest_digest, "expected manifest digest")
    rr._digest(config_digest, "expected config digest")

    # Re-fetch by the pinned child digest and verify the raw OCI descriptor graph.
    manifest, raw_manifest, actual_manifest = registry._manifest(manifest_digest)
    if actual_manifest != manifest_digest or rr._sha(raw_manifest) != manifest_digest:
        raise rr.QualificationError("pinned image manifest identity mismatch")
    descriptor = manifest.get("config")
    if not isinstance(descriptor, dict):
        raise rr.QualificationError("pinned image manifest omitted config descriptor")
    actual_config = rr._digest(descriptor.get("digest"), "manifest config digest")
    if actual_config != config_digest:
        raise rr.QualificationError("manifest config differs from expected config")
    raw_config = registry.blob(actual_config, descriptor.get("size"), "image config")
    config = rr._object(raw_config, "image config")
    rr.Registry._verify_config(config, architecture, expected_config)

    # Trivy exposes ImageID as either the child manifest or config digest depending
    # on platform/runtime. Every other report identity field must name that child.
    metadata = report.get("Metadata")
    if not isinstance(metadata, dict):
        raise rr.QualificationError("Trivy Metadata is missing or malformed")
    if metadata.get("ImageID") not in (manifest_digest, config_digest):
        raise rr.QualificationError("Trivy ImageID is unrelated to the pinned image")
    if metadata.get("Reference") != image_ref:
        raise rr.QualificationError("Trivy metadata reference differs from pinned image")
    repo_digests = metadata.get("RepoDigests")
    if not isinstance(repo_digests, list) or image_ref not in repo_digests:
        raise rr.QualificationError("Trivy report does not associate the pinned image digest")
    if any(value != image_ref for value in repo_digests):
        raise rr.QualificationError("Trivy RepoDigests contains a conflicting identity")
    repo_tags = metadata.get("RepoTags")
    if repo_tags is not None:
        if not isinstance(repo_tags, list) or image_ref not in repo_tags:
            raise rr.QualificationError("Trivy report does not associate the pinned image tag reference")
        if any(value != image_ref for value in repo_tags):
            raise rr.QualificationError("Trivy RepoTags contains a conflicting identity")
    if report.get("ArtifactName") != image_ref:
        raise rr.QualificationError("Trivy artifact name differs from pinned image")
    image_config = metadata.get("ImageConfig")
    if (
        not isinstance(image_config, dict)
        or image_config.get("architecture") != architecture
        or image_config.get("os") != "linux"
    ):
        raise rr.QualificationError("Trivy image configuration platform mismatch")
    labels = (image_config.get("config") or {}).get("Labels")
    if not isinstance(labels, dict):
        raise rr.QualificationError("Trivy image configuration labels are missing")
    for key, value in (
        ("org.opencontainers.image.revision", expected_config.get("source")),
        ("org.opencontainers.image.version", expected_config.get("version")),
        ("org.opencontainers.image.created", expected_config.get("buildDate")),
    ):
        if labels.get(key) != value:
            raise rr.QualificationError("Trivy image configuration differs from verified config")
    os_metadata = metadata.get("OS")
    if not isinstance(os_metadata, dict) or not isinstance(os_metadata.get("Family"), str) or not os_metadata.get("Family"):
        raise rr.QualificationError("Trivy operating-system metadata is missing")
    if os_metadata.get("EOSL", False) is not False:
        raise rr.QualificationError("Trivy identifies an end-of-support operating system")

    results = report.get("Results")
    if not isinstance(results, list):
        raise rr.QualificationError("Trivy Results is missing or malformed")
    if not any(isinstance(item, dict) and item.get("Class") == "os-pkgs" for item in results):
        raise rr.QualificationError("Trivy operating-system package coverage is missing")
    if not any(
        isinstance(item, dict)
        and item.get("Class") == "lang-pkgs"
        and item.get("Type") == "node-pkg"
        for item in results
    ):
        raise rr.QualificationError("Trivy Node package coverage is missing")
    for item in results:
        if not isinstance(item, dict):
            raise rr.QualificationError("Trivy result entry is malformed")
        vulnerabilities = item.get("Vulnerabilities", [])
        if vulnerabilities is None:
            continue
        if not isinstance(vulnerabilities, list):
            raise rr.QualificationError("Trivy vulnerability list is malformed")
        if any(
            not isinstance(vulnerability, dict)
            or vulnerability.get("Severity") in ("HIGH", "CRITICAL")
            for vulnerability in vulnerabilities
        ):
            raise rr.QualificationError("Trivy reports HIGH or CRITICAL vulnerabilities")
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--architecture", required=True)
    parser.add_argument("--image-ref", required=True)
    parser.add_argument("--manifest-digest", required=True)
    parser.add_argument("--config-digest", required=True)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        report_bytes = args.report.read_bytes()
        report = rr._object(report_bytes, "Trivy report")
        receipt = rr._object(args.receipt.read_bytes(), "native release receipt")
        if receipt.get("architecture") != args.architecture:
            raise rr.QualificationError("native receipt architecture mismatch")
        if receipt.get("manifestDigest") != args.manifest_digest or receipt.get("configDigest") != args.config_digest:
            raise rr.QualificationError("native receipt image identity mismatch")
        registry = rr.Registry("ghcr.io/kha-kis/arr-dashboard")
        report_hash = validate_report(
            report,
            architecture=args.architecture,
            image_ref=args.image_ref,
            manifest_digest=args.manifest_digest,
            config_digest=args.config_digest,
            registry=registry,
            expected_config={
                "source": receipt.get("source"),
                "version": receipt.get("version"),
                "buildDate": receipt.get("buildDate"),
            },
        )
        # Preserve the hash of the exact raw report file, not a normalized JSON form.
        report_hash = hashlib.sha256(report_bytes).hexdigest()
        receipt["scan"] = {
            "highCritical": 0,
            "osPackages": True,
            "nodePackages": True,
            "reportSha256": report_hash,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
    except (OSError, rr.QualificationError, ValueError, TypeError) as exc:
        print(f"release scan qualification failed: {exc}", file=sys.stderr)
        return 1
    print(f"qualified {args.architecture} Trivy report {report_hash}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
