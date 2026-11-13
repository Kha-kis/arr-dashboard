import Fastify, { type FastifyInstance, type RouteHandlerMethod } from "fastify";
import { afterEach, expect, it } from "vitest";
import lifecyclePlugin from "../lifecycle.js";
import { installNonDatabaseRuntimeFixture } from "../../lib/__tests__/runtime-admission-fixture.js";
import { getRuntimeReadSource } from "../../lib/backup/restore-runtime-read-diagnostics.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function boot() {
	const app = Fastify({ logger: false });
	apps.push(app);
	installNonDatabaseRuntimeFixture(app);
	const original = app.restoreRuntime,
		boundaries: string[] = [];
	app.restoreRuntime = {
		...original,
		runOperation: async (operation) => {
			boundaries.push(getRuntimeReadSource());
			return original.runOperation(operation);
		},
	};
	await app.register(lifecyclePlugin);
	return { app, boundaries };
}

it("tags only the declared handler pattern and preserves this and trusted bypass branches", async () => {
	const { app, boundaries } = await boot();
	for (const [url, config] of [
		["/api/plex/watch-enrichment", {}],
		["/live", { runtimeLiveness: true }],
		["/api/backup/restore", { runtimeRestoreController: true }],
	] as const)
		app.get(url, { config }, function () {
			expect(this).toBe(app);
			return { source: getRuntimeReadSource(), ok: true };
		});
	expect(
		(
			await app.inject("/api/plex/watch-enrichment?runtimeLiveness=true&source=private-token")
		).json(),
	).toEqual({ source: "plex-watch", ok: true });
	expect((await app.inject("/live?source=plex-watch")).json()).toEqual({
		source: "other-http",
		ok: true,
	});
	expect((await app.inject("/api/backup/restore")).json()).toEqual({
		source: "other-http",
		ok: true,
	});
	expect(boundaries).toEqual(["plex-watch"]);
	expect(getRuntimeReadSource()).toBe("unscoped");
	expect(app.lifecycle.getShutdownStatus()).toEqual({ admissionClosed: false, pendingHandlers: 0 });
});

it("never reads request properties to classify, and retains exact async rejection", async () => {
	const { app, boundaries } = await boot();
	let wrapped!: RouteHandlerMethod;
	app.addHook("onRoute", (route) => {
		if (route.method === "POST") wrapped = route.handler;
	});
	const sentinel = new Error("synthetic-handler-failure");
	app.post("/api/jellyfin/series-progress", function () {
		expect(this).toBe(app);
		expect(getRuntimeReadSource()).toBe("jellyfin-series");
		return Promise.reject(sentinel);
	});
	await app.ready();
	const privateInput = new Proxy(
		{},
		{
			get() {
				throw new Error("request input read");
			},
		},
	);
	await expect(Reflect.apply(wrapped, app, [privateInput, privateInput])).rejects.toBe(sentinel);
	expect(boundaries).toEqual(["jellyfin-series"]);
	expect(getRuntimeReadSource()).toBe("unscoped");
	expect(app.lifecycle.getShutdownStatus().pendingHandlers).toBe(0);
});

it("keeps concurrently settled handlers in their own sources without changing successful bodies", async () => {
	const { app } = await boot();
	let release!: () => void;
	const held = new Promise<void>((done) => {
		release = done;
	});
	let ready!: () => void,
		count = 0;
	const both = new Promise<void>((done) => {
		ready = done;
	});
	for (const [url, expected] of [
		["/api/library/provider-inventory", "primary-inventory"],
		["/api/plex/sections", "plex-sections"],
	] as const)
		app.get(url, async function () {
			expect(this).toBe(app);
			expect(getRuntimeReadSource()).toBe(expected);
			if (++count === 2) ready();
			await held;
			expect(getRuntimeReadSource()).toBe(expected);
			return { ok: true };
		});
	const calls = [app.inject("/api/library/provider-inventory"), app.inject("/api/plex/sections")];
	try {
		await both;
		expect(app.lifecycle.getShutdownStatus().pendingHandlers).toBe(2);
		expect(getRuntimeReadSource()).toBe("unscoped");
	} finally {
		release();
	}
	for (const response of await Promise.all(calls)) {
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true });
	}
});
