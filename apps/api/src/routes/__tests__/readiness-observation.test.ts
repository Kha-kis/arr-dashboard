import { Writable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import lifecyclePlugin from "../../plugins/lifecycle.js";
import { registerSessionValidationHook } from "../../server.js";
import { registerHealthRoutes, registerLiveRoutes } from "../health.js";

type Phase = "pre-handler" | "handler-admission" | "database-check";
const sensitiveDecoy = "synthetic-private-value";
const apps: Array<ReturnType<typeof Fastify>> = [];
const releases: Array<() => void> = [];

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function boot() {
	const records: Array<Record<string, unknown>> = [];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			for (const line of String(chunk).trim().split("\n")) records.push(JSON.parse(line));
			done();
		},
	});
	const app = Fastify({ logger: { level: "info", stream } });
	apps.push(app);
	const state: { failAt?: Phase; statusCode: number; queries: number } = {
		statusCode: 503,
		queries: 0,
	};
	const fail = (phase: Phase) => {
		if (state.failAt === phase) {
			throw Object.assign(new Error(sensitiveDecoy), { statusCode: state.statusCode });
		}
	};
	app.decorate("restoreRuntime", {
		async runIndependentOperation(operation: () => Promise<unknown>) {
			fail("pre-handler");
			return operation();
		},
		async runOperation(operation: () => Promise<unknown>) {
			fail("handler-admission");
			return operation();
		},
	} as never);
	app.decorate("sessionService", { validateRequest: async () => null } as never);
	app.decorate("prisma", {
		async $queryRaw() {
			state.queries++;
			fail("database-check");
			return [{ value: 1 }];
		},
	} as never);
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	await app.register(lifecyclePlugin);
	registerSessionValidationHook(app);
	app.register(registerHealthRoutes, { prefix: "/health" });
	app.register(registerLiveRoutes, { prefix: "/live" });
	app.get("/unrelated", { logLevel: "silent" }, (_request, reply) => reply.code(503).send());
	await app.ready();
	return {
		app,
		state,
		records,
		failures: () => records.filter((record) => record.category === "readiness-failure"),
	};
}

describe("sanitized readiness failure observation", () => {
	for (const method of ["GET", "HEAD"] as const) {
		it.each(["pre-handler", "handler-admission", "database-check"] as const)(
			`${method} records the %s boundary despite silent request logging and then recovers`,
			async (phase) => {
				const { app, state, records, failures } = await boot();
				state.failAt = phase;
				const response = await app.inject({
					method,
					url: `/health?phase=spoofed&private=${sensitiveDecoy}`,
					headers: { cookie: `session=${sensitiveDecoy}`, "x-private": sensitiveDecoy },
				});

				expect(response.statusCode).toBe(503);
				expect(state.queries).toBe(phase === "database-check" ? 1 : 0);
				expect(failures()).toHaveLength(1);
				const { level, time, pid, hostname, msg, ...fields } = failures()[0]!;
				expect(fields).toEqual({
					category: "readiness-failure",
					phase,
					statusCode: 503,
					elapsedMs: expect.any(Number),
				});
				expect(Number.isFinite(fields.elapsedMs)).toBe(true);
				expect(fields.elapsedMs).toBeGreaterThanOrEqual(0);
				expect(JSON.stringify(records)).not.toContain(sensitiveDecoy);

				// Liveness still bypasses both readiness admission and the database.
				await expect(app.inject({ method, url: "/live" })).resolves.toMatchObject({
					statusCode: 200,
				});
				expect(state.queries).toBe(phase === "database-check" ? 1 : 0);
				state.failAt = undefined;
				await expect(app.inject({ method, url: "/health" })).resolves.toMatchObject({
					statusCode: 200,
				});
				expect(failures()).toHaveLength(1);
			},
		);
	}

	it("does not emit readiness diagnostics for successful probes or unrelated failures", async () => {
		const { app, failures } = await boot();
		for (const url of ["/health", "/live"]) {
			await expect(app.inject({ method: "GET", url })).resolves.toMatchObject({ statusCode: 200 });
		}
		await expect(app.inject({ method: "GET", url: "/unrelated" })).resolves.toMatchObject({
			statusCode: 503,
		});
		expect(failures()).toEqual([]);
	});

	it("also records an unexpected handler-admission500 without changing its status", async () => {
		const { app, state, failures } = await boot();
		state.failAt = "handler-admission";
		state.statusCode = 500;
		await expect(app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({
			statusCode: 500,
		});
		expect(failures()).toMatchObject([{ phase: "handler-admission", statusCode: 500 }]);
	});

	it("isolates phase markers for overlapping failed and successful probes", async () => {
		const { app, failures } = await boot();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.push(release);
		let calls = 0;
		app.prisma.$queryRaw = (async () => {
			if (++calls === 1) {
				entered();
				await gate;
				throw new Error(sensitiveDecoy);
			}
			return [{ value: 1 }];
		}) as typeof app.prisma.$queryRaw;
		const failed = app.inject({ method: "GET", url: "/health" }).then((response) => response);
		await started;
		try {
			await expect(app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({
				statusCode: 200,
			});
		} finally {
			release();
		}
		await expect(failed).resolves.toMatchObject({ statusCode: 503 });
		expect(failures()).toMatchObject([{ phase: "database-check", statusCode: 503 }]);
	});
});
