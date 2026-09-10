import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertOwnedResources, validateFixtureIdentity } from "./live-matrix-lib.mjs";

const project = process.env.COMPOSE_PROJECT_NAME;
const runToken = process.env.JF_AUTHORITY_RUN_TOKEN;
validateFixtureIdentity(project, runToken);

const docker = process.env.DOCKER_BIN ?? "docker";
const compose = process.env.COMPOSE_BIN ?? `${process.env.HOME}/.docker/cli-plugins/docker-compose`;
const composeFile = fileURLToPath(new URL("./compose.yml", import.meta.url));
const composeProjectLabel = "com.docker.compose.project";
const projectLabel = "io.arr-dashboard.jellyfin-authority.project";
const tokenLabel = "io.arr-dashboard.jellyfin-authority.run-token";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	assert.equal(result.status, 0, result.stderr || `${command} failed`);
	return result.stdout.trim();
}

function inventory() {
	const specs = [
		{
			inspect: ["inspect"],
			kind: "container",
			labelRoot: ".Config.Labels",
			list: ["ps", "-a"],
		},
		{
			inspect: ["volume", "inspect"],
			kind: "volume",
			labelRoot: ".Labels",
			list: ["volume", "ls"],
		},
		{
			inspect: ["network", "inspect"],
			kind: "network",
			labelRoot: ".Labels",
			list: ["network", "ls"],
		},
	];
	return specs.flatMap(({ inspect, kind, labelRoot, list }) => {
		const output = run(docker, [
			...list,
			"--filter",
			`label=${composeProjectLabel}=${project}`,
			"--format",
			kind === "volume" ? "{{.Name}}" : "{{.ID}}",
		]);
		return output
			? output.split("\n").map((id) => {
					const format = `{{index ${labelRoot} "${projectLabel}"}}\t{{index ${labelRoot} "${tokenLabel}"}}`;
					const [resourceProject, resourceToken] = run(docker, [
						...inspect,
						"--format",
						format,
						id,
					]).split("\t");
					return { id, kind, project: resourceProject, runToken: resourceToken };
				})
			: [];
	});
}

const before = inventory();
if (before.length === 0 && process.argv.includes("--if-present")) {
	process.stdout.write(`${JSON.stringify({ removed: 0, status: "pass" })}\n`);
	process.exit(0);
}
assert.ok(before.length > 0, "refusing teardown without owned resources");
assertOwnedResources(before, project, runToken);
run(compose, [
	"-p",
	project,
	"-f",
	composeFile,
	"--profile",
	"tools",
	"down",
	"--volumes",
	"--remove-orphans",
]);
assert.deepEqual(inventory(), []);

process.stdout.write(`${JSON.stringify({ removed: before.length, status: "pass" })}\n`);
