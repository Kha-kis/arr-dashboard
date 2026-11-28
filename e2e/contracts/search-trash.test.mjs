import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, parse as parseUrl } from "node:url";
import vm from "node:vm";
import nextConfig from "../../apps/web/next.config.mjs";

const candidate = fileURLToPath(new URL("../../", import.meta.url));
const specRoot = path.join(candidate, "e2e");
const ts = createRequire(path.join(candidate, "package.json"))("typescript");
const zod = createRequire(path.join(candidate, "packages/shared/package.json"))("zod");
const titles = {
	button: "should have search button",
	results: "should display results or no results message",
	types: "should have category filter",
	templates: "should display templates with service type badges or empty state",
};

function execute(source, context, file = "extracted-callback.ts") {
	const result = ts.transpileModule(source, {
		fileName: file,
		reportDiagnostics: true,
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	});
	assert.equal(result.diagnostics?.length ?? 0, 0);
	return vm.runInNewContext(result.outputText, context, { filename: file, timeout: 1_000 });
}

// Real shared validation runs against the responses produced by the extracted
// browser route callbacks. No application process or network is started.
const searchExports = {};
execute(readFileSync(path.join(candidate, "packages/shared/src/types/search.ts"), "utf8"), {
	exports: searchExports,
	require: (name) => {
		assert.equal(name, "zod");
		return zod;
	},
});

class Skipped extends Error {}
function expect(actual) {
	return {
		toBe: (value) => assert.equal(actual, value),
		toEqual: (value) =>
			assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(value))),
		toBeVisible: async () =>
			assert.equal(actual.visible(), true, `required visible: ${actual.label}`),
		toBeEnabled: async () =>
			assert.equal(actual.visible(), true, `required enabled: ${actual.label}`),
		toHaveCount: async (count) =>
			assert.equal(await actual.count(), count, `required count: ${actual.label}`),
		toHaveURL: async (pattern) =>
			assert.ok(pattern.test(actual.url()), "authenticated Search URL required"),
	};
}

