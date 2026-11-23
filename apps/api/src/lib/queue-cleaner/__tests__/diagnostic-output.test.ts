import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import pino from "pino";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticReporter } from "../diagnostic-output.js";

const PRIVATE = "synthetic-private-sentinel";
const scripts = [
	"analyze-status-patterns.ts",
	"test-arr-integration.ts",
	"test-lidarr-integration.ts",
	"test-live-import.ts",
] as const;

async function runScript(
	script: (typeof scripts)[number],
	options: {
		fail?: boolean;
		failPath?: string;
		commandStatus?: string;
		sinkThrows?: boolean;
		invalidPreview?: boolean;
		noEligible?: boolean;
		httpFailure?: boolean;
	} = {},
) {
	const scenario = options;
	const output: string[] = [];
	const requests: Array<{ path: string; query: string; method: string; body?: unknown }> = [];
	const capture = (...args: unknown[]) => output.push(args.map(String).join(" "));
	const reportDiagnostic = createDiagnosticReporter(
		options.sinkThrows
			? {
					info: () => {
						throw new Error(PRIVATE);
					},
				}
			: pino(
					{ base: null, timestamp: false },
					{
						write: (line) => {
							output.push(line);
						},
					},
				),
	);
	const queue = {
		totalRecords: 5,
		records: [
			{
				id: 701,
				title: `married ${PRIVATE}`,
				downloadId: PRIVATE,
				trackedDownloadState: "importPending",
				trackedDownloadStatus: PRIVATE,
				statusMessages: [{ title: `waiting for import matched to series by id ${PRIVATE}` }],
			},
			{
				id: 702,
				title: PRIVATE,
				trackedDownloadState: "importBlocked",
				statusMessages: [{ title: `already exists ${PRIVATE}` }],
			},
			{ id: 703, title: PRIVATE, trackedDownloadState: "importFailed" },
			{ id: 704, title: PRIVATE, trackedDownloadState: PRIVATE },
			{ id: 705, title: PRIVATE, trackedDownloadState: "downloading" },
		],
	};
	if (options.noEligible) queue.records = [];
	const preview = [
		{
			id: 801,
			name: PRIVATE,
			path: `/synthetic/${PRIVATE}`,
			size: 1024,
			series: { id: 802, title: PRIVATE },
			episodes: [{ id: 803, episodeNumber: 1, seasonNumber: 1 }],
			quality: { quality: { name: PRIVATE } },
			rejections: [{ reason: PRIVATE }],
		},
	];
	const source = readFileSync(new URL(`../${script}`, import.meta.url), "utf8");
	const compiled = ts.transpileModule(
		source.replaceAll("import.meta.url", JSON.stringify(`file:///${script}`)),
		{
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		},
	).outputText;
	// The actual entry code runs in a closed context: no host process, modules,
	// credentials, timers, filesystem or network are available to the script.
	const completion = runInNewContext(
		compiled,
		{
			exports: {},
			require: (name: string) => {
				if (name === "./diagnostic-output.js") return { reportDiagnostic };
				if (name === "../utils/error-message.js") return { getErrorMessage: String };
				throw new Error("Unexpected diagnostic dependency");
			},
			process: {
				env: Object.fromEntries(
					["SONARR", "RADARR", "LIDARR"].flatMap((provider) => [
						[`${provider}_URL`, `https://${PRIVATE}.invalid`],
						[`${provider}_API_KEY`, PRIVATE],
					]),
				),
				argv: ["synthetic", script],
				stdout: { write: capture },
				exit: () => {
					throw new Error("Unexpected exit");
				},
			},
			console: { log: capture, error: capture },
			setTimeout: (callback: () => void) => {
				callback();
				return 0;
			},
			fetch: async (url: string, options?: RequestInit) => {
				const path = new URL(url).pathname;
				requests.push({
					path,
					query: new URL(url).search,
					method: options?.method ?? "GET",
					body: options?.body ? JSON.parse(String(options.body)) : undefined,
				});
				if (scenario.fail || scenario.failPath === path) throw new Error(PRIVATE);
				const result = path.endsWith("/queue")
					? queue
					: path.endsWith("/manualimport")
						? scenario.invalidPreview
							? []
							: preview
						: path.endsWith("/command")
							? { id: 901 }
							: { status: scenario.commandStatus ?? "completed", message: PRIVATE };
				return {
					ok: !scenario.httpFailure,
					status: scenario.httpFailure ? 500 : 200,
					statusText: PRIVATE,
					text: async () => PRIVATE,
					json: async () => result,
				};
			},
		},
		{ timeout: 1000 },
	);
	await completion;
	return {
		output,
		requests,
		records: output.map((line) => JSON.parse(line)) as Array<Record<string, unknown>>,
	};
}

