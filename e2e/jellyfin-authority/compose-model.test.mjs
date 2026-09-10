import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const harnessDir = fileURLToPath(new URL(".", import.meta.url));
const composeFile = fileURLToPath(new URL("./compose.yml", import.meta.url));
const composeExecutable = `${process.env.HOME}/.docker/cli-plugins/docker-compose`;
const project = "jf-authority-model-test";
const runToken = "1".repeat(64);
const candidateImage = "arr-dashboard-jellyfin-authority:model-test";

function renderModel(environment = {}) {
	const result = spawnSync(
		composeExecutable,
		["-p", project, "-f", composeFile, "--profile", "tools", "config", "--format", "json"],
		{
			cwd: harnessDir,
			encoding: "utf8",
			env: {
				...process.env,
				CANDIDATE_DASHBOARD_IMAGE: candidateImage,
				COMPOSE_PROJECT_NAME: project,
				JF_AUTHORITY_RUN_TOKEN: runToken,
				...environment,
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe("Jellyfin authority Compose model", () => {
	it("pins the real Jellyfin version and the supplied immutable dashboard candidate", () => {
		const model = renderModel();

		assert.equal(
			model.services.jellyfin.image,
			"jellyfin/jellyfin@sha256:0b901391a662862eddb5dc55d244d7883cbb6236ef5b9a6ea82abc78a89819f0",
		);
		assert.equal(model.services.dashboard.image, candidateImage);
		assert.equal(model.services["jellyfin-proxy"].image, candidateImage);
		assert.equal(model.services["matrix-runner"].image, candidateImage);
	});

	it("uses the supplied Jellyfin image override for alternate runner architectures", () => {
		const image =
			"jellyfin/jellyfin@sha256:7536c1009c6ea50dadd2b244165efb357504ca0f2670abefbceb1c773cc7e13d";
		const model = renderModel({ JELLYFIN_IMAGE: image });

		assert.equal(model.services.jellyfin.image, image);
	});

	it("labels every mutable Docker object with the project and random run token", () => {
		const model = renderModel();
		const expectedLabels = {
			"io.arr-dashboard.jellyfin-authority.project": project,
			"io.arr-dashboard.jellyfin-authority.run-token": runToken,
		};

		for (const service of Object.values(model.services)) {
			assert.deepEqual(service.labels, expectedLabels);
		}
		for (const volume of Object.values(model.volumes)) {
			assert.deepEqual(volume.labels, expectedLabels);
		}
		for (const network of Object.values(model.networks)) {
			assert.deepEqual(network.labels, expectedLabels);
		}
	});

	it("publishes test entrypoints on loopback and keeps service traffic internal", () => {
		const model = renderModel();

		for (const serviceName of ["dashboard", "jellyfin", "jellyfin-proxy"]) {
			for (const port of model.services[serviceName].ports ?? []) {
				assert.equal(port.host_ip, "127.0.0.1");
			}
		}
		assert.equal(model.networks["authority-internal"].internal, true);
	});

	it("mounts the dashboard database read-only for direct matrix assertions", () => {
		const model = renderModel();
		const mounts = model.services["matrix-runner"].volumes;
		assert.equal(mounts.find((mount) => mount.target === "/dashboard-config").read_only, true);
		assert.equal(model.services["matrix-runner"].profiles[0], "tools");
	});

	it("provides a second endpoint name for same-identity connection rotation", () => {
		const model = renderModel();

		assert.deepEqual(model.services["jellyfin-proxy"].networks["authority-internal"].aliases, [
			"jellyfin-proxy-rotated",
		]);
	});

	it("mounts synthetic media and proxy source read-only", () => {
		const model = renderModel();
		const jellyfinMounts = model.services.jellyfin.volumes;
		const proxyMounts = model.services["jellyfin-proxy"].volumes;

		assert.equal(jellyfinMounts.find((mount) => mount.target === "/media").read_only, true);
		for (const target of ["/fixture/proxy-policy.mjs", "/fixture/proxy-server.mjs"]) {
			assert.equal(proxyMounts.find((mount) => mount.target === target).read_only, true);
		}
	});
});
