#!/usr/bin/env python3
"""Prove live Docker resources belong to one disposable harness run."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any


PROJECT_LABEL = "com.docker.compose.project"
SERVICE_LABEL = "com.docker.compose.service"
VOLUME_LABEL = "com.docker.compose.volume"
NETWORK_LABEL = "com.docker.compose.network"
CONFIG_HASH_LABEL = "com.docker.compose.config-hash"
CONFIG_FILES_LABEL = "com.docker.compose.project.config_files"
WORKING_DIR_LABEL = "com.docker.compose.project.working_dir"
RUN_PROJECT_LABEL = "io.arr-dashboard.library-cleanup.project"
RUN_TOKEN_LABEL = "io.arr-dashboard.library-cleanup.run-token"


class OwnershipError(ValueError):
	"""A live resource cannot be attributed to this exact harness run."""


def docker_json(docker_bin: str, *args: str) -> Any:
	result = subprocess.run(
		[docker_bin, *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
	)
	return json.loads(result.stdout)


def matching_ids(docker_bin: str, kind: str, project: str) -> set[str]:
	ids: set[str] = set()
	for label in (f"{PROJECT_LABEL}={project}", f"{RUN_PROJECT_LABEL}={project}"):
		command = [docker_bin, kind, "ls"]
		if kind == "container":
			command.append("-a")
		command.extend(["--filter", f"label={label}", "--quiet"])
		result = subprocess.run(
			command,
			check=True,
			stdout=subprocess.PIPE,
			stderr=subprocess.PIPE,
			text=True,
		)
		ids.update(line for line in result.stdout.splitlines() if line)
	return ids


def model_resource_names(model: dict[str, Any], resource_kind: str) -> set[str]:
	resources = model.get(f"{resource_kind}s")
	if not isinstance(resources, dict):
		raise OwnershipError(f"rendered model has no {resource_kind}s")
	physical_names: set[str] = set()
	for logical_name, definition in resources.items():
		if not isinstance(logical_name, str) or not isinstance(definition, dict):
			raise OwnershipError(f"rendered model has an invalid {resource_kind} definition")
		physical_name = definition.get("name")
		if not isinstance(physical_name, str) or not physical_name:
			raise OwnershipError(f"rendered {resource_kind} {logical_name} has no physical name")
		physical_names.add(physical_name)
	return physical_names


def model_container_names(model: dict[str, Any], project: str) -> set[str]:
	services = model.get("services")
	if not isinstance(services, dict):
		raise OwnershipError("rendered model has no services")
	physical_names: set[str] = set()
	for service_name, service in services.items():
		if not isinstance(service_name, str) or not isinstance(service, dict):
			raise OwnershipError("rendered model has an invalid service definition")
		container_name = service.get("container_name")
		if container_name is None:
			physical_names.update(
				{f"{project}-{service_name}-1", f"{project}_{service_name}_1"}
			)
		elif isinstance(container_name, str) and container_name:
			physical_names.add(container_name)
		else:
			raise OwnershipError(f"rendered service {service_name} has an invalid container_name")
	return physical_names


def existing_named_ids(docker_bin: str, kind: str, physical_names: set[str]) -> set[str]:
	if not physical_names:
		return set()
	format_field = "{{.Names}}" if kind == "container" else "{{.Name}}"
	command = [docker_bin, kind, "ls"]
	if kind == "container":
		command.append("-a")
	command.extend(["--format", format_field])
	result = subprocess.run(
		command,
		check=True,
		stdout=subprocess.PIPE,
		stderr=subprocess.PIPE,
		text=True,
	)
	return {name for name in result.stdout.splitlines() if name in physical_names}


def deduplicate_inspections(kind: str, inspections: Any) -> list[dict[str, Any]]:
	if not isinstance(inspections, list):
		raise OwnershipError(f"docker {kind} inspect returned an invalid response")
	unique: dict[str, dict[str, Any]] = {}
	for resource in inspections:
		if not isinstance(resource, dict):
			raise OwnershipError(f"docker {kind} inspect returned an invalid resource")
		identity = resource.get("Id") or resource.get("ID") or resource.get("Name")
		if not isinstance(identity, str) or not identity:
			raise OwnershipError(f"docker {kind} inspect returned a resource without an identity")
		unique.setdefault(identity, resource)
	return list(unique.values())


def inspect_many(docker_bin: str, kind: str, identifiers: set[str]) -> list[dict[str, Any]]:
	if not identifiers:
		return []
	return deduplicate_inspections(
		kind, docker_json(docker_bin, kind, "inspect", *sorted(identifiers))
	)


def labels_of(resource: dict[str, Any]) -> dict[str, str]:
	if "Config" in resource:
		labels = resource.get("Config", {}).get("Labels")
	else:
		labels = resource.get("Labels")
	return labels if isinstance(labels, dict) else {}


def require_owned(labels: dict[str, str], project: str, token: str, description: str) -> None:
	if labels.get(PROJECT_LABEL) != project or labels.get(RUN_PROJECT_LABEL) != project:
		raise OwnershipError(f"{description} has mismatched project ownership")
	if labels.get(RUN_TOKEN_LABEL) != token:
		raise OwnershipError(f"{description} has a different run token")


def model_mounts(service: dict[str, Any]) -> tuple[set[str], set[str]]:
	volume_targets = {
		mount["target"]
		for mount in service.get("volumes", [])
		if isinstance(mount, dict) and mount.get("type") == "volume"
	}
	secret_targets: set[str] = set()
	for secret in service.get("secrets", []):
		if not isinstance(secret, dict) or not isinstance(secret.get("source"), str):
			continue
		target = secret.get("target", secret["source"])
		if isinstance(target, str):
			secret_targets.add(target if target.startswith("/") else f"/run/secrets/{target}")
	return volume_targets, secret_targets


def validate_resources(
	model: dict[str, Any],
	project: str,
	token: str,
	containers: list[dict[str, Any]],
	volumes: list[dict[str, Any]],
	networks: list[dict[str, Any]],
	image_ids: dict[str, str],
	config_hashes: dict[str, str],
	expected_config_files: str,
	expected_working_dir: str,
	*,
	allow_empty: bool,
) -> None:
	if not re.fullmatch(r"[a-f0-9]{64}", token):
		raise OwnershipError("LC_E2E_RUN_TOKEN must be 64 lowercase hex characters")
	if not containers and not volumes and not networks:
		if allow_empty:
			return
		raise OwnershipError("no live resources exist for the confirmed harness run")

	services = model["services"]
	model_volumes = model["volumes"]
	model_networks = model["networks"]
	seen_services: set[str] = set()
	containers_by_service = {
		labels_of(container).get(SERVICE_LABEL): container for container in containers
	}
	for container in containers:
		labels = labels_of(container)
		name = container.get("Name", "unknown container").lstrip("/")
		require_owned(labels, project, token, name)
		service_name = labels.get(SERVICE_LABEL)
		if service_name not in services:
			raise OwnershipError(f"{name} has unexpected Compose service {service_name!r}")
		if service_name in seen_services:
			raise OwnershipError(f"multiple containers claim service {service_name}")
		seen_services.add(service_name)
		if labels.get(CONFIG_FILES_LABEL) != expected_config_files:
			raise OwnershipError(f"{name} was created from different Compose files")
		if labels.get(WORKING_DIR_LABEL) != expected_working_dir:
			raise OwnershipError(f"{name} was created from a different working directory")
		if service_name == "plex-loopback-proxy":
			# Compose v5 hashes this network_mode sidecar differently during `up`
			# than `config --hash`. Verify its effective mutation boundary instead.
			if not re.fullmatch(r"[a-f0-9]{64}", labels.get(CONFIG_HASH_LABEL, "")):
				raise OwnershipError(f"{name} has no valid Compose config hash")
			service = services[service_name]
			if container.get("Config", {}).get("Cmd") != service.get("command"):
				raise OwnershipError(f"{name} command differs from the validated model")
			if container.get("Config", {}).get("Entrypoint") != service.get("entrypoint"):
				raise OwnershipError(f"{name} entrypoint differs from the validated model")
			if container.get("Config", {}).get("Healthcheck", {}).get("Test") != service.get(
				"healthcheck", {}
			).get("test"):
				raise OwnershipError(f"{name} healthcheck differs from the validated model")
			plex_container = containers_by_service.get("plex")
			if not plex_container or container.get("HostConfig", {}).get("NetworkMode") != (
				f"container:{plex_container.get('Id')}"
			):
				raise OwnershipError(f"{name} does not share the verified Plex network namespace")
		elif labels.get(CONFIG_HASH_LABEL) != config_hashes.get(service_name):
			raise OwnershipError(f"{name} config hash differs from the validated model")
		expected_image = services[service_name].get("image")
		if container.get("Config", {}).get("Image") != expected_image:
			raise OwnershipError(f"{name} image reference differs from the validated model")
		if container.get("Image") != image_ids.get(expected_image):
			raise OwnershipError(f"{name} image identity differs from the validated model")

		expected_volumes, expected_secrets = model_mounts(services[service_name])
		actual_volumes: set[str] = set()
		for mount in container.get("Mounts", []):
			mount_type = mount.get("Type")
			target = mount.get("Destination")
			if mount_type == "volume":
				actual_volumes.add(target)
				mount_labels = mount.get("Labels", {})
				require_owned(mount_labels, project, token, f"volume mounted at {target}")
			elif not (
				mount_type == "bind" and target in expected_secrets and mount.get("RW") is False
			):
				raise OwnershipError(f"{name} has unapproved {mount_type} mount at {target}")
		if actual_volumes != expected_volumes:
			raise OwnershipError(f"{name} mounted-volume targets differ from the validated model")

		expected_network_names = {
			model_networks[network_name]["name"]
			for network_name in services[service_name].get("networks", {})
		}
		actual_network_names = set(container.get("NetworkSettings", {}).get("Networks", {}))
		if actual_network_names != expected_network_names:
			raise OwnershipError(f"{name} network attachments differ from the validated model")

	for volume in volumes:
		labels = labels_of(volume)
		name = volume.get("Name", "unknown volume")
		require_owned(labels, project, token, name)
		logical_name = labels.get(VOLUME_LABEL)
		if logical_name not in model_volumes or name != model_volumes[logical_name].get("name"):
			raise OwnershipError(f"{name} is not an expected project-scoped volume")

	for network in networks:
		labels = labels_of(network)
		name = network.get("Name", "unknown network")
		require_owned(labels, project, token, name)
		logical_name = labels.get(NETWORK_LABEL)
		if logical_name not in model_networks or name != model_networks[logical_name].get("name"):
			raise OwnershipError(f"{name} is not an expected project-scoped network")


def run_self_tests() -> None:
	token = "a" * 64
	project = "lc-e2e-690-20260810"
	labels = {
		PROJECT_LABEL: project,
		RUN_PROJECT_LABEL: project,
		RUN_TOKEN_LABEL: token,
		SERVICE_LABEL: "app",
		CONFIG_HASH_LABEL: "hash",
		CONFIG_FILES_LABEL: "/workspace/compose.yml,/workspace/compose.debug.yml",
		WORKING_DIR_LABEL: "/workspace",
	}
	model = {
		"services": {
			"app": {
				"image": "example:test",
				"volumes": [{"type": "volume", "source": "data", "target": "/data"}],
				"networks": {"private": {}},
			}
		},
		"volumes": {"data": {"name": f"{project}_data"}},
		"networks": {"private": {"name": f"{project}_private"}},
	}
	volume_labels = {**labels, VOLUME_LABEL: "data"}
	network_labels = {**labels, NETWORK_LABEL: "private"}
	container = {
		"Id": "container-id",
		"Name": f"/{project}-app-1",
		"Config": {"Labels": labels, "Image": "example:test"},
		"Image": "sha256:image",
		"Mounts": [
			{
				"Type": "volume",
				"Destination": "/data",
				"Labels": volume_labels,
			}
		],
		"NetworkSettings": {"Networks": {f"{project}_private": {}}},
	}
	volume = {"Name": f"{project}_data", "Labels": volume_labels}
	network = {"Name": f"{project}_private", "Labels": network_labels}
	assert deduplicate_inspections("container", [container, json.loads(json.dumps(container))]) == [
		container
	]
	validate_resources(
		model,
		project,
		token,
		[container],
		[volume],
		[network],
		{"example:test": "sha256:image"},
		{"app": "hash"},
		"/workspace/compose.yml,/workspace/compose.debug.yml",
		"/workspace",
		allow_empty=False,
	)
	validate_resources(
		model,
		project,
		token,
		[],
		[],
		[],
		{},
		{},
		"/workspace/compose.yml,/workspace/compose.debug.yml",
		"/workspace",
		allow_empty=True,
	)
	for description, mutation in (
		("foreign token", lambda value: value["Config"]["Labels"].update({RUN_TOKEN_LABEL: "b" * 64})),
		("bind mount", lambda value: value["Mounts"][0].update({"Type": "bind"})),
		("image drift", lambda value: value.update({"Image": "sha256:other"})),
		("config drift", lambda value: value["Config"]["Labels"].update({CONFIG_HASH_LABEL: "other"})),
	):
		candidate = json.loads(json.dumps(container))
		mutation(candidate)
		try:
			validate_resources(
				model,
				project,
				token,
				[candidate],
				[volume],
				[network],
				{"example:test": "sha256:image"},
				{"app": "hash"},
				"/workspace/compose.yml,/workspace/compose.debug.yml",
				"/workspace",
				allow_empty=False,
			)
		except OwnershipError:
			continue
		raise AssertionError(f"live ownership self-test accepted {description}")
	print("live project ownership negative tests passed: 4")


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--model", type=Path)
	parser.add_argument("--hashes", type=Path)
	parser.add_argument("--project")
	parser.add_argument("--run-token")
	parser.add_argument("--config-files")
	parser.add_argument("--working-dir")
	parser.add_argument("--docker-bin")
	parser.add_argument("--allow-empty", action="store_true")
	parser.add_argument("--self-test", action="store_true")
	args = parser.parse_args()
	if args.self_test:
		run_self_tests()
		return 0
	if not all(
		(
			args.model,
			args.hashes,
			args.project,
			args.run_token,
			args.config_files,
			args.working_dir,
			args.docker_bin,
		)
	):
		parser.error(
				"--model, --hashes, --project, --run-token, --config-files, --working-dir, and --docker-bin are required"
		)
	try:
		model = json.loads(args.model.read_text())
		config_hashes = dict(
			line.split(maxsplit=1) for line in args.hashes.read_text().splitlines() if line.strip()
		)
		container_ids = matching_ids(args.docker_bin, "container", args.project)
		volume_ids = matching_ids(args.docker_bin, "volume", args.project)
		network_ids = matching_ids(args.docker_bin, "network", args.project)
		container_ids.update(
			existing_named_ids(args.docker_bin, "container", model_container_names(model, args.project))
		)
		volume_ids.update(
			existing_named_ids(args.docker_bin, "volume", model_resource_names(model, "volume"))
		)
		network_ids.update(
			existing_named_ids(args.docker_bin, "network", model_resource_names(model, "network"))
		)
		containers = inspect_many(args.docker_bin, "container", container_ids)
		volumes = inspect_many(args.docker_bin, "volume", volume_ids)
		networks = inspect_many(args.docker_bin, "network", network_ids)
		image_refs = {
			service.get("image")
			for service in model["services"].values()
			if isinstance(service.get("image"), str)
		}
		image_ids = {
			image: docker_json(args.docker_bin, "image", "inspect", image)[0]["Id"]
			for image in image_refs
			if any(container.get("Config", {}).get("Image") == image for container in containers)
		}
		for container in containers:
			for mount in container.get("Mounts", []):
				if mount.get("Type") == "volume":
					mount["Labels"] = docker_json(args.docker_bin, "volume", "inspect", mount["Name"])[0].get("Labels", {})
		validate_resources(
			model,
			args.project,
			args.run_token,
			containers,
			volumes,
			networks,
			image_ids,
			config_hashes,
			args.config_files,
			args.working_dir,
			allow_empty=args.allow_empty,
		)
	except (OwnershipError, OSError, KeyError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
		print(f"live project ownership check failed: {error}", file=sys.stderr)
		return 1
	print(f"live project ownership verified: {args.project}")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
