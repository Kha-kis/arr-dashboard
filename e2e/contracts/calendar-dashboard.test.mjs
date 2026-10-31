import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const candidate = fileURLToPath(new URL("../../", import.meta.url));
const specRoot = path.join(candidate, "e2e");
const candidateRequire = createRequire(path.join(candidate, "package.json"));
const ts = candidateRequire("typescript");

function parse(file) {
	return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function execute(source, context = {}, filename = "extracted-contract.ts") {
	const result = ts.transpileModule(source, {
		fileName: filename,
		reportDiagnostics: true,
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	});
	assert.equal(result.diagnostics?.length ?? 0, 0, "extracted TypeScript must transpile");
	return vm.runInNewContext(result.outputText, context, { filename, timeout: 1_000 });
}

// Compile the frozen real shared sources in memory; do not replace their schema
// with a copied definition or depend on possibly stale generated dist files.
const sharedCache = new Map();
function loadShared(file) {
	if (sharedCache.has(file)) return sharedCache.get(file);
	const exports = {};
	sharedCache.set(file, exports);
	execute(
		readFileSync(file, "utf8"),
		{
			exports,
			require(specifier) {
				if (specifier === "zod") {
					return createRequire(path.join(candidate, "packages/shared/package.json"))(specifier);
				}
				assert.ok(specifier.startsWith("./"), "only shared local schema imports are permitted");
				return loadShared(path.resolve(path.dirname(file), `${specifier.replace(/\.js$/, "")}.ts`));
			},
		},
		file,
	);
	return exports;
}

const schema = loadShared(
	path.join(candidate, "packages/shared/src/types/dashboard.ts"),
).multiInstanceCalendarResponseSchema;
const helperSource = parse(path.join(specRoot, "dashboard-attention.spec.ts"));
const helperNode = helperSource.statements.find(
	(node) => ts.isFunctionDeclaration(node) && node.name?.text === "hasSeerrWidget",
);
assert.ok(helperNode, "the real Seerr precondition must exist");
const hasSeerrWidget = execute(`${helperNode.getText(helperSource)}\nhasSeerrWidget;`, {
	TIMEOUTS: { short: 10_000, medium: 20_000 },
});

function seerrPage({
	body = { services: [] },
	ok = true,
	hidden = false,
	requestError,
	jsonError,
} = {}) {
	const calls = [];
	const hiddenError = new Error("configured widget is hidden");
	return {
		calls,
		hiddenError,
		page: {
			request: {
				async get(url, options) {
					assert.equal(url, "/api/services");
					assert.ok(options.timeout > 0 && options.timeout <= 5_000, "bounded service lookup");
					calls.push("GET services");
					if (requestError) throw requestError;
					return {
						ok: () => ok,
						async json() {
							assert.ok(ok, "HTTP errors must fail before reading the body");
							if (jsonError) throw jsonError;
							return body;
						},
					};
				},
			},
			getByText(text) {
				assert.equal(text, "Seerr Requests");
				calls.push("locate widget");
				return {
					first: () => ({
						async waitFor(options) {
							assert.equal(options.state, "visible");
							assert.ok(options.timeout > 0 && options.timeout <= 5_000, "bounded widget check");
							calls.push("wait visible");
							if (hidden) throw hiddenError;
						},
					}),
				};
			},
		},
	};
}

// These cases catch skipped API lookup, disabled-service selection, case-sensitive
// selection, and a missing short timeout at the actual helper's I/O boundary.
for (const [name, services, expected] of [
	["absent", [], false],
	["unrelated enabled service", [{ service: "SONARR", enabled: true }], false],
	["disabled", [{ service: "seerr", enabled: false }], false],
	["uppercase disabled", [{ service: "SEERR", enabled: false }], false],
	["enabled and visible", [{ service: "seerr", enabled: true }], true],
	["uppercase enabled and visible", [{ service: "SEERR", enabled: true }], true],
	[
		"disabled before enabled",
		[
			{ service: "seerr", enabled: false },
			{ service: "SEERR", enabled: true },
		],
		true,
	],
]) {
	test(`Seerr: ${name}`, async () => {
		const fixture = seerrPage({ body: { services } });
		assert.equal(await hasSeerrWidget(fixture.page), expected);
		assert.deepEqual(
			fixture.calls,
			expected ? ["GET services", "locate widget", "wait visible"] : ["GET services"],
		);
	});
}

test("Seerr: configured but hidden widget failure propagates instead of skipping", async () => {
	const fixture = seerrPage({
		body: { services: [{ service: "SEERR", enabled: true }] },
		hidden: true,
	});
	await assert.rejects(hasSeerrWidget(fixture.page), (error) => error === fixture.hiddenError);
	assert.deepEqual(fixture.calls, ["GET services", "locate widget", "wait visible"]);
});

// Each malformed shape would otherwise falsely establish absence, or allow an
// early match to conceal a malformed remaining entry. Values are synthetic.
for (const [name, body] of [
	["null root", null],
	["array root", []],
	["string root", "invalid"],
	["missing services", {}],
	["null services", { services: null }],
	["object services", { services: {} }],
	["null entry", { services: [null] }],
	["array entry", { services: [[]] }],
	["missing service", { services: [{ enabled: true }] }],
	["non-string service", { services: [{ service: 1, enabled: true }] }],
	["missing enabled", { services: [{ service: "SEERR" }] }],
	["non-boolean enabled", { services: [{ service: "SEERR", enabled: "false" }] }],
	["malformed after enabled match", { services: [{ service: "SEERR", enabled: true }, null] }],
]) {
	test(`Seerr: malformed ${name} fails instead of skipping`, async () => {
		const fixture = seerrPage({ body });
		await assert.rejects(hasSeerrWidget(fixture.page), /Invalid services response/);
		assert.deepEqual(fixture.calls, ["GET services"]);
	});
}

test("Seerr: HTTP failure propagates instead of skipping", async () => {
	const fixture = seerrPage({ ok: false });
	await assert.rejects(hasSeerrWidget(fixture.page), /Services precondition request failed/);
	assert.deepEqual(fixture.calls, ["GET services"]);
});

for (const kind of ["request", "json"]) {
	test(`Seerr: ${kind} failure propagates instead of skipping`, async () => {
		const error = new Error(`synthetic ${kind} failure`);
		const fixture = seerrPage({ [`${kind}Error`]: error });
		await assert.rejects(hasSeerrWidget(fixture.page), (actual) => actual === error);
		assert.deepEqual(fixture.calls, ["GET services"]);
	});
}

function calendarCallbacks(root) {
	const source = parse(path.join(root, "calendar.spec.ts"));
	const callbacks = [];
	function visit(node) {
		if (ts.isCallExpression(node) && node.expression.getText(source) === "test") {
			const body = node.arguments[1]?.body;
			if (body && ts.isBlock(body)) {
				const declarations = [];
				for (const statement of body.statements) {
					if (ts.isVariableStatement(statement)) declarations.push(statement.getText(source));
					if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression))
						continue;
					const call = statement.expression.expression;
					if (!ts.isCallExpression(call) || call.expression.getText(source) !== "page.route")
						continue;
					if (call.arguments[0]?.text !== "**/api/dashboard/calendar?**") continue;
					callbacks.push(
						execute(`${declarations.join("\n")}\n(${call.arguments[1].getText(source)});`, {
							URL,
							expect: (actual) => ({ toBe: (expected) => assert.equal(actual, expected) }),
						}),
					);
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	assert.equal(callbacks.length, 2, "both actual timezone route callbacks must be exercised");
	return callbacks;
}

async function calendarPayload(callback, query = "start=2026-07-25&end=2026-09-06") {
	let payload;
	await callback({
		request: () => ({ url: () => `http://fixture.invalid/api/dashboard/calendar?${query}` }),
		async fulfill(options) {
			assert.equal(options.contentType, "application/json");
			assert.equal(payload, undefined, "a route must fulfill once");
			payload = JSON.parse(options.body);
		},
	});
	assert.ok(payload, "the actual callback must fulfill its response");
	return payload;
}

const currentCallbacks = calendarCallbacks(specRoot);
// Hand-checked original rows: metadata fixes must not alter timezone fixtures.
const originalRows = [
	[
		{
			id: 756,
			title: "Stockholm timezone regression",
			seriesTitle: "Stockholm timezone regression",
			service: "sonarr",
			type: "episode",
			airDate: "2026-08-15",
			airDateUtc: "2026-08-16T00:00:00Z",
			seasonNumber: 1,
			episodeNumber: 1,
			instanceId: "sonarr-1",
			instanceName: "Sonarr",
		},
	],
	[
		{
			id: 757,
			title: "Visible boundary episode",
			seriesTitle: "Visible boundary episode",
			service: "sonarr",
			type: "episode",
			airDate: "2026-07-25",
			airDateUtc: "2026-07-25T23:30:00Z",
			seasonNumber: 1,
			episodeNumber: 1,
			instanceId: "sonarr-1",
			instanceName: "Sonarr",
		},
		{
			id: 758,
			title: "Padding-only episode",
			seriesTitle: "Padding-only episode",
			service: "sonarr",
			type: "episode",
			airDate: "2026-07-25",
			airDateUtc: "2026-07-25T12:00:00Z",
			seasonNumber: 1,
			episodeNumber: 2,
			instanceId: "sonarr-1",
			instanceName: "Sonarr",
		},
	],
];
for (const index of [0, 1]) {
	test(`Calendar: timezone fixture ${index + 1} passes the real shared consumer schema without row changes`, async () => {
		const payload = await calendarPayload(currentCallbacks[index]);
		assert.equal(
			schema.safeParse(payload).success,
			true,
			"real calendar schema rejects the route response",
		);
		const withoutAvailability = structuredClone(payload);
		delete withoutAvailability.availability;
		for (const instance of withoutAvailability.instances) {
			delete instance.availability;
			delete instance.reason;
			delete instance.rejectedItemCount;
		}
		assert.deepEqual(withoutAvailability, {
			instances: [
				{
					instanceId: "sonarr-1",
					instanceName: "Sonarr",
					service: "sonarr",
					data: originalRows[index],
				},
			],
			aggregated: originalRows[index],
			totalCount: [1, 2][index],
		});
	});
}

for (const [name, query] of [
	["start", "start=2026-07-26&end=2026-09-06"],
	["end", "start=2026-07-25&end=2026-09-05"],
]) {
	test(`Calendar: actual padding callback still rejects a wrong ${name} query`, async () => {
		await assert.rejects(calendarPayload(currentCallbacks[1], query), { code: "ERR_ASSERTION" });
	});
}