describe("manual diagnostic entry output", () => {
	for (const script of scripts) {
		it(`${script} hides private queue, preview, status and error data`, async () => {
			const success = await runScript(script);
			expect(success.requests.length).toBeGreaterThan(0);
			expect(success.output.some((line) => line.includes(PRIVATE))).toBe(false);
			const failure = await runScript(script, { fail: true });
			expect(failure.output.some((line) => line.includes(PRIVATE))).toBe(false);
			expect(
				failure.records.some(
					(record) => record.event === "provider-failed" || record.success === false,
				),
			).toBe(true);
		});
	}

	it("retains queue totals, closed state counts, eligibility and pattern aggregates", async () => {
		const arr = await runScript("test-arr-integration.ts");
		expect(arr.records.filter((record) => record.event === "queue-summary")).toHaveLength(3);
		for (const record of arr.records.filter((record) => record.event === "queue-summary")) {
			expect(record).toMatchObject({
				totalItems: 5,
				pendingItems: 1,
				blockedItems: 1,
				failedItems: 1,
				downloadingItems: 1,
				otherItems: 1,
				eligibleItems: 1,
				ineligibleItems: 1,
				success: true,
			});
		}
		expect(arr.records.at(-1)).toMatchObject({
			event: "complete",
			instances: 3,
			successfulInstances: 3,
			eligibleItems: 3,
		});
		const lidarr = await runScript("test-lidarr-integration.ts");
		expect(lidarr.records.find((record) => record.event === "preview-summary")).toMatchObject({
			importItems: 3,
			wouldRemoveItems: 2,
			eligibleItems: 1,
			wouldWarnItems: 0,
		});
		expect(lidarr.records.at(-1)).toMatchObject({ event: "manual-import-api", available: true });
		const patterns = await runScript("analyze-status-patterns.ts");
		expect(patterns.records.filter((record) => record.event === "pattern-summary")).toHaveLength(2);
		for (const record of patterns.records.filter((record) => record.event === "pattern-summary")) {
			expect(record).toMatchObject({
				totalItems: 5,
				pendingItems: 1,
				blockedItems: 1,
				patterns: 2,
				messageOccurrences: 2,
			});
		}
	});

	it("preserves the bounded provider request sequences", async () => {
		const expected = [
			["/api/v3/queue?pageSize=200", "/api/v3/queue?pageSize=200"],
			["/api/v3/queue?pageSize=100", "/api/v3/queue?pageSize=100", "/api/v1/queue?pageSize=100"],
			["/api/v1/queue?pageSize=100", "/api/v1/manualimport?downloadId=test"],
		];
		for (const [index, script] of scripts.slice(0, 3).entries()) {
			const { requests } = await runScript(script);
			expect(requests.map((request) => request.path + request.query)).toEqual(expected[index]);
			expect(
				requests.every((request) => request.method === "GET" && request.body === undefined),
			).toBe(true);
		}
	});

	it("preserves the selected live import, command payload and polling while keeping them private", async () => {
		const { requests, records } = await runScript("test-live-import.ts");
		expect(requests.map((request) => request.path + request.query)).toEqual([
			"/api/v3/queue?pageSize=200",
			`/api/v3/manualimport?downloadId=${PRIVATE}&filterExistingFiles=true`,
			"/api/v3/command",
			"/api/v3/command/901",
		]);
		expect(requests[2]).toMatchObject({
			method: "POST",
			body: {
				name: "ManualImport",
				importMode: "auto",
				files: [
					{
						path: `/synthetic/${PRIVATE}`,
						seriesId: 802,
						episodeIds: [803],
						quality: { quality: { name: PRIVATE } },
						downloadId: PRIVATE,
					},
				],
			},
		});
		expect(records.find((record) => record.event === "import-preview")).toMatchObject({
			files: 1,
			rejectedFiles: 1,
		});
		expect(records.some((record) => record.event === "partial-import-warning")).toBe(true);
		expect(records.at(-1)).toMatchObject({ event: "command-status", status: "completed" });
	});

	it("keeps failure, unknown status, timeout and HTTP-error output generic", async () => {
		for (const commandStatus of ["failed", PRIVATE]) {
			const result = await runScript("test-live-import.ts", { commandStatus });
			expect(result.output.some((line) => line.includes(PRIVATE))).toBe(false);
			expect(result.records.at(-1)).toMatchObject({
				event: "command-status",
				status: commandStatus === "failed" ? "failed" : "unknown",
			});
			if (commandStatus === PRIVATE) {
				expect(result.records.find((record) => record.event === "command-timeout")).toMatchObject({
					attempts: 30,
				});
				expect(
					result.requests.filter((request) => request.path === "/api/v3/command/901"),
				).toHaveLength(30);
			}
		}
		for (const script of scripts) {
			const result = await runScript(script, { httpFailure: true });
			expect(result.output.some((line) => line.includes(PRIVATE))).toBe(false);
		}
		for (const failPath of ["/api/v3/command", "/api/v3/command/901"]) {
			const result = await runScript("test-live-import.ts", { failPath });
			expect(result.output.some((line) => line.includes(PRIVATE))).toBe(false);
			expect(result.records.at(-1)).toMatchObject({ event: "provider-failed" });
			expect(result.requests.filter((request) => request.method === "POST")).toHaveLength(1);
		}
		const lidarr = await runScript("test-lidarr-integration.ts", {
			failPath: "/api/v1/manualimport",
		});
		expect(lidarr.output.some((line) => line.includes(PRIVATE))).toBe(false);
		expect(lidarr.records.at(-1)).toMatchObject({ event: "provider-failed" });
	});

	it("preserves early returns and provider effects even when reporting throws", async () => {
		for (const scenario of [{ noEligible: true }, { invalidPreview: true }]) {
			const result = await runScript("test-live-import.ts", scenario);
			expect(result.requests.every((request) => request.method === "GET")).toBe(true);
			expect(result.records.at(-1)?.event).toBe(
				scenario.noEligible ? "no-eligible-items" : "no-valid-items",
			);
		}
		for (const script of scripts) {
			const successful = await runScript(script);
			const sinkFailure = await runScript(script, { sinkThrows: true });
			expect(sinkFailure.requests).toEqual(successful.requests);
			expect(sinkFailure.output).toEqual([]);
		}
	});
});

