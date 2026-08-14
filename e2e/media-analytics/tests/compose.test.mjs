import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const harnessDir = resolve("e2e/media-analytics");
const composeFile = join(harnessDir, "docker-compose.yml");
const generatorScript = join(harnessDir, "fixtures", "generate-media.sh");
const projectName = "arr-dashboard-media-analytics-e2e";
const mediaRoot = join(harnessDir, ".state", "media");
const pinnedImages = {
	plex: "plexinc/pms-docker:1.43.3.10861-07dfddaeb@sha256:5bc1d13f48da6366f46aaf2a3ce1a6292897eadc1f8efcbbd7321d30e94f2ed4",
	tautulli:
		"tautulli/tautulli:v2.17.2@sha256:864245fb24830ef6516b5f383bf4d8ba37939ae2f0574dc0217ca02fba4301ff",
	tracearr:
		"ghcr.io/connorgallopo/tracearr:2.0.1@sha256:3d57d9b032b4a57919c48c919c16c3d6640b83f9116feb2c2cdf907747702ec8",
	"tracearr-db":
		"timescale/timescaledb-ha:pg18.4-ts2.29.1@sha256:14980f339e6339aca3f53e89b442cf55c6328557589f8d3608963fa30e002bc3",
	"tracearr-redis":
		"redis:8.2.2-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933",
	"media-generator":
		"linuxserver/ffmpeg:8.1.2-cli-ls76@sha256:2e7000921be8de2704a4f27dfd3d988562697a346eaabb937a81046c306f0af7",
};
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

	for (const [service, image] of Object.entries(pinnedImages)) {
		assert.equal(config.services[service].image, image);
	}
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

test("the disposable dashboard raises only its E2E API rate limit", (t) => {
	if (!requireCompose(t)) return;

	const config = composeConfig();
	assert.equal(config.services["arr-dashboard"].environment.API_RATE_LIMIT_MAX, "10000");
});

test("dashboard build context excludes harness secrets and pins both Node stages", () => {
	const dockerignore = readFileSync(resolve(".dockerignore"), "utf8");
	const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");

	assert.match(dockerignore, /^e2e\/media-analytics\/\.state\/$/m);
	assert.equal(
		dockerfile.match(
			/^FROM node:22-alpine3\.21@sha256:af8023ec879993821f6d5b21382ed915622a1b0f1cc03dbeb6804afaf01f8885/gm,
		)?.length,
		2,
	);
});

test("pinned media generator creates a non-empty MP4 beneath the harness state root", {
	timeout: 180_000,
}, (t) => {
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
		const outputStats = statSync(outputFile);
		assert.ok(outputStats.size > 0);
		assert.equal(outputStats.uid, process.getuid());
		assert.equal(outputStats.gid, process.getgid());
	} finally {
		rmSync(outputDir, { recursive: true, force: true });
	}
});
