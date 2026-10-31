import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const health = createRequire(import.meta.url)(
	resolve(process.cwd(), "../../docker/runtime-health.cjs"),
) as {
	publishWebPort(value: string, directory: string): void;
	checkWebHealth(directory: string): Promise<boolean>;
};

describe("Docker runtime-selected liveness", () => {
	let fixture: string;
	let directory: string;
	let server: Server | undefined;
	let requests: string[];
	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), "arr-runtime-health-tests-"));
		directory = join(fixture, "runtime");
		requests = [];
	});
	afterEach(async () => {
		if (server) {
			const current = server;
			current.closeAllConnections();
			await new Promise<void>((done) => current.close(() => done()));
			server = undefined;
		}
		rmSync(fixture, { recursive: true, force: true });
	});
	async function listen(status = 200, stall = false, delayMs = 0) {
		server = createServer((request, response) => {
			requests.push(request.url ?? "");
			if (stall) return;
			response.statusCode = status;
			if (status === 302) response.setHeader("location", "/not-liveness");
			if (delayMs) {
				const timer = setTimeout(() => response.end("synthetic fixture"), delayMs);
				response.on("close", () => clearTimeout(timer));
			} else {
				response.end("synthetic fixture");
			}
		});
		await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
		return String(address.port);
	}

	it("publishes private metadata and probes only the selected loopback live route", async () => {
		const port = await listen();
		health.publishWebPort(port, directory);
		expect(lstatSync(directory).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(directory, "web-port")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(directory, "web-port"), "utf8")).toBe(`${port}\n`);
		expect(await health.checkWebHealth(directory)).toBe(true);
		expect(requests).toEqual(["/live"]);
	});

	it("replaces stale metadata atomically and leaves no temporary files", async () => {
		health.publishWebPort("3000", directory);
		const port = await listen();
		health.publishWebPort(port, directory);
		expect(readdirSync(directory)).toEqual(["web-port"]);
		expect(await health.checkWebHealth(directory)).toBe(true);
	});

	it.each(["", "0", "65536", "-1", "03000", "3000/path", "3000\n", "1e3"])(
		"rejects invalid publication input %j before creating metadata",
		(value) => {
			expect(() => health.publishWebPort(value, directory)).toThrow();
			expect(readdirSync(fixture)).toEqual([]);
		},
	);

	it("fails closed on absent metadata without making a request", async () => {
		await listen();
		expect(await health.checkWebHealth(directory)).toBe(false);
		expect(requests).toEqual([]);
	});

	it.each(["0\n", "65536\n", "3000", "03000\n", "3000\nX", "x".repeat(100)])(
		"fails closed on corrupt bounded metadata %j",
		async (value) => {
			health.publishWebPort("3000", directory);
			writeFileSync(join(directory, "web-port"), value);
			expect(await health.checkWebHealth(directory)).toBe(false);
			expect(requests).toEqual([]);
		},
	);

	it("rejects public-readable metadata and can recover through a new publication", async () => {
		const port = await listen();
		health.publishWebPort(port, directory);
		chmodSync(join(directory, "web-port"), 0o644);
		expect(await health.checkWebHealth(directory)).toBe(false);
		health.publishWebPort(port, directory);
		expect(await health.checkWebHealth(directory)).toBe(true);
	});

	it("rejects a nonprivate runtime directory", async () => {
		health.publishWebPort("3000", directory);
		chmodSync(directory, 0o755);
		expect(await health.checkWebHealth(directory)).toBe(false);
		expect(() => health.publishWebPort("3001", directory)).toThrow();
	});

	it("rejects a symlinked runtime directory for publication and checking", async () => {
		const target = join(fixture, "target");
		mkdirSync(target, { mode: 0o700 });
		symlinkSync(target, directory);
		expect(() => health.publishWebPort("3000", directory)).toThrow();
		expect(await health.checkWebHealth(directory)).toBe(false);
		expect(readdirSync(target)).toEqual([]);
	});

	it("rejects symlinked metadata and publication replaces the link without touching its target", async () => {
		const port = await listen();
		mkdirSync(directory, { mode: 0o700 });
		const target = join(fixture, "target");
		writeFileSync(target, "synthetic-original", { mode: 0o600 });
		symlinkSync(target, join(directory, "web-port"));
		expect(await health.checkWebHealth(directory)).toBe(false);
		health.publishWebPort(port, directory);
		expect(readFileSync(target, "utf8")).toBe("synthetic-original");
		expect(await health.checkWebHealth(directory)).toBe(true);
	});

	it.each([302, 401, 503])("rejects HTTP %i rather than claiming healthy", async (status) => {
		health.publishWebPort(await listen(status), directory);
		expect(await health.checkWebHealth(directory)).toBe(false);
		expect(requests).toEqual(["/live"]);
	});

	it("fails closed when the selected server is unavailable", async () => {
		const port = await listen();
		await new Promise<void>((done) => server!.close(() => done()));
		server = undefined;
		health.publishWebPort(port, directory);
		expect(await health.checkWebHealth(directory)).toBe(false);
	});

	it("bounds a stalled liveness request across a forward wall-clock correction", async () => {
		health.publishWebPort(await listen(200, true), directory);
		const actualWallTime = Date.now.bind(Date);
		let wallOffset = 0;
		const wallClock = vi.spyOn(Date, "now").mockImplementation(() => actualWallTime() + wallOffset);
		try {
			const started = performance.now();
			const checking = health.checkWebHealth(directory);
			wallOffset = 60_000;
			expect(await checking).toBe(false);
			expect(performance.now() - started).toBeLessThan(11000);
			expect(requests).toEqual(["/live"]);
		} finally {
			wallClock.mockRestore();
		}
	}, 12000);

	it("allows a healthy response within the existing web liveness budget", async () => {
		health.publishWebPort(await listen(200, false, 6000), directory);
		expect(await health.checkWebHealth(directory)).toBe(true);
		expect(requests).toEqual(["/live"]);
	}, 10000);
});