function loadCallbacks(file, wanted) {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	assert.equal(source.parseDiagnostics.length, 0);
	const helpers = source.statements
		.filter(ts.isFunctionDeclaration)
		.map((node) => node.getText(source));
	const result = {};
	function visit(node) {
		if (ts.isCallExpression(node) && node.expression.getText(source) === "test") {
			const title = node.arguments[0]?.text;
			const key = Object.keys(wanted).find((key) => wanted[key] === title);
			if (key) {
				result[key] = execute(
					`${helpers.join("\n")}\n(${node.arguments[1].getText(source)});`,
					{
						expect,
						URL,
						BASE_URL: "http://fixture.invalid",
						ROUTES: { search: "/search" },
						TIMEOUTS: { medium: 20_000, short: 10_000 },
						waitForLoadingComplete: async () => {},
						test: {
							skip: (condition) => {
								if (condition) throw new Skipped("silent skip");
							},
						},
					},
					file,
				);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	assert.equal(Object.keys(result).length, Object.keys(wanted).length);
	return result;
}

const callbacks = {
	...loadCallbacks(path.join(specRoot, "search.spec.ts"), {
		button: titles.button,
		results: titles.results,
		types: titles.types,
	}),
	...loadCallbacks(path.join(specRoot, "trash-guides.spec.ts"), { templates: titles.templates }),
};

function matches(value, matcher) {
	return typeof matcher === "string" ? value === matcher : Boolean(matcher?.test(value));
}

function fixturePage(overrides = {}) {
	const state = {
		heading: true,
		signIn: false,
		form: true,
		searchButton: true,
		noConfig: false,
		input: true,
		typeButtons: true,
		brokenType: false,
		selectedType: "movie",
		query: "",
		submitted: false,
		emptyMessage: true,
		verifiedFeedback: true,
		unverified: false,
		unverifiedTypes: [],
		emptyTemplates: true,
		rateLimited: false,
		failedLoad: false,
		...overrides,
	};
	const routes = [],
		waiters = [],
		reads = [],
		submissions = [],
		bodies = new Map();
	let currentUrl = "http://fixture.invalid/search";
	const isForm = () => state.form && !state.signIn;
	function locator(label, visible, action) {
		return {
			label,
			visible,
			first() {
				return this;
			},
			or(other) {
				return locator(`${label} or ${other.label}`, () => visible() || other.visible());
			},
			async isVisible() {
				return visible();
			},
			async count() {
				return visible() ? 1 : 0;
			},
			getByRole: (role, options) => roleLocator(role, options, true),
			async fill(value) {
				assert.ok(visible(), `cannot fill missing ${label}`);
				state.query = value;
			},
			async click() {
				assert.ok(visible(), `cannot click missing ${label}`);
				if (!action) throw new TypeError(`unsupported contract click: ${label}`);
				await action();
			},
		};
	}
	async function emit(pathname, method, payload) {
		const url = new URL(pathname, currentUrl);
		const route = [...routes]
			.reverse()
			.find(([matcher]) =>
				typeof matcher === "function"
					? matcher(url)
					: String(matcher).replace(/^\*\*/, "") === url.pathname,
			);
		const request = { method: () => method, postDataJSON: () => payload, url: () => url.href };
		let response;
		if (route) {
			await route[1]({
				request: () => request,
				async fulfill(options) {
					assert.equal(options.status, 200);
					assert.equal(options.contentType, "application/json");
					const body = JSON.parse(options.body);
					if (url.pathname === "/api/search/indexers")
						searchExports.searchIndexersResponseSchema.parse(body);
					if (url.pathname === "/api/search/query")
						searchExports.multiInstanceSearchResponseSchema.parse(body);
					if (url.pathname === "/api/trash-guides/templates")
						assert.deepEqual(body, { templates: [], count: 0 });
					if (url.pathname === "/api/trash-guides/cache/status") {
						assert.deepEqual(body, {
							radarr: [],
							sonarr: [],
							stats: { totalEntries: 0, staleEntries: 0, totalSizeBytes: 0 },
						});
					}
					bodies.set(url.pathname, body);
					response = { url: () => url.href, status: () => options.status, request: () => request };
				},
			});
		}
		response ??= { url: () => url.href, status: () => 200, request: () => request };
		for (let index = waiters.length - 1; index >= 0; index--) {
			if (waiters[index].predicate(response)) waiters.splice(index, 1)[0].resolve(response);
		}
	}
	function roleLocator(role, { name } = {}, insideForm = false) {
		const scope = () => !insideForm || isForm();
		if (role === "heading")
			return locator(
				`heading ${name}`,
				() =>
					state.heading &&
					!state.signIn &&
					!state.failedLoad &&
					!state.rateLimited &&
					(matches("Manual Search", name) ||
						matches("TRaSH Guides", name) ||
						matches("Templates", name) ||
						(state.noConfig && matches("Prowlarr Configuration Required", name))),
			);
		if (role === "link")
			return locator(`link ${name}`, () => matches("Sign in", name) && state.signIn);
		if (role === "textbox") return locator("search textbox", () => state.input && isForm());
		if (role === "combobox") return locator("category combobox", () => false);
		if (role === "button") {
			if (matches("Search", name))
				return locator(
					"Search button",
					() => state.searchButton && isForm() && scope(),
					async () => {
						state.submitted = true;
						const type = state.brokenType ? "all" : state.selectedType;
						submissions.push(type);
						await emit("/api/search/query", "POST", {
							query: state.query,
							type,
							filters: [{ instanceId: "ae148-prowlarr", indexerIds: [1] }],
						});
					},
				);
			for (const [label, type] of [
				["Movies", "movie"],
				["Series", "tv"],
				["Music", "music"],
				["Books", "book"],
				["All", "all"],
			]) {
				if (matches(label, name))
					return locator(
						`type ${label}`,
						() => scope() && isForm() && state.typeButtons,
						async () => {
							state.selectedType = type;
						},
					);
			}
		}
		return locator(`role ${role}`, () => false);
	}
	function textLocator(text) {
		return locator(`text ${text}`, () => {
			const verified = !state.unverified && !state.unverifiedTypes.includes(state.selectedType);
			if (matches("Rate limit exceeded", text) && state.rateLimited) return true;
			if (matches("Failed to load cache status", text) && state.failedLoad) return true;
			if (
				matches(
					"Add at least one Prowlarr instance in Settings to enable manual searches across your indexers.",
					text,
				)
			)
				return state.noConfig;
			if (matches("No results returned from your indexers for that query.", text))
				return state.submitted && state.emptyMessage && verified;
			if (matches("No results found for that query.", text))
				return state.submitted && state.verifiedFeedback && verified;
			if (
				matches("No templates yet", text) ||
				matches("Create your first template to get started with TRaSH Guides deployment", text)
			)
				return state.emptyTemplates && !state.failedLoad && !state.rateLimited;
			return false;
		});
	}
	const page = {
		url: () => currentUrl,
		async goto(url) {
			currentUrl = new URL(url, currentUrl).href;
			const pathnames = currentUrl.endsWith("/trash-guides")
				? [
						"/api/trash-guides/cache/status",
						"/api/trash-guides/templates?sortBy=updatedAt&sortOrder=desc",
					]
				: ["/api/search/indexers"];
			for (const pathname of pathnames) {
				reads.push(new URL(pathname, currentUrl).pathname);
				await emit(pathname, "GET");
			}
		},
		async route(matcher, callback) {
			routes.push([matcher, callback]);
		},
		waitForResponse(predicate) {
			return new Promise((resolve) => waiters.push({ predicate, resolve }));
		},
		async waitForTimeout() {}, // Original fixed waits complete immediately; no real sleep.
		getByRole: roleLocator,
		getByText: textLocator,
		getByPlaceholder: () => locator("search input", () => state.input && isForm()),
		locator(css) {
			if (css === "main form") return locator("Search form", isForm);
			if (css === "article") return locator("template cards", () => false);
			if (css === "article, [class*='result'], tr") return locator("generic results", () => false);
			throw new TypeError(`unsupported contract selector: ${css}`);
		},
	};
	return { page, state, reads, submissions, bodies };
}

async function outcome(callback, fixture) {
	try {
		await callback({ page: fixture.page });
		return { kind: "passed" };
	} catch (error) {
		return { kind: error instanceof Skipped ? "skipped" : "failed", error };
	}
}

for (const [name, key, state] of [
	["configured Search button", "button", {}],
	["explicit unconfigured guidance without form", "button", { noConfig: true, form: false }],
	["verified empty Search submission", "results", {}],
	["real type buttons change submitted type", "types", {}],
	["explicit empty template list", "templates", { form: false }],
]) {
	test(`accepts ${name}`, async () => {
		const fixture = fixturePage(state);
		const result = await outcome(callbacks[key], fixture);
		assert.equal(result.kind, "passed", result.error?.message);
		if (key === "results" || key === "types") {
			assert.ok(
				fixture.bodies.has("/api/search/indexers"),
				"must execute actual indexer fixture route",
			);
			assert.ok(
				fixture.bodies.has("/api/search/query"),
				"must execute actual verified result fixture route",
			);
			assert.deepEqual(fixture.submissions, key === "types" ? ["movie", "tv"] : ["all"]);
		}
		if (key === "templates") {
			assert.ok(
				fixture.bodies.has("/api/trash-guides/cache/status"),
				"must execute actual cache status read fixture",
			);
			assert.ok(
				fixture.bodies.has("/api/trash-guides/templates"),
				"must execute actual empty template read fixture",
			);
		}
	});
}

// Every case below names a state the corrected real test callback must reject.
// A baseline silent skip or successful vacuous predicate fails this contract.
for (const [name, key, state] of [
	["Sign in instead of Search", "button", { signIn: true }],
	["blank Search page", "button", { heading: false, form: false }],
	["configuration message with an unexpected form", "button", { noConfig: true }],
	["configured page missing Search button", "button", { searchButton: false }],
	["missing Search input", "results", { input: false }],
	["no results and no explicit empty message", "results", { emptyMessage: false }],
	["unverified empty search", "results", { unverified: true }],
	["missing verified search feedback", "results", { verifiedFeedback: false }],
	["missing type controls", "types", { typeButtons: false }],
	["type click leaves submitted type unchanged", "types", { brokenType: true }],
	[
		"movie response validation fails despite HTTP 200 and correct payload",
		"types",
		{ unverifiedTypes: ["movie"] },
	],
	[
		"tv response validation fails after verified movie success",
		"types",
		{ unverifiedTypes: ["tv"] },
	],
	["no templates and no empty message", "templates", { emptyTemplates: false }],
	["rate limit instead of templates", "templates", { rateLimited: true }],
	["failed cache load instead of templates", "templates", { failedLoad: true }],
]) {
	test(`rejects ${name}`, async () => {
		const result = await outcome(callbacks[key], fixturePage(state));
		assert.equal(result.kind, "failed", `${name} must fail, not ${result.kind}`);
		assert.equal(
			result.error?.code,
			"ERR_ASSERTION",
			"must fail an observable assertion, not an unsupported double",
		);
	});
}

const { proxyRequest } = createRequire(path.join(candidate, "apps/web/package.json"))(
	"next/dist/server/lib/router-utils/proxy-request.js",
);

async function delayedProxyPost(t, proxyTimeout, responseDelayMs) {
	const sockets = new Set(),
		timers = new Set(),
		work = new Set();
	const received = [],
		proxyErrors = [];
	// Next logs expected timeout failures; retain only their synthetic error codes.
	t.mock.method(console, "error", () => {});
	const track = (server) => {
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		});
		return server;
	};
	const listen = async (server) => {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		return `http://127.0.0.1:${server.address().port}`;
	};
	const upstream = track(
		createServer((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				received.push({ method: req.method, url: req.url, headers: req.headers, body });
				const timer = setTimeout(() => {
					timers.delete(timer);
					res.writeHead(200, { "content-type": "application/json", "x-contract": "synthetic" });
					res.end(JSON.stringify({ success: true }));
				}, responseDelayMs);
				timers.add(timer);
				res.once("close", () => {
					clearTimeout(timer);
					timers.delete(timer);
				});
			});
		}),
	);
	let proxy;
	try {
		const upstreamOrigin = await listen(upstream);
		const previousHost = process.env.API_HOST;
		let rewrites;
		try {
			process.env.API_HOST = upstreamOrigin;
			rewrites = await nextConfig.rewrites();
		} finally {
			if (previousHost === undefined) delete process.env.API_HOST;
			else process.env.API_HOST = previousHost;
		}
		const rewrite = rewrites.find((entry) => entry.source === "/api/:path*");
		assert.ok(rewrite, "actual API rewrite must exist");
		proxy = track(
			createServer((req, res) => {
				const target = rewrite.destination.replace(":path*", req.url.slice("/api/".length));
				const task = proxyRequest(
					req,
					res,
					parseUrl(target, true),
					undefined,
					undefined,
					proxyTimeout,
				).catch((error) => {
					proxyErrors.push(error.code ?? "unknown");
					if (!res.writableEnded) res.end();
				});
				work.add(task);
				void task.finally(() => work.delete(task));
			}),
		);
		const proxyOrigin = await listen(proxy);
		const body = JSON.stringify({ serviceType: "RADARR", synthetic: true });
		const result = await new Promise((resolve, reject) => {
			const req = request(
				`${proxyOrigin}/api/trash-guides/cache/refresh`,
				{
					method: "POST",
					agent: false,
					signal: t.signal,
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
						authorization: "Bearer synthetic-contract",
						cookie: "synthetic=contract",
					},
				},
				(res) => {
					let responseBody = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						responseBody += chunk;
					});
					res.on("error", reject);
					res.on("end", () =>
						resolve({ status: res.statusCode, body: responseBody, headers: res.headers }),
					);
				},
			);
			const deadline = setTimeout(
				() => req.destroy(new Error("synthetic client deadline")),
				45_000,
			);
			timers.add(deadline);
			req.once("close", () => {
				clearTimeout(deadline);
				timers.delete(deadline);
			});
			req.on("error", reject);
			req.end(body);
		});
		assert.equal(received.length, 1);
		assert.equal(received[0].method, "POST");
		assert.equal(received[0].url, "/api/trash-guides/cache/refresh");
		assert.equal(received[0].body, body);
		assert.equal(received[0].headers.authorization, "Bearer synthetic-contract");
		assert.equal(received[0].headers.cookie, "synthetic=contract");
		assert.equal(received[0].headers["x-forwarded-host"], new URL(proxyOrigin).host);
		return { ...result, proxyErrors };
	} finally {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		const closed = [...sockets].map(
			(socket) => new Promise((resolve) => socket.once("close", resolve)),
		);
		for (const socket of sockets) socket.destroy();
		await Promise.all(
			[upstream, proxy]
				.filter((server) => server?.listening)
				.map(
					(server) =>
						new Promise((resolve, reject) =>
							server.close((error) => (error ? reject(error) : resolve())),
						),
				),
		);
		await Promise.all(closed);
		await Promise.all([...work]);
		assert.equal(sockets.size, 0);
		assert.equal(timers.size, 0);
		assert.equal(work.size, 0);
	}
}

test("actual Next proxy acknowledges a TRaSH-like POST beyond its default 30-second timeout", {
	timeout: 75_000,
}, async (t) => {
	const result = await delayedProxyPost(t, nextConfig.experimental.proxyTimeout, 31_500);
	assert.equal(result.status, 200, "legitimate delayed success must reach the caller");
	assert.deepEqual(JSON.parse(result.body), { success: true });
	assert.equal(result.headers["x-contract"], "synthetic");
	assert.deepEqual(result.proxyErrors, []);
	assert.equal(
		nextConfig.experimental.proxyTimeout,
		120_000,
		"manual actions need an explicit finite proxy budget",
	);
});

test("actual Next proxy still rejects an unresponsive upstream at a finite configured timeout", {
	timeout: 8_000,
}, async (t) => {
	const result = await delayedProxyPost(t, 100, 1_000);
	assert.equal(result.status, 500);
	assert.equal(result.proxyErrors.length, 1);
});
