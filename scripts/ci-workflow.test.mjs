// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are intentional literals in this YAML contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const workflow = parse(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"));
const jobs = workflow.jobs;
const required = [
	"quality",
	"database-contracts",
	"api-sqlite",
	"api-postgres",
	"web-tests",
	"shared-tests",
	"contracts-and-heap",
	"postgresql-contract",
	"e2e",
	"docker",
];
const runs = (job) => jobs[job].steps.map((step) => step.run ?? "").join("\n");
const step = (job, name) => {
	const found = jobs[job]?.steps.find((item) => item.name === name);
	assert.ok(found, `${job}: ${name} is covered`);
	return found;
};
const expectedActions = new Set([
	"actions/checkout",
	"pnpm/action-setup",
	"actions/setup-node",
	"actions/cache",
	"actions/upload-artifact",
	"docker/setup-buildx-action",
	"docker/login-action",
	"docker/build-push-action",
]);

test("only main pushes and existing eligible PR bases select qualification", () => {
	assert.deepEqual(workflow.on.push.branches, ["main"]);
	assert.deepEqual(workflow.on.pull_request, { branches: ["main", "release/**", "fix/**"] });
	assert.deepEqual(workflow.on.push["paths-ignore"], [
		"**.md",
		"docs/**",
		".vscode/**",
		"LICENSE",
		".gitignore",
	]);
	assert.deepEqual(workflow.concurrency, {
		group: "ci-${{ github.ref }}",
		"cancel-in-progress": true,
	});
});

test("required check waits for every qualification job in an acyclic graph", () => {
	assert.deepEqual(Object.keys(jobs).sort(), [...required, "lint-and-test"].sort());
	assert.equal(jobs["lint-and-test"].name, "Lint, Type Check & Test");
	assert.equal(jobs["lint-and-test"].if, "always()");
	assert.deepEqual([...jobs["lint-and-test"].needs].sort(), [...required].sort());
	for (const name of required) {
		assert.deepEqual(jobs[name].needs ?? [], name === "quality" ? [] : ["quality"]);
		assert.equal(jobs[name]["continue-on-error"], undefined);
	}
});

test("actual aggregate script succeeds only for the exact complete successful result map", () => {
	const aggregate = step("lint-and-test", "Require every qualification job");
	assert.equal(aggregate.env.NEEDS_JSON, "${{ toJSON(needs) }}");
	const success = Object.fromEntries(required.map((name) => [name, { result: "success" }]));
	const execute = (input) =>
		spawnSync("bash", ["-e", "-o", "pipefail", "-c", aggregate.run], {
			env: {
				PATH: process.env.PATH,
				NEEDS_JSON: typeof input === "string" ? input : JSON.stringify(input),
			},
			encoding: "utf8",
		});
	assert.equal(execute(success).status, 0);
	for (const name of required) {
		for (const result of ["failure", "cancelled", "skipped", "", "unknown", null]) {
			assert.equal(execute({ ...success, [name]: { result } }).status, 1, `${name}: ${result}`);
		}
		const missing = { ...success };
		delete missing[name];
		assert.equal(execute(missing).status, 1, `missing ${name}`);
		assert.equal(execute({ ...success, [name]: {} }).status, 1, `no result ${name}`);
	}
	for (const invalid of [
		{},
		[],
		null,
		"",
		"not-json",
		{ ...success, extra: { result: "success" } },
	]) {
		assert.equal(execute(invalid).status, 1);
	}
});

test("SQLite shards own only SQLite and native PostgreSQL runs once", () => {
	assert.deepEqual(jobs["api-sqlite"].strategy, {
		"fail-fast": false,
		matrix: { shardIndex: [1, 2, 3, 4], shardTotal: [4] },
	});
	const sqlite = step("api-sqlite", "Run API SQLite shard");
	assert.equal(
		sqlite.run,
		"pnpm --filter @arr/api run test:sqlite --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}",
	);
	assert.deepEqual(sqlite.env, { ARR_API_TEST_WORKERS: "2" });
	assert.equal(
		step("api-postgres", "Run native PostgreSQL phases").run,
		"pnpm --filter @arr/api run test:postgres",
	);
	assert.equal(jobs["api-postgres"].strategy, undefined);
	for (const job of required) {
		assert.doesNotMatch(
			runs(job),
			/pnpm (?:run )?test(?:\s|$)/m,
			`no duplicate full suite in ${job}`,
		);
		assert.equal(jobs[job].env?.DATABASE_URL, undefined);
	}
});

