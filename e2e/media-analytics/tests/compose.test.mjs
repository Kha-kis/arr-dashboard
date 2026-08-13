import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const harnessDir = resolve("e2e/media-analytics");
const composeFile = join(harnessDir, "docker-compose.yml");
const generatorScript = join(harnessDir, "fixtures", "generate-media.sh");
const projectName = "arr-dashboard-media-analytics-e2e";
const mediaRoot = join(harnessDir, ".state", "media");
function run(command, args, options = {}) {
	return spawnSync(command, args, {
		cwd: resolve("."),
		encoding: "utf8",
		env: {
			...process.env,
			...options.env,
		},
	});
}

function hasCompose() {
	const result = run("docker", ["compose", "version"]);
	return result.status === 0;
}

function hasDockerDaemon() {
	const result = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
	return result.status === 0;
}

function hasGeneratorImage() {
	const result = run("docker", ["image", "inspect", "linuxserver/ffmpeg:8.1.2-cli-ls76"]);
	return result.status === 0;
}

function composeConfig(extraEnv = {}) {
	const result = run(
		"docker",
		[
			"compose",
			"--project-name",
			projectName,
			"--file",
			composeFile,
			"--profile",
			"media-generator",
			"config",
			"--format",
			"json",
		],
		{ env: extraEnv },
	);

	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

function requireCompose(t) {
	if (!hasCompose()) {
		t.skip("Docker Compose is unavailable");
		return false;
	}

	return true;
}

test("Compose model isolates every service and uses the required image pins", (t) => {
	if (!requireCompose(t)) return;

	const config = composeConfig({ PLEX_CLAIM: "claim-invocation-only" });

	assert.deepEqual(Object.keys(config.services).sort(), [
		"arr-dashboard",
		"media-generator",
		"plex",
		"tautulli",
		"tracearr",
		"tracearr-db",
		"tracearr-redis",
	]);

	for (const service of Object.values(config.services)) {
		assert.equal("container_name" in service, false);
		for (const port of service.ports ?? []) {
			assert.equal(port.host_ip, "127.0.0.1");
		}
	}

	assert.equal(config.services.plex.image, "plexinc/pms-docker:1.43.3.10861-07dfddaeb");
	assert.equal(config.services.tautulli.image, "tautulli/tautulli:v2.17.2");
	assert.equal(config.services.tracearr.image, "ghcr.io/connorgallopo/tracearr:2.0.1");
	assert.equal(config.services["tracearr-db"].image, "timescale/timescaledb-ha:pg18.4-ts2.29.1");
	assert.equal(config.services["tracearr-redis"].image, "redis:8.2.2-alpine");
	assert.equal(config.services["media-generator"].image, "linuxserver/ffmpeg:8.1.2-cli-ls76");
	assert.equal(config.services.plex.ports[0].published, "32400");
	assert.equal(config.services.tautulli.ports[0].published, "38181");
	assert.equal(config.services.tracearr.ports[0].published, "33000");
	assert.equal(config.services["arr-dashboard"].ports[0].published, "33030");
	assert.equal(config.services["arr-dashboard"].ports[1].published, "33031");
	assert.equal(config.services.plex.environment.PLEX_CLAIM, "claim-invocation-only");
	assert.equal(config.services.plex.environment.ALLOWED_NETWORKS, "172.30.0.0/24");
	assert.ok(config.services.plex.healthcheck);
	assert.ok(config.services.tautulli.healthcheck);
	assert.ok(config.services.tracearr.healthcheck);
	assert.equal(config.services.tracearr.depends_on["tracearr-db"].condition, "service_healthy");
	assert.equal(config.services.tracearr.depends_on["tracearr-redis"].condition, "service_healthy");
	assert.equal(config.services.tracearr.depends_on.plex.condition, "service_healthy");
	assert.equal(config.services.tautulli.depends_on.plex.condition, "service_healthy");
	assert.deepEqual(config.services["media-generator"].profiles, ["media-generator"]);
	assert.equal(config.services["arr-dashboard"].build.dockerfile, "Dockerfile");
});

test("pinned media generator creates a non-empty MP4 beneath the harness state root", { timeout: 180_000 }, (t) => {
	if (!requireCompose(t) || !hasDockerDaemon()) {
		t.skip("Docker daemon is unavailable");
		return;
	}
	if (!hasGeneratorImage()) {
		t.skip("pinned generator container is not available locally");
		return;
	}

	mkdirSync(mediaRoot, { recursive: true });
	const outputDir = mkdtempSync(join(mediaRoot, "compose-test-"));
	const result = run("bash", [generatorScript, outputDir]);
	const outputFile = join(outputDir, "Synthetic Test", "Synthetic Test.mp4");

	try {
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(outputFile), true);
		assert.ok(statSync(outputFile).size > 0);
	} finally {
		rmSync(outputDir, { recursive: true, force: true });
	}
});
