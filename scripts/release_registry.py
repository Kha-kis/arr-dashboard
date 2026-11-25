#!/usr/bin/env python3
"""Read-only OCI release graph qualification for arr-dashboard."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DOCKER_REPOSITORY = "khak1s/arr-dashboard"
GHCR_REPOSITORY = "kha-kis/arr-dashboard"
REGISTRIES = (
    "docker.io/" + DOCKER_REPOSITORY,
    "ghcr.io/" + GHCR_REPOSITORY,
)
SOURCE_REPOSITORY = "github.com/kha-kis/arr-dashboard"
HEX = re.compile(r"^[0-9a-f]{64}$")
# Exact published v2.25.0 child manifests for the native upgrade fixture.
SQLITE_STORAGE_BASELINE = {
    "amd64": "sha256:13434469dd43b6622ce9cb408cd83315443bb3ae7176d501fb1f27081b186370",
    "arm64": "sha256:38982ae25af50ec455ccbce05f02d79c755d542f8995cc7aaa3b916a1c1acdb0",
}
SQLITE_STORAGE_CASES = frozenset({
    "freshWritableLayerRefused",
    "legacyWritableLayerPreserved",
    "legacyLogicalRestore",
    "mountedUpgrade",
    "nonRootBindRestart",
})

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
ACCEPT = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)


class QualificationError(ValueError):
    """An artifact or receipt failed release qualification."""


def _sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _object(data: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise QualificationError(f"{label} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise QualificationError(f"{label} must be a JSON object")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        raise QualificationError(f"{label} is not a sha256 digest")
    return value


def _size(value: Any, label: str) -> int:
    if type(value) is not int or value < 0:
        raise QualificationError(f"{label} size is missing or invalid")
    return value


def _verify_bytes(data: bytes, digest: str, size: int, label: str) -> None:
    if _sha(data) != digest:
        raise QualificationError(f"{label} digest mismatch")
    if len(data) != size:
        raise QualificationError(f"{label} size mismatch")


def _headers(response: Any) -> dict[str, str]:
    return {str(key).lower(): str(value) for key, value in response.headers.items()}


def _https_url(url: str) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise QualificationError("unsafe registry URL")
    return parsed


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


class Registry:
    """Allowlisted, read-only OCI client. Redirects never receive registry auth."""

    def __init__(self, repository: str):
        value = repository.removeprefix("https://").removeprefix("docker://").rstrip("/")
        if value.startswith("docker.io/"):
            value = value[len("docker.io/") :]
        if value == DOCKER_REPOSITORY:
            self.host = "registry-1.docker.io"
            self.repository = DOCKER_REPOSITORY
            self.image = "docker.io/" + DOCKER_REPOSITORY
        elif value == "ghcr.io/" + GHCR_REPOSITORY:
            self.host = "ghcr.io"
            self.repository = GHCR_REPOSITORY
            self.image = value
        else:
            raise QualificationError("repository is not an approved release repository")
        self._token: str | None = None

    def _send(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        redirects: bool = False,
        auth: bool = True,
    ):
        current = _https_url(url)
        for _ in range(6):
            request_headers = dict(headers)
            if auth and self._token:
                request_headers["Authorization"] = "Bearer " + self._token
            request = urllib.request.Request(
                current.geturl(), headers=request_headers, method=method
            )
            try:
                return _OPENER.open(request, timeout=30)
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    return None
                if exc.code in (301, 302, 303, 307, 308) and redirects:
                    location = exc.headers.get("Location")
                    if not location:
                        raise QualificationError("registry redirect omitted Location")
                    current = _https_url(
                        urllib.parse.urljoin(current.geturl(), location)
                    )
                    auth = False
                    continue
                if exc.code == 401 and auth and not self._token:
                    self._token = self._bearer_token(
                        exc.headers.get("WWW-Authenticate", "")
                    )
                    continue
                raise QualificationError(
                    f"registry request failed with HTTP {exc.code}"
                ) from exc
        raise QualificationError("registry redirect/authentication limit exceeded")

    def _bearer_token(self, challenge: str) -> str:
        match = re.fullmatch(r"Bearer\s+(.+)", challenge.strip(), re.IGNORECASE)
        if not match:
            raise QualificationError("registry omitted a Bearer challenge")
        params = dict(re.findall(r'([A-Za-z]+)="([^"]*)"', match.group(1)))
        realm = params.get("realm", "")
        parsed = _https_url(realm)
        if self.host == "registry-1.docker.io":
            accepted = (
                parsed.hostname == "auth.docker.io"
                and parsed.path == "/token"
                and params.get("service") == "registry.docker.io"
            )
        else:
            accepted = (
                parsed.hostname == "ghcr.io"
                and parsed.path in ("/token", "/token/")
                and params.get("service") in ("ghcr.io", "")
            )
        scope = "repository:" + self.repository + ":pull"
        if not accepted or params.get("scope") != scope:
            raise QualificationError(
                "untrusted Bearer realm, service, or repository scope"
            )
        query = urllib.parse.urlencode(
            {"service": params.get("service", ""), "scope": scope}
        )
        request = urllib.request.Request(realm + "?" + query)
        response = _OPENER.open(request, timeout=30)
        token_doc = _object(response.read(), "registry token response")
        token = token_doc.get("token") or token_doc.get("access_token")
        if not isinstance(token, str) or not token:
            raise QualificationError("registry token response omitted token")
        return token

    def _request(self, method: str, path: str, redirects: bool = False):
        url = f"https://{self.host}/v2/{self.repository}/{path}"
        return self._send(method, url, {"Accept": ACCEPT}, redirects)

    def _manifest(self, digest: str) -> tuple[dict[str, Any], bytes, str]:
        digest = _digest(digest, "manifest reference")
        response = self._request("GET", "manifests/" + digest)
        if response is None:
            raise QualificationError(f"manifest {digest} missing from {self.image}")
        data = response.read()
        actual = _digest(
            _headers(response).get("docker-content-digest", _sha(data)),
            "manifest digest",
        )
        if actual != digest:
            raise QualificationError("registry returned a different manifest digest")
        _verify_bytes(data, actual, len(data), "manifest")
        document = _object(data, "manifest")
        if document.get("schemaVersion") != 2:
            raise QualificationError("artifact manifest schemaVersion must be 2")
        if document.get("mediaType") not in (
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
        ):
            raise QualificationError("artifact manifest mediaType is invalid")
        return document, data, actual

    def tag_digest(self, tag: str) -> str | None:
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", tag):
            raise QualificationError("invalid image tag")
        response = self._request("HEAD", "manifests/" + tag)
        if response is None:
            return None
        return _digest(
            _headers(response).get("docker-content-digest"), "tag manifest digest"
        )

    def blob(self, digest: str, size: int, label: str) -> bytes:
        digest = _digest(digest, label + " digest")
        size = _size(size, label)
        response = self._request("GET", "blobs/" + digest, redirects=True)
        if response is None:
            raise QualificationError(f"{label} missing from {self.image}")
        data = response.read()
        _verify_bytes(data, digest, size, label)
        return data

    def blob_head(self, digest: str) -> None:
        digest = _digest(digest, "layer digest")
        if self._request("HEAD", "blobs/" + digest, redirects=True) is None:
            raise QualificationError(f"layer {digest} missing from {self.image}")

    def _index(self, digest: str) -> dict[str, Any]:
        index, _, actual = self._manifest(digest)
        if actual != digest:
            raise QualificationError(f"index digest mismatch in {self.image}")
        if not isinstance(index.get("manifests"), list):
            raise QualificationError("OCI index has no manifests array")
        return index

    @staticmethod
    def _architecture(descriptor: dict[str, Any]) -> str | None:
        platform = descriptor.get("platform")
        if not isinstance(platform, dict):
            raise QualificationError("OCI descriptor omitted platform")
        if platform.get("os") == "linux" and platform.get("architecture") in (
            "amd64",
            "arm64",
        ):
            return platform["architecture"]
        return None

    def _split_index(
        self, index: dict[str, Any], children_expected: dict[str, str]
    ) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
        children: dict[str, dict[str, Any]] = {}
        attestations: dict[str, list[dict[str, Any]]] = {
            "amd64": [],
            "arm64": [],
        }
        seen_digests: set[str] = set()
        for descriptor in index["manifests"]:
            if not isinstance(descriptor, dict):
                raise QualificationError("OCI index descriptor is not an object")
            descriptor_digest = _digest(descriptor.get("digest"), "index descriptor")
            _size(descriptor.get("size"), "index descriptor")
            if descriptor_digest in seen_digests:
                raise QualificationError("OCI index contains a duplicate descriptor")
            seen_digests.add(descriptor_digest)
            arch = self._architecture(descriptor)
            if arch:
                if arch in children:
                    raise QualificationError(f"duplicate Linux {arch} descriptor")
                if descriptor.get("mediaType") not in (
                    "application/vnd.oci.image.manifest.v1+json",
                    "application/vnd.docker.distribution.manifest.v2+json",
                ):
                    raise QualificationError(f"unexpected {arch} descriptor media type")
                children[arch] = descriptor
                continue
            platform = descriptor["platform"]
            if (
                platform.get("os") != "unknown"
                or platform.get("architecture") != "unknown"
            ):
                raise QualificationError("unexpected OCI descriptor platform")
            annotations = descriptor.get("annotations")
            if not isinstance(annotations, dict):
                raise QualificationError("attestation descriptor omitted annotations")
            ref = annotations.get("vnd.docker.reference.digest")
            target = next(
                (arch for arch, digest in children_expected.items() if digest == ref),
                None,
            )
            if (
                target is None
                or descriptor.get("mediaType")
                != "application/vnd.oci.image.manifest.v1+json"
                or annotations.get("vnd.docker.reference.type")
                != "attestation-manifest"
            ):
                raise QualificationError("unexpected OCI attestation descriptor")
            attestations[target].append(descriptor)
        if set(children) != set(children_expected):
            raise QualificationError("index does not contain the expected architecture set")
        for arch, digest in children_expected.items():
            if children[arch].get("digest") != digest:
                raise QualificationError(f"{arch} descriptor differs from receipt")
            if not attestations[arch]:
                raise QualificationError(f"{arch} has no BuildKit attestation")
        return children, attestations

    @staticmethod
    def _descriptor_set(
        child: dict[str, Any], attestations: list[dict[str, Any]]
    ) -> list[str]:
        return sorted(
            json.dumps(item, sort_keys=True, separators=(",", ":"))
            for item in (child, *attestations)
        )

    def _verify_native_index(
        self,
        arch: str,
        native_index_digest: str,
        child_digest: str,
        final_child: dict[str, Any],
        final_attestations: list[dict[str, Any]],
    ) -> None:
        native = self._index(native_index_digest)
        native_children, native_attestations = self._split_index(
            native, {arch: child_digest}
        )
        native_arches = {
            found
            for descriptor in native["manifests"]
            if (found := self._architecture(descriptor)) is not None
        }
        if native_arches != {arch}:
            raise QualificationError(f"{arch} native index contains another platform")
        if self._descriptor_set(
            native_children[arch], native_attestations[arch]
        ) != self._descriptor_set(final_child, final_attestations):
            raise QualificationError(
                f"{arch} native index descriptor set differs from final index subset"
            )

    def qualify_graph(
        self,
        index_digest: str,
        amd64_receipt: dict[str, Any],
        arm64_receipt: dict[str, Any],
        expected: dict[str, Any],
    ) -> dict[str, Any]:
        index_digest = _digest(index_digest, "final index digest")
        receipts = {"amd64": amd64_receipt, "arm64": arm64_receipt}
        child_digests = {
            arch: _digest(receipt.get("manifestDigest"), arch + " manifest")
            for arch, receipt in receipts.items()
        }
        index = self._index(index_digest)
        children, attestations = self._split_index(index, child_digests)
        result: dict[str, Any] = {
            "repository": self.image,
            "indexDigest": index_digest,
            "indexRef": f"{self.image}@{index_digest}",
        }
        for arch in ("amd64", "arm64"):
            child_digest = child_digests[arch]
            native_index_digest = _digest(
                receipts[arch].get("indexDigest"), arch + " native index"
            )
            self._verify_native_index(
                arch,
                native_index_digest,
                child_digest,
                children[arch],
                attestations[arch],
            )
            child, child_raw, actual = self._manifest(child_digest)
            _verify_bytes(
                child_raw, child_digest, children[arch]["size"], arch + " manifest"
            )
            if actual != child_digest:
                raise QualificationError(f"{arch} runtime manifest mismatch")
            config_descriptor = child.get("config")
            if not isinstance(config_descriptor, dict):
                raise QualificationError(f"{arch} image manifest omitted config")
            config_digest = _digest(
                config_descriptor.get("digest"), arch + " config digest"
            )
            config_data = self.blob(
                config_digest, config_descriptor.get("size"), arch + " config"
            )
            config = _object(config_data, arch + " config")
            if config_digest != _digest(
                receipts[arch].get("configDigest"), arch + " receipt config"
            ):
                raise QualificationError(f"{arch} config differs from native receipt")
            self._verify_config(config, arch, expected)
            layers = child.get("layers")
            if not isinstance(layers, list) or not layers:
                raise QualificationError(f"{arch} manifest has no layers")
            for layer in layers:
                if not isinstance(layer, dict):
                    raise QualificationError("runtime layer descriptor is invalid")
                _size(layer.get("size"), arch + " runtime layer")
                self.blob_head(layer.get("digest"))
            statements = []
            for descriptor in attestations[arch]:
                attestation_manifest, raw, _ = self._manifest(descriptor["digest"])
                _verify_bytes(
                    raw,
                    descriptor["digest"],
                    descriptor["size"],
                    arch + " attestation manifest",
                )
                att_config = attestation_manifest.get("config")
                if not isinstance(att_config, dict):
                    raise QualificationError("attestation manifest omitted config")
                att_config_data = self.blob(
                    att_config.get("digest"),
                    att_config.get("size"),
                    arch + " attestation config",
                )
                _object(att_config_data, arch + " attestation config")
                att_layers = attestation_manifest.get("layers")
                if not isinstance(att_layers, list) or not att_layers:
                    raise QualificationError("attestation manifest has no payload")
                for layer in att_layers:
                    if not isinstance(layer, dict):
                        raise QualificationError("attestation layer is invalid")
                    if layer.get("mediaType") != "application/vnd.in-toto+json":
                        raise QualificationError("unexpected attestation payload media type")
                    payload = self.blob(
                        layer.get("digest"),
                        layer.get("size"),
                        arch + " attestation payload",
                    )
                    statements.append(_object(payload, "attestation statement"))
            self._verify_attestations(statements, child_digest, expected)
            result[arch] = f"{self.image}@{child_digest}"
            result[arch + "Details"] = {
                "manifestDigest": child_digest,
                "configDigest": config_digest,
                "nativeIndexDigest": native_index_digest,
                "nativeIndexRef": f"{self.image}@{native_index_digest}",
            }
        return result

    @staticmethod
    def _verify_config(
        config: dict[str, Any], arch: str, expected: dict[str, Any]
    ) -> None:
        if config.get("os") != "linux" or config.get("architecture") != arch:
            raise QualificationError(f"{arch} config platform mismatch")
        labels = (config.get("config") or {}).get("Labels") or {}
        expected_labels = {
            "org.opencontainers.image.revision": expected["source"],
            "org.opencontainers.image.version": expected["version"],
            "org.opencontainers.image.created": expected["buildDate"],
        }
        for key, value in expected_labels.items():
            if not isinstance(labels.get(key), str) or labels[key] != value:
                raise QualificationError(f"{arch} image config label {key} mismatch")

    @staticmethod
    def _subject_matches(statement: dict[str, Any], child_digest: str) -> bool:
        subjects = statement.get("subject")
        if not isinstance(subjects, list):
            return False
        expected = child_digest.removeprefix("sha256:")
        return any(
            isinstance(subject, dict)
            and (subject.get("digest") or {}).get("sha256") == expected
            for subject in subjects
        )

    @staticmethod
    def _source_matches(statement: dict[str, Any], source: str) -> bool:
        predicate = statement.get("predicate")
        if not isinstance(predicate, dict):
            return False
        build_definition = predicate.get("buildDefinition")
        if not isinstance(build_definition, dict):
            return False
        external = build_definition.get("externalParameters")
        if not isinstance(external, dict):
            return False
        request = external.get("request")
        if not isinstance(request, dict):
            return False
        args = request.get("args") or {}
        metadata = (predicate.get("runDetails") or {}).get("metadata") or {}
        vcs = (metadata.get("buildkit_metadata") or {}).get("vcs") or {}
        source_uri = vcs.get("source", "")
        parsed = urllib.parse.urlsplit(source_uri)
        path = parsed.path.rstrip("/").lower().removesuffix(".git")
        repository = (parsed.hostname or "").lower() + path
        # BuildKit can also repeat source fields in its root build request.
        root = request.get("root") or {}
        root_args = (root.get("request") or {}).get("args") or {}
        root_bindings = {
            "vcs:source": source_uri,
            "vcs:revision": source,
            "build-arg:COMMIT_SHA": source,
        }
        return (
            parsed.scheme == "https"
            and repository == SOURCE_REPOSITORY
            and not (parsed.username or parsed.password or parsed.port or parsed.query or parsed.fragment)
            and vcs.get("revision") == source
            and args.get("build-arg:COMMIT_SHA") == source
            and all(root_args.get(key, value) == value for key, value in root_bindings.items())
        )

    @classmethod
    def _verify_attestations(
        cls,
        statements: list[dict[str, Any]],
        child_digest: str,
        expected: dict[str, Any],
    ) -> None:
        found: set[str] = set()
        for statement in statements:
            if statement.get("_type") != "https://in-toto.io/Statement/v1":
                raise QualificationError("attestation is not an in-toto Statement v1")
            predicate_type = str(statement.get("predicateType", "")).lower()
            if not cls._subject_matches(statement, child_digest):
                raise QualificationError("attestation subject differs from child digest")
            if "spdx" in predicate_type or "sbom" in predicate_type:
                found.add("sbom")
            if predicate_type == "https://slsa.dev/provenance/v1":
                if not cls._source_matches(statement, expected["source"]):
                    raise QualificationError(
                        "provenance does not bind the expected GitHub source revision"
                    )
                found.add("provenance")
        if not {"sbom", "provenance"}.issubset(found):
            raise QualificationError("SBOM and source-bound provenance are required")


def _validate_receipt(
    receipt: dict[str, Any], arch: str, expected: dict[str, Any]
) -> None:
    for key in ("source", "tree", "version", "buildDate"):
        if receipt.get(key) != expected[key]:
            raise QualificationError(f"{arch} receipt {key} mismatch")
    if receipt.get("architecture") != arch:
        raise QualificationError(f"{arch} receipt architecture mismatch")
    _digest(receipt.get("indexDigest"), arch + " native index")
    _digest(receipt.get("manifestDigest"), arch + " manifest")
    _digest(receipt.get("configDigest"), arch + " config")
    assets = receipt.get("assets") or {}
    if any(
        not isinstance(assets.get(key), str) or not HEX.fullmatch(assets[key])
        for key in ("web", "sqlite", "postgresql")
    ):
        raise QualificationError(f"{arch} receipt asset hashes are incomplete")
    scan = receipt.get("scan") or {}
    if (
        scan.get("highCritical") != 0
        or scan.get("osPackages") is not True
        or scan.get("nodePackages") is not True
        or not isinstance(scan.get("reportSha256"), str)
        or not HEX.fullmatch(scan["reportSha256"])
    ):
        raise QualificationError(f"{arch} scan receipt is incomplete")
    runtime = receipt.get("runtime") or {}
    if (
        any(runtime.get(key) is not True for key in ("healthy", "cleanStop", "restart"))
        or runtime.get("browserCases") != 15
    ):
        raise QualificationError(f"{arch} runtime receipt is incomplete")
    storage = receipt.get("sqliteStorage")
    if (
        not isinstance(storage, dict)
        or storage.get("baselineManifestDigest") != SQLITE_STORAGE_BASELINE.get(arch)
        or not isinstance(storage.get("cases"), dict)
        or storage["cases"].keys() != SQLITE_STORAGE_CASES
        or any(passed is not True for passed in storage["cases"].values())
    ):
        raise QualificationError(f"{arch} SQLite storage receipt is incomplete")



def verify_qualification(
    manifest: dict[str, Any],
    *,
    version: str,
    source: str,
    tree: str,
    run_id: str | int,
    run_attempt: str | int,
    index_digest: str,
) -> dict[str, Any]:
    """Verify recorded receipts and recheck both immutable registry graphs."""
    expected = {
        "version": version,
        "source": source,
        "tree": tree,
        "buildDate": manifest.get("buildDate"),
    }
    if not isinstance(expected["buildDate"], str) or not expected["buildDate"]:
        raise QualificationError("qualification record omitted buildDate")
    identities = {
        "version": version,
        "source": source,
        "tree": tree,
        "runId": int(run_id),
        "runAttempt": int(run_attempt),
        "indexDigest": index_digest,
    }
    for key, value in identities.items():
        try:
            actual = (
                int(manifest.get(key))
                if key in ("runId", "runAttempt")
                else manifest.get(key)
            )
        except (TypeError, ValueError) as exc:
            raise QualificationError(f"qualification record {key} is invalid") from exc
        if actual != value:
            raise QualificationError(f"qualification record {key} mismatch")
    platforms = manifest.get("platforms") or {}
    results = {}
    for arch in ("amd64", "arm64"):
        receipt = platforms.get(arch)
        if not isinstance(receipt, dict):
            raise QualificationError(f"qualification record omitted {arch} receipt")
        _validate_receipt(receipt, arch, expected)
        results[arch] = receipt
    for repository in REGISTRIES:
        results[repository] = Registry(repository).qualify_graph(
            index_digest, platforms["amd64"], platforms["arm64"], expected
        )
    return results


def _load_object(path: str, label: str) -> dict[str, Any]:
    return _object(Path(path).read_bytes(), label)


def qualify(args: argparse.Namespace) -> dict[str, Any]:
    if int(args.run_id) < 1 or int(args.run_attempt) < 1:
        raise QualificationError("run ID and attempt must be positive integers")
    expected = {
        "version": args.version,
        "source": args.source,
        "tree": args.tree,
        "buildDate": args.build_date,
    }
    index_digest = _digest(args.index, "final index digest")
    receipts = {
        "amd64": _load_object(args.amd64, "AMD64 native receipt"),
        "arm64": _load_object(args.arm64, "ARM64 native receipt"),
    }
    for arch, receipt in receipts.items():
        _validate_receipt(receipt, arch, expected)
    result = {
        "version": args.version,
        "source": args.source,
        "tree": args.tree,
        "buildDate": args.build_date,
        "runId": int(args.run_id),
        "runAttempt": int(args.run_attempt),
        "indexDigest": index_digest,
        "platforms": receipts,
        "registries": {},
    }
    result["expectedAliases"] = {}
    major, minor, _patch = args.version.split(".")
    for repository in REGISTRIES:
        registry = Registry(repository)
        result["registries"][repository] = registry.qualify_graph(
            index_digest, receipts["amd64"], receipts["arm64"], expected
        )
        if registry.tag_digest(args.version) is not None:
            raise QualificationError("stable version tag already exists")
        result["expectedAliases"][repository] = {
            alias: registry.tag_digest(alias) for alias in (f"{major}.{minor}", major, "latest")
        }
    Path(args.output).write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    qualify_parser = subparsers.add_parser("qualify")
    for flag in (
        "version", "source", "tree", "build-date", "run-id", "run-attempt",
        "index", "amd64", "arm64", "output",
    ):
        qualify_parser.add_argument("--" + flag, required=True)
    verify_parser = subparsers.add_parser("verify")
    for flag in (
        "manifest", "version", "source", "tree", "run-id", "run-attempt",
        "index-digest",
    ):
        verify_parser.add_argument("--" + flag, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "qualify":
            result = qualify(args)
        else:
            result = verify_qualification(
                _load_object(args.manifest, "qualification record"),
                version=args.version, source=args.source, tree=args.tree,
                run_id=args.run_id, run_attempt=args.run_attempt,
                index_digest=args.index_digest,
            )
        print(json.dumps(result, sort_keys=True))
        return 0
    except (QualificationError, OSError, ValueError) as exc:
        print(f"release qualification failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