test("quality and partition jobs retain every baseline test family", () => {
	for (const name of [
		"check:prisma-generated",
		"test:pr-review-contract",
		"test:ci-workflow",
		"format",
		"lint",
		"typecheck",
	]) {
		assert.ok(runs("quality").includes(`pnpm run ${name}`), name);
	}
	assert.ok(runs("quality").includes("node --test scripts/check-prisma-generated.test.mjs"));
	assert.equal(
		step("quality", "Audit dependencies for vulnerabilities")["continue-on-error"],
		true,
	);
	assert.ok(runs("quality").includes("pnpm exec knip --no-exit-code"));
	assert.equal(
		step("web-tests", "Run web tests").run,
		"pnpm exec turbo run test --filter=@arr/web",
	);
	assert.equal(
		step("shared-tests", "Run shared tests").run,
		"pnpm exec turbo run test --filter=@arr/shared",
	);
	for (const command of [
		"pnpm --filter @arr/shared run build",
		"pnpm --filter @arr/api run test:node",
		"pnpm run test:dependency-patches",
		"pnpm run test:jellyfin-authority-contract",
		"pnpm run test:e2e-ui-contract",
		"pnpm --filter @arr/api run test:provider-cache-heap",
	])
		assert.ok(runs("contracts-and-heap").includes(command), command);
	const api = JSON.parse(readFileSync(new URL("apps/api/package.json", root), "utf8"));
	assert.equal(
		api.scripts.test,
		"pnpm --filter @arr/shared build && pnpm run test:node && node scripts/run-api-tests.mjs",
	);
	for (const file of [
		"scripts/native-test-actors.test.mjs",
		"scripts/native-postgres-test-fixture.test.mjs",
		"../../docker/test-admin-recovery.test.cjs",
		"scripts/api-test-phases.test.mjs",
	]) {
		assert.ok(api.scripts["test:node"].includes(file), file);
	}
	assert.equal(
		api.scripts["test:sqlite"],
		"pnpm --filter @arr/shared build && node scripts/run-api-tests.mjs --phase=sqlite",
	);
	assert.equal(
		api.scripts["test:postgres"],
		"pnpm --filter @arr/shared build && node scripts/run-api-tests.mjs --phase=postgres",
	);
	const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
	assert.ok(manifest.scripts.test.endsWith(" && pnpm run test:ci-workflow"));
});

test("explicit SQLite and PostgreSQL persistence contracts keep their native inputs", () => {
	assert.match(
		jobs["database-contracts"].services.postgres.image,
		/^postgres@sha256:[a-f0-9]{64}$/,
	);
	assert.deepEqual(jobs["database-contracts"].services.postgres.env, {
		POSTGRES_USER: "arr_backup_test",
		POSTGRES_PASSWORD: "arr_backup_test",
		POSTGRES_DB: "arr_backup_test",
	});
	const contracts = [
		[
			"Run deployment-state persistence contract",
			"src/lib/trash-guides/__tests__/deployment-state-persistence.test.ts",
			{ TEST_DB: "true" },
		],
		[
			"Run override-route persistence contract (SQLite)",
			"src/routes/trash-guides/__tests__/instance-quality-profile-routes.database.test.ts",
			{ INTEGRATION_TESTS: "1", OVERRIDE_ROUTE_DATABASE_URL: "file:./prisma/test-integration.db" },
		],
		[
			"Run backup round-trip contract on SQLite",
			"src/lib/backup/__tests__/backup-roundtrip.test.ts",
			{ TEST_DB: "true" },
		],
		[
			"Run backup round-trip contract on PostgreSQL",
			"src/lib/backup/__tests__/backup-roundtrip.test.ts",
			{
				TEST_DB: "true",
				TEST_DATABASE_URL:
					"postgresql://arr_backup_test:arr_backup_test@127.0.0.1:5432/arr_backup_test",
			},
		],
	];
	for (const [name, file, env] of contracts) {
		assert.deepEqual(step("database-contracts", name), {
			name,
			run: `pnpm exec vitest run ${file}`,
			"working-directory": "apps/api",
			env,
		});
	}
	assert.match(
		jobs["postgresql-contract"].services.postgres.image,
		/^postgres@sha256:[a-f0-9]{64}$/,
	);
	assert.equal(
		step("postgresql-contract", "Run override-route persistence contract (PostgreSQL)").env
			.OVERRIDE_ROUTE_DATABASE_URL,
		"postgresql://arr_contract:arr_contract_test@127.0.0.1:5432/arr_contract_test",
	);
	assert.deepEqual(jobs.e2e.strategy, {
		"fail-fast": false,
		matrix: { shardIndex: [1, 2, 3], shardTotal: [3] },
	});
	assert.ok(
		runs("e2e").includes(
			"pnpm exec playwright test --project=chromium --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}",
		),
	);
	assert.equal(
		step("docker", "Validate runtime file layout").run,
		"docker run --rm --entrypoint sh arr-dashboard:ci-test /app/api/validate-runtime.sh",
	);
});

