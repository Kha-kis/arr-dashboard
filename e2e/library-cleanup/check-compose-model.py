#!/usr/bin/env python3
"""Reject unsafe properties in a rendered Library Cleanup Compose model."""

from __future__ import annotations

import argparse
import copy
import ipaddress
import json
from pathlib import Path
import re
import sys
from typing import NoReturn


EXPECTED_SERVICES = {
    "dashboard-baseline",
    "dashboard-postgres",
    "dashboard-sqlite",
    "plex",
    "plex-loopback-proxy",
    "postgres",
    "qbittorrent-a",
    "qbittorrent-b",
    "qui-a",
    "qui-b",
    "radarr-a",
    "radarr-b",
    "sonarr-a",
    "sonarr-b",
    "toxiproxy",
}
EXPECTED_VOLUMES = {
    "dashboard-baseline-config",
    "dashboard-postgres-config",
    "dashboard-sqlite-config",
    "plex-config",
    "postgres-data",
    "qbittorrent-a-config",
    "qbittorrent-b-config",
    "qui-a-config",
    "qui-b-config",
    "radarr-a-config",
    "radarr-b-config",
    "shared-media",
    "sonarr-a-config",
    "sonarr-b-config",
}
EXPECTED_NETWORKS = {"cleanup-internal", "metadata-egress"}
ALLOWED_QUI_IMAGES = {"ghcr.io/autobrr/qui:v1.16.1"}
EXPECTED_INTEGRATION_IMAGE_REPOSITORIES = {
    "radarr-a": "lscr.io/linuxserver/radarr",
    "radarr-b": "lscr.io/linuxserver/radarr",
    "sonarr-a": "lscr.io/linuxserver/sonarr",
    "sonarr-b": "lscr.io/linuxserver/sonarr",
    "plex": "lscr.io/linuxserver/plex",
    "qbittorrent-a": "lscr.io/linuxserver/qbittorrent",
    "qbittorrent-b": "lscr.io/linuxserver/qbittorrent",
}
QUI_READINESS_TEST = [
    "CMD",
    "wget",
    "--no-verbose",
    "--tries=1",
    "--spider",
    "http://127.0.0.1:7476/healthz/readiness",
]
RFC1918_NETWORKS = tuple(
    ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
GENERIC_LIVE_PROJECTS = {
    "lc-e2e-default",
    "lc-e2e-demo",
    "lc-e2e-dev",
    "lc-e2e-local",
    "lc-e2e-shared",
    "lc-e2e-test",
}
GENERIC_LIVE_PARTS = {"default", "demo", "dev", "local", "shared", "test"}
SUSPICIOUS_LIVE_PREFIXES = ("main", "prod", "stable")
RUN_PROJECT_LABEL = "io.arr-dashboard.library-cleanup.project"
RUN_TOKEN_LABEL = "io.arr-dashboard.library-cleanup.run-token"


class SafetyError(ValueError):
    """The rendered harness model violates a fail-closed safety rule."""


def fail(message: str) -> NoReturn:
    raise SafetyError(message)


def validate_project_name(project: str, *, require_live_name: bool) -> None:
    if not re.fullmatch(r"lc-e2e-[a-z0-9][a-z0-9-]{0,31}", project):
        fail("COMPOSE_PROJECT_NAME must match lc-e2e-[a-z0-9-] and be at most 39 characters")
    if not require_live_name:
        return
    if project in GENERIC_LIVE_PROJECTS:
        fail("live and destructive commands require a unique per-run project name")
    suffix_parts = project.removeprefix("lc-e2e-").split("-")
    if any(part in GENERIC_LIVE_PARTS for part in suffix_parts):
        fail("live project name contains a stale generic identifier")
    if any(part.startswith(prefix) for part in suffix_parts for prefix in SUSPICIOUS_LIVE_PREFIXES):
        fail("live project name contains a production-like or branch-like identifier")
    if not any(character.isdigit() for character in project) or len(project) < 16:
        fail("live project name must include a run-specific numeric discriminator")


def validate_run_labels(labels: object, project: str, expected_token: str | None = None) -> str:
    if not isinstance(labels, dict):
        fail("harness resource is missing run-ownership labels")
    if labels.get(RUN_PROJECT_LABEL) != project:
        fail("harness resource has a mismatched run project label")
    token = labels.get(RUN_TOKEN_LABEL)
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
        fail("LC_E2E_RUN_TOKEN must be a random 64-character lowercase hex token")
    if expected_token is not None and token != expected_token:
        fail("harness resources do not share one run-ownership token")
    return token


def validate_postgres_password_value(value: bytes) -> None:
    if value.endswith(b"\r\n"):
        value = value[:-2]
    elif value.endswith(b"\n"):
        value = value[:-1]
    if not value:
        fail("PostgreSQL password file is empty")
    if len(value) > 256:
        fail("PostgreSQL password exceeds 256 bytes")
    if not re.fullmatch(rb"[A-Za-z0-9._~-]+", value):
        fail("PostgreSQL password must contain only URL-safe unreserved ASCII characters")


def validate_postgres_password_file(path_value: str) -> None:
    path = Path(path_value)
    if not path.is_file():
        fail("PostgreSQL password file does not exist or is not a regular file")
    try:
        value = path.read_bytes()
    except OSError as error:
        fail(f"PostgreSQL password file cannot be read: {error.strerror or 'unknown error'}")
    validate_postgres_password_value(value)


def validate_subnet(value: str) -> str:
    try:
        subnet = ipaddress.ip_network(value, strict=True)
    except ValueError as error:
        fail(f"invalid internal subnet: {error}")
    if subnet.version != 4:
        fail("the internal subnet must be IPv4")
    if subnet.prefixlen < 24:
        fail("the internal subnet must be a /24 or narrower")
    if not any(subnet.subnet_of(private_network) for private_network in RFC1918_NETWORKS):
        fail("the internal subnet must be wholly contained in explicit RFC1918 space")
    return str(subnet)


def validate_model(
    model: dict[str, object],
    *,
    require_live_name: bool = False,
    expected_project: str | None = None,
) -> None:
    project = model.get("name", "")
    if not isinstance(project, str):
        fail("rendered Compose project name is missing")
    validate_project_name(project, require_live_name=require_live_name)
    if expected_project is not None and project != expected_project:
        fail("rendered Compose project does not match the explicitly confirmed project")

    services_value = model.get("services", {})
    if not isinstance(services_value, dict):
        fail("rendered Compose services are missing")
    services = services_value
    if set(services) != EXPECTED_SERVICES:
        fail("rendered service set does not exactly match the Library Cleanup harness")
    run_token = validate_run_labels(services["radarr-a"].get("labels"), project)

    for service_name, expected_repository in EXPECTED_INTEGRATION_IMAGE_REPOSITORIES.items():
        image = services[service_name].get("image")
        if not isinstance(image, str) or not re.fullmatch(
            rf"{re.escape(expected_repository)}:[A-Za-z0-9._-]+@sha256:[a-f0-9]{{64}}", image
        ):
            fail(f"{service_name} image must be an immutable digest from its expected repository")
    for left, right in (("radarr-a", "radarr-b"), ("sonarr-a", "sonarr-b"), ("qbittorrent-a", "qbittorrent-b")):
        if services[left].get("image") != services[right].get("image"):
            fail(f"{left} and {right} must use the same integration image")

    for service_name, service_value in services.items():
        if not isinstance(service_value, dict):
            fail(f"{service_name} has an invalid rendered definition")
        service = service_value
        validate_run_labels(service.get("labels"), project, run_token)
        if "container_name" in service:
            fail(f"{service_name} sets container_name")
        for mount in service.get("volumes", []):
            if mount.get("type") != "volume":
                fail(f"{service_name} uses a non-named-volume mount")
        for port in service.get("ports", []):
            if port.get("host_ip") != "127.0.0.1":
                fail(f"{service_name} publishes a non-loopback port")

    volumes_value = model.get("volumes", {})
    if not isinstance(volumes_value, dict):
        fail("rendered Compose volumes are missing")
    for volume in volumes_value.values():
        validate_run_labels(
            volume.get("labels") if isinstance(volume, dict) else None, project, run_token
        )
    if set(volumes_value) != EXPECTED_VOLUMES:
        fail("rendered volume set does not exactly match the Library Cleanup harness")
    for volume_name, volume in volumes_value.items():
        if volume.get("external"):
            fail(f"volume {volume_name} is external")
        expected_name = f"{project}_{volume_name}"
        if volume.get("name") != expected_name:
            fail(f"volume {volume_name} physical name must be project-scoped")

    networks_value = model.get("networks", {})
    if not isinstance(networks_value, dict):
        fail("rendered Compose networks are missing")
    if set(networks_value) != EXPECTED_NETWORKS:
        fail("rendered network set does not exactly match the Library Cleanup harness")
    for network_name, network in networks_value.items():
        validate_run_labels(
            network.get("labels") if isinstance(network, dict) else None, project, run_token
        )
        if network.get("external"):
            fail(f"network {network_name} is external")
        expected_name = f"{project}_{network_name}"
        if network.get("name") != expected_name:
            fail(f"network {network_name} physical name must be project-scoped")

    internal_networks = [
        (name, network) for name, network in networks_value.items() if network.get("internal")
    ]
    if len(internal_networks) != 1:
        fail("exactly one internal network is required")
    internal_name, internal_network = internal_networks[0]
    subnets = [
        entry.get("subnet") for entry in internal_network.get("ipam", {}).get("config", [])
    ]
    if len(subnets) != 1 or not isinstance(subnets[0], str):
        fail("the internal network must have one explicit subnet")
    expected_subnet = validate_subnet(subnets[0])

    for pair in ("a", "b"):
        qbit = services[f"qbittorrent-{pair}"]
        qui = services[f"qui-{pair}"]
        for service_name, service in ((f"qbittorrent-{pair}", qbit), (f"qui-{pair}", qui)):
            networks = set(service.get("networks", {}))
            if networks != {internal_name}:
                fail(f"{service_name} must be attached only to the isolated network")
        qbit_media = {
            (mount.get("source"), mount.get("target"))
            for mount in qbit.get("volumes", [])
            if mount.get("target") == "/data"
        }
        qui_media = {
            (mount.get("source"), mount.get("target"))
            for mount in qui.get("volumes", [])
            if mount.get("target") == "/data"
        }
        if qbit_media != qui_media or len(qbit_media) != 1:
            fail(f"qBittorrent {pair} and qUI {pair} must share the exact /data mount")
        environment = qui.get("environment", {})
        if environment.get("QUI__AUTH_DISABLED") != "true":
            fail(f"qUI {pair} must explicitly opt into isolated auth-disabled mode")
        if environment.get("QUI__I_ACKNOWLEDGE_THIS_IS_A_BAD_IDEA") != "true":
            fail(f"qUI {pair} is missing the required auth-disabled acknowledgement")
        if environment.get("QUI__AUTH_DISABLED_ALLOWED_CIDRS") != expected_subnet:
            fail(f"qUI {pair} allowlist must exactly match the isolated subnet")
        if qui.get("image") not in ALLOWED_QUI_IMAGES:
            fail(f"qUI {pair} image is not in the reviewed image allowlist")
        if qui.get("healthcheck", {}).get("test") != QUI_READINESS_TEST:
            fail(f"qUI {pair} must use the reviewed readiness healthcheck")

    plex_proxy = services["plex-loopback-proxy"]
    if plex_proxy.get("image") != services["dashboard-sqlite"].get("image"):
        fail("Plex loopback proxy must reuse the exact candidate dashboard image")
    if plex_proxy.get("network_mode") != "service:plex":
        fail("Plex loopback proxy must share only the disposable Plex network namespace")
    if plex_proxy.get("volumes") or plex_proxy.get("ports"):
        fail("Plex loopback proxy must not mount data or publish ports")

    for dashboard_name in ("dashboard-sqlite", "dashboard-postgres", "dashboard-baseline"):
        proxy_dependency = services[dashboard_name].get("depends_on", {}).get(
            "plex-loopback-proxy", {}
        )
        if proxy_dependency.get("condition") != "service_healthy":
            fail(f"{dashboard_name} must wait for the Plex loopback proxy")

    shared_targets = {
        "radarr-a": "/radarr-a/data",
        "radarr-b": "/radarr-b/data",
        "sonarr-a": "/sonarr-a/data",
        "sonarr-b": "/sonarr-b/data",
        "plex": "/plex/data",
    }
    shared_sources: set[str] = set()
    for service_name, target in shared_targets.items():
        matches = [
            mount
            for mount in services[service_name].get("volumes", [])
            if mount.get("target") == target
        ]
        if len(matches) != 1:
            fail(f"{service_name} must mount shared media at {target}")
        shared_sources.add(matches[0].get("source", ""))
    if len(shared_sources) != 1:
        fail("ARR and Plex services must use one shared named media volume")

    shared_source = next(iter(shared_sources))
    dashboard_media_targets = {
        "/data",
        "/plex/data",
        "/radarr-a/data",
        "/radarr-b/data",
        "/sonarr-a/data",
        "/sonarr-b/data",
    }
    for service_name in ("dashboard-baseline", "dashboard-postgres", "dashboard-sqlite"):
        dashboard_mounts = [
            mount
            for mount in services[service_name].get("volumes", [])
            if mount.get("target") in dashboard_media_targets
        ]
        if {mount.get("target") for mount in dashboard_mounts} != dashboard_media_targets:
            fail(f"{service_name} must expose every ARR, Plex, and qBittorrent path")
        if any(mount.get("source") != shared_source for mount in dashboard_mounts):
            fail(f"{service_name} media views must use the shared media volume")
        if any(mount.get("read_only") is not True for mount in dashboard_mounts):
            fail(f"{service_name} media views must be read-only")

    repo_root = str(Path(__file__).resolve().parents[2])
    for service_name, profile in (
        ("dashboard-sqlite", "candidate-sqlite"),
        ("dashboard-postgres", "candidate-postgres"),
    ):
        service = services[service_name]
        if service.get("profiles") != [profile]:
            fail(f"{service_name} has an unexpected profile contract")
        build = service.get("build", {})
        if build.get("context") != repo_root or build.get("dockerfile") != "Dockerfile":
            fail(f"{service_name} build context must be the repository root Dockerfile")
    if services["dashboard-baseline"].get("profiles") != ["baseline"]:
        fail("dashboard-baseline has an unexpected profile contract")

    secrets = model.get("secrets", {})
    if not isinstance(secrets, dict) or set(secrets) != {"plex_claim", "postgres_password"}:
        fail("rendered secret set does not exactly match the Library Cleanup harness")
    postgres_secret = secrets.get("postgres_password", {})
    password_file = postgres_secret.get("file") if isinstance(postgres_secret, dict) else None
    if not isinstance(password_file, str):
        fail("rendered PostgreSQL password secret file is missing")
    validate_postgres_password_file(password_file)


def expect_rejected(model: dict[str, object], description: str, **kwargs: object) -> None:
    try:
        validate_model(model, **kwargs)
    except SafetyError:
        return
    raise AssertionError(f"negative safety test unexpectedly passed: {description}")


def run_self_tests(model: dict[str, object]) -> None:
    validate_model(model)
    negative_count = 0

    for value in (
        "127.0.0.0/24",
        "169.254.20.0/24",
        "192.0.2.0/24",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/24",
        "240.0.0.0/24",
        "10.0.0.0/16",
    ):
        mutated = copy.deepcopy(model)
        internal = next(network for network in mutated["networks"].values() if network.get("internal"))
        internal["ipam"]["config"][0]["subnet"] = value
        for pair in ("a", "b"):
            mutated["services"][f"qui-{pair}"]["environment"][
                "QUI__AUTH_DISABLED_ALLOWED_CIDRS"
            ] = value
        expect_rejected(mutated, f"unsafe subnet {value}")
        negative_count += 1

    mutated = copy.deepcopy(model)
    mutated["services"]["qui-a"]["image"] = "busybox:latest"
    expect_rejected(mutated, "arbitrary qUI image")
    negative_count += 1

    for service_name in (
        "radarr-a",
        "sonarr-a",
        "plex",
        "qbittorrent-a",
    ):
        mutated = copy.deepcopy(model)
        mutated["services"][service_name]["image"] = "lscr.io/linuxserver/example:latest"
        expect_rejected(mutated, f"mutable integration image for {service_name}")
        negative_count += 1

        mutated = copy.deepcopy(model)
        mutated["services"][service_name]["image"] = "busybox@sha256:" + "0" * 64
        expect_rejected(mutated, f"unexpected integration image for {service_name}")
        negative_count += 1

    immutable_override = copy.deepcopy(model)
    for service_name in ("radarr-a", "radarr-b"):
        immutable_override["services"][service_name]["image"] = (
            "lscr.io/linuxserver/radarr:compat@sha256:" + "1" * 64
        )
    validate_model(immutable_override)

    mutated = copy.deepcopy(model)
    mutated["services"]["qui-a"].pop("healthcheck", None)
    expect_rejected(mutated, "missing qUI readiness healthcheck")
    negative_count += 1

    mutated = copy.deepcopy(model)
    mutated["services"]["dashboard-sqlite"]["depends_on"].pop("plex-loopback-proxy")
    expect_rejected(mutated, "dashboard bypasses the Plex loopback readiness gate")
    negative_count += 1

    mutated = copy.deepcopy(model)
    mutated["services"]["radarr-a"]["volumes"][0]["type"] = "bind"
    expect_rejected(mutated, "runtime bind mount")
    negative_count += 1

    mutated = copy.deepcopy(model)
    mutated["services"]["unexpected"] = {}
    expect_rejected(mutated, "unexpected service")
    negative_count += 1

    for resource_type, resource_name in (
        ("services", "radarr-a"),
        ("volumes", "shared-media"),
        ("networks", "cleanup-internal"),
    ):
        mutated = copy.deepcopy(model)
        current = mutated[resource_type][resource_name]["labels"][RUN_TOKEN_LABEL]
        mutated[resource_type][resource_name]["labels"][RUN_TOKEN_LABEL] = (
            "1" * 64 if current != "1" * 64 else "2" * 64
        )
        expect_rejected(mutated, f"mismatched run token on {resource_type}/{resource_name}")
        negative_count += 1

    mutated = copy.deepcopy(model)
    mutated["volumes"]["shared-media"]["name"] = "unrelated_shared-media"
    expect_rejected(mutated, "explicit unrelated physical volume name")
    negative_count += 1

    mutated = copy.deepcopy(model)
    mutated["networks"]["cleanup-internal"]["name"] = "unrelated_cleanup-network"
    expect_rejected(mutated, "explicit unrelated physical network name")
    negative_count += 1

    for project in (
        "lc-e2e-local",
        "lc-e2e-test",
        "lc-e2e-local-20260803",
        "lc-e2e-prod-20260803",
        "lc-e2e-production123-20260803",
    ):
        mutated = copy.deepcopy(model)
        mutated["name"] = project
        expect_rejected(mutated, f"unsafe live project {project}", require_live_name=True)
        negative_count += 1

    for value in (b"", b"contains space", b"contains:colon", b"contains@at", b"two\nlines"):
        try:
            validate_postgres_password_value(value)
        except SafetyError:
            negative_count += 1
        else:
            raise AssertionError("negative PostgreSQL password test unexpectedly passed")

    for value in (b"safe-password_123.~", b"safe-password_123.~\n"):
        validate_postgres_password_value(value)

    print(f"negative safety tests passed: {negative_count}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-project")
    parser.add_argument("--require-live-name", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    try:
        model = json.load(sys.stdin)
        validate_model(
            model,
            require_live_name=args.require_live_name,
            expected_project=args.expected_project,
        )
        if args.self_test:
            run_self_tests(model)
    except (json.JSONDecodeError, KeyError, TypeError, SafetyError, AssertionError) as error:
        print(f"safety preflight failed: {error}", file=sys.stderr)
        return 1

    print(f"safe Compose model: {model['name']} ({len(model['services'])} services)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