describe("diagnostic serialization boundary", () => {
	it("emits only closed labels, safe counts and booleans through real pino", () => {
		const lines: string[] = [];
		const report = createDiagnosticReporter(
			pino(
				{ base: null, timestamp: false },
				{
					write: (line) => {
						lines.push(line);
					},
				},
			),
		);
		const getter = vi.fn(() => {
			throw new Error(PRIVATE);
		});
		const input = Object.create({ files: 15 });
		Object.defineProperty(input, "attempts", { get: getter });
		Object.assign(input, {
			totalItems: 5,
			pendingItems: -1,
			blockedItems: Number.NaN,
			failedItems: Infinity,
			otherItems: Number.MAX_SAFE_INTEGER + 1,
			eligibleItems: 1.5,
			success: true,
			available: PRIVATE,
			provider: PRIVATE,
			status: PRIVATE,
			[PRIVATE]: PRIVATE,
			title: PRIVATE,
			url: PRIVATE,
			error: new Error(PRIVATE),
			toJSON: getter,
		});
		report("arr-integration", "queue-summary", input);
		expect(getter).not.toHaveBeenCalled();
		expect(JSON.parse(lines[0]!)).toEqual({
			level: 30,
			category: "queue-cleaner-diagnostic",
			tool: "arr-integration",
			event: "queue-summary",
			totalItems: 5,
			success: true,
			msg: "Queue cleaner diagnostic",
		});
	});

	it("does not coerce runtime input or expose arbitrary categories and keys", () => {
		const info = vi.fn();
		const report = createDiagnosticReporter({ info });
		const getter = vi.fn(() => {
			throw new Error(PRIVATE);
		});
		const hostile = { toString: getter, toJSON: getter };
		report(
			hostile as never,
			hostile as never,
			{ totalItems: hostile, provider: hostile, status: hostile, success: hostile } as never,
		);
		expect(getter).not.toHaveBeenCalled();
		expect(info).toHaveBeenLastCalledWith(
			{ category: "queue-cleaner-diagnostic", tool: "unknown", event: "invalid-event" },
			"Queue cleaner diagnostic",
		);
		const proxy = new Proxy({}, { getOwnPropertyDescriptor: getter });
		expect(() => report("live-import", "started", proxy)).not.toThrow();
		expect(JSON.stringify(info.mock.calls).includes(PRIVATE)).toBe(false);
	});
});