test("actions stay immutable under expected owners and registry writes require trusted pushes", () => {
	const seen = new Set();
	for (const job of Object.values(jobs))
		for (const item of job.steps) {
			if (!item.uses) continue;
			assert.match(item.uses, /^[^@]+@[a-f0-9]{40}$/);
			const [action] = item.uses.split("@");
			assert.ok(expectedActions.has(action), `Expected action owner/repository: ${action}`);
			seen.add(action);
		}
	assert.deepEqual([...seen].sort(), [...expectedActions].sort());
	const login = step("docker", "Log in to Docker Hub (for cache)");
	assert.equal(login.if, "github.event_name == 'push' && github.actor != 'dependabot[bot]'");
	assert.deepEqual(login.with, {
		username: "${{ secrets.DOCKERHUB_USERNAME }}",
		password: "${{ secrets.DOCKERHUB_TOKEN }}",
	});
	const build = step("docker", "Build Docker image (amd64 only, warms cache for docker-dev)");
	assert.equal(
		build.with["cache-to"],
		"${{ github.event_name == 'push' && github.actor != 'dependabot[bot]' && format('type=registry,ref={0}:buildcache-linux-amd64,mode=max', env.DOCKERHUB_IMAGE) || '' }}",
	);
	assert.equal(build.with.push, false);
});

test("release staging has only a manual trigger and no stable alias operation", () => {
	const stage = parse(readFileSync(new URL(".github/workflows/docker-combined.yml", root), "utf8"));
	assert.deepEqual(Object.keys(stage.on), ["workflow_dispatch"]);
	assert.ok(stage.jobs.qualify, "a terminal qualification job must exist");
	assert.deepEqual(stage.jobs.qualify.needs, ["assemble", "verify"]);
	assert.notEqual(stage.jobs.qualify.if, "always()");
	assert.ok(stage.jobs.verify.needs.includes("build"));
	assert.ok(stage.jobs.assemble.needs.includes("verify"));
	assert.equal(stage.jobs.verify.permissions.packages, undefined);
	assert.equal(stage.jobs.qualify.permissions.packages, undefined);
	const scanner = stage.jobs.verify.steps.find((step) =>
		step.uses?.startsWith("aquasecurity/trivy-action@"),
	);
	assert.equal(String(scanner.with["exit-code"]), "1");
	assert.match(scanner.with["image-ref"], /steps[.].*[.]outputs[.]/);
	const assembly = stage.jobs.assemble.steps.flatMap((step) => step.run?.split("\n") ?? []);
	const create = assembly.filter((line) => line.includes("imagetools create"));
	assert.equal(create.length, 2);
	assert.ok(create.every((line) => line.includes("--prefer-index=false")));
	assert.ok(stage.jobs.verify.steps.some((step) =>
		step.if === "always()" && step.with?.name?.startsWith("release-candidate-evidence-"),
	));
	assert.ok(!JSON.stringify(stage).includes("type=raw,value=latest"));
});

test("stable promotion is an approved, serialized dispatch with no build", () => {
	const promote = parse(
		readFileSync(new URL(".github/workflows/docker-promote.yml", root), "utf8"),
	);
	assert.deepEqual(Object.keys(promote.on), ["workflow_dispatch"]);
	assert.equal(promote.concurrency["cancel-in-progress"], false);
	assert.equal(promote.jobs.promote.environment.name, "stable-release");
	assert.ok(promote.jobs.promote.needs.includes("preflight"));
	assert.equal(promote.jobs.preflight.permissions.packages, undefined);
	const commands = promote.jobs.promote.steps.map((step) => step.run).filter(Boolean);
	assert.deepEqual(commands, [
		"python3 -B scripts/release_promotion.py authorize",
		"python3 -B scripts/release_promotion.py promote",
	]);
	assert.match(JSON.stringify(promote.jobs.promote.steps), /STABLE_DOCKERHUB_TOKEN/);
	assert.ok(!JSON.stringify(promote).includes("docker/build-push-action"));
});

test("release promotion and registry guards fail closed in offline fixtures", () => {
	const command = spawnSync(
		"python3",
		["-B", "-m", "unittest", "discover", "-s", "scripts", "-p", "test_release_*.py"],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(command.status, 0, command.error?.message ?? command.stdout + command.stderr);
});
