import { request as httpRequest } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import { installNonDatabaseRuntimeFixture } from "../../__tests__/runtime-admission-fixture.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

async function flushCloseCallbacks() {
	for (let turn = 0; turn < 8; turn++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function boot(teardown: () => Promise<void>) {
	const app = Fastify({ logger: false });
	installNonDatabaseRuntimeFixture(app);
	apps.push(app);
	// Production registers Prisma before lifecycle; its close hook must run last.
	app.addHook("onClose", teardown);
	await app.register(lifecyclePlugin);
	return app;
}

it.each(["resolve", "reject"] as const)(
	"joins a disconnected trusted Restore controller through %s settlement",
	async (settlement) => {
		const started = deferred(),
			work = deferred(),
			socketClosed = deferred(),
			closing = deferred();
		releases.push(work.resolve);
		let settled = false,
			infrastructureClosed = false;
		const app = await boot(async () => {
			infrastructureClosed = true;
		});
		app.addHook("preClose", async () => closing.resolve());
		app.post(
			"/synthetic-restore-controller",
			{ config: { runtimeRestoreController: true } },
			async (request) => {
				request.raw.socket.once("close", socketClosed.resolve);
				started.resolve();
				try {
					await work.promise;
					if (settlement === "reject") throw new Error("Synthetic controller failure");
					return { ok: true };
				} finally {
					settled = true;
				}
			},
		);
		const address = await app.listen({ host: "127.0.0.1", port: 0 });
		const request = httpRequest(`${address}/synthetic-restore-controller`, {
			method: "POST",
			agent: false,
		});
		request.on("error", () => undefined);
		request.end();
		await started.promise;
		request.destroy();
		await socketClosed.promise;
		const close = app.close();
		try {
			await closing.promise;
			await flushCloseCallbacks();
			expect(settled).toBe(false);
			expect(infrastructureClosed).toBe(false);
		} finally {
			work.resolve();
			await close;
		}
		expect(settled).toBe(true);
		expect(infrastructureClosed).toBe(true);
	},
);

describe.each(["GET", "POST"] as const)("handler shutdown: %s", (method) => {
	it.each(["resolve", "reject"] as const)(
		"keeps infrastructure alive until a disconnected child-route handler actually settles (%s)",
		async (settlement) => {
			const started = deferred();
			const work = deferred();
			const socketClosed = deferred();
			const closing = deferred();
			releases.push(work.resolve);
			let handlerSettled = false;
			let infrastructureClosed = false;
			const app = await boot(async () => {
				infrastructureClosed = true;
			});
			app.addHook("preClose", async () => closing.resolve());
			await app.register(async (child) => {
				child.route({
					method,
					url: "/synthetic-work",
					handler: async (request) => {
						request.raw.socket.once("close", socketClosed.resolve);
						started.resolve();
						try {
							await work.promise;
							if (settlement === "reject") throw new Error("Synthetic handler failure");
							return { ok: true };
						} finally {
							handlerSettled = true;
						}
					},
				});
			});
			const address = await app.listen({ host: "127.0.0.1", port: 0 });
			const request = httpRequest(`${address}/synthetic-work`, { method, agent: false });
			request.on("error", () => undefined); // Expected client abort, no raw diagnostics.
			request.end();
			await started.promise;
			request.destroy();
			await socketClosed.promise;
			const close = app.close();
			let closeSettled = false;
			void close.then(() => {
				closeSettled = true;
			});
			try {
				await closing.promise;
				await flushCloseCallbacks();
				expect(handlerSettled).toBe(false);
				expect(infrastructureClosed).toBe(false);
				expect(closeSettled).toBe(false);
			} finally {
				work.resolve();
				await close;
			}
			expect(handlerSettled).toBe(true);
			expect(infrastructureClosed).toBe(true);
		},
	);
});

it("does not release a handler when it sends its response before its remaining work", async () => {
	const work = deferred();
	const closing = deferred();
	releases.push(work.resolve);
	let infrastructureClosed = false;
	let handlerSettled = false;
	const app = await boot(async () => {
		infrastructureClosed = true;
	});
	app.addHook("preClose", async () => closing.resolve());
	app.get("/early-response", async (_request, reply) => {
		reply.send({ ok: true });
		await work.promise;
		handlerSettled = true;
	});
	expect((await app.inject("/early-response")).statusCode).toBe(200);
	const close = app.close();
	try {
		await closing.promise;
		await flushCloseCallbacks();
		expect(handlerSettled).toBe(false);
		expect(infrastructureClosed).toBe(false);
	} finally {
		work.resolve();
		await close;
	}
	expect(handlerSettled).toBe(true);
	expect(infrastructureClosed).toBe(true);
});

it("allows later preClose hooks to release work before the onClose drain", async () => {
	const work = deferred();
	releases.push(work.resolve);
	let handlerSettled = false;
	let settledAtTeardown = false;
	const app = await boot(async () => {
		settledAtTeardown = handlerSettled;
	});
	app.addHook("preClose", async () => work.resolve());
	app.get("/early-response", async (_request, reply) => {
		reply.send({ ok: true });
		await work.promise;
		handlerSettled = true;
	});
	expect((await app.inject("/early-response")).statusCode).toBe(200);
	await app.close();
	expect(settledAtTeardown).toBe(true);
});

it("drains every concurrent handler across duplicate closes, including a late rejection", async () => {
	const first = deferred();
	const second = deferred();
	const firstStarted = deferred();
	const secondStarted = deferred();
	const firstSettled = deferred();
	const closing = deferred();
	releases.push(first.resolve, second.resolve);
	let teardownCount = 0;
	const app = await boot(async () => {
		teardownCount++;
	});
	app.addHook("preClose", async () => closing.resolve());
	app.get("/first", async () => {
		firstStarted.resolve();
		await first.promise;
		firstSettled.resolve();
		return { ok: true };
	});
	app.post("/second", async () => {
		secondStarted.resolve();
		await second.promise;
		throw new Error("Synthetic late handler failure");
	});
	const responses = Promise.all([
		app.inject("/first"),
		app.inject({ method: "POST", url: "/second" }),
	]);
	await Promise.all([firstStarted.promise, secondStarted.promise]);
	expect(app.lifecycle.getShutdownStatus()).toEqual({ admissionClosed: false, pendingHandlers: 2 });
	const close = app.close();
	const duplicateClose = app.close();
	try {
		await closing.promise;
		expect(app.lifecycle.getShutdownStatus()).toEqual({
			admissionClosed: true,
			pendingHandlers: 2,
		});
		first.resolve();
		await firstSettled.promise;
		await flushCloseCallbacks();
		expect(app.lifecycle.getShutdownStatus()).toEqual({
			admissionClosed: true,
			pendingHandlers: 1,
		});
		expect(teardownCount).toBe(0);
	} finally {
		first.resolve();
		second.resolve();
		await Promise.all([close, duplicateClose]);
	}
	expect((await responses).map((response) => response.statusCode)).toEqual([200, 500]);
	expect(teardownCount).toBe(1);
	expect(app.lifecycle.getShutdownStatus()).toEqual({ admissionClosed: true, pendingHandlers: 0 });
});

it("refuses a late handler after its asynchronous preHandler resumes during close", async () => {
	const started = deferred();
	const releaseHook = deferred();
	const closing = deferred();
	releases.push(releaseHook.resolve);
	let executions = 0;
	const app = await boot(async () => undefined);
	app.addHook("preClose", async () => closing.resolve());
	app.get(
		"/late-handler",
		{
			preHandler: async () => {
				started.resolve();
				await releaseHook.promise;
			},
		},
		async () => {
			executions++;
			return { ok: true };
		},
	);
	const response = app.inject("/late-handler");
	await started.promise;
	const close = app.close();
	await closing.promise;
	releaseHook.resolve();
	expect((await response).statusCode).toBe(503);
	expect(executions).toBe(0);
	await close;
});

it.each(["synchronous", "asynchronous"] as const)(
	"releases a failing %s handler without changing its HTTP failure or hanging close",
	async (kind) => {
		let infrastructureClosed = false;
		const app = await boot(async () => {
			infrastructureClosed = true;
		});
		app.get(
			"/failure",
			kind === "synchronous"
				? () => {
						throw new Error("Synthetic synchronous failure");
					}
				: async () => {
						throw new Error("Synthetic asynchronous failure");
					},
		);
		expect((await app.inject("/failure")).statusCode).toBe(500);
		await app.close();
		expect(infrastructureClosed).toBe(true);
	},
);
