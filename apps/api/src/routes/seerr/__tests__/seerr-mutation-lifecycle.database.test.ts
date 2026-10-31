import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSeerrMutationFixture } from "./fixtures/seerr-mutation-fixture.js";

let fixture: Awaited<ReturnType<typeof createSeerrMutationFixture>>;
beforeAll(async () => {
	fixture = await createSeerrMutationFixture();
});
beforeEach(async () => {
	await fixture.reset();
});
afterAll(async () => {
	if (fixture)
		expect(await fixture.close()).toEqual({ integrity: "ok", removed: true, providerClosed: true });
});
const send = (
	method: "POST" | "PUT" | "DELETE" | "GET",
	path: string,
	payload?: Record<string, unknown>,
) =>
	fixture.app.inject({
		method,
		url: `/api/seerr${path}`,
		...(payload === undefined ? {} : { payload }),
	});
const providerWrites = () => fixture.events.filter((event) => event.method !== "GET");

describe("Seerr mutation admission and joined native audit", () => {
	it("refuses a disabled owned connection before any provider HTTP", async () => {
		await fixture.run(() =>
			fixture.prisma.serviceInstance.update({ where: { id: "seerr-a" }, data: { enabled: false } }),
		);
		expect((await send("DELETE", "/requests/seerr-a/41")).statusCode).toBe(404);
		expect(fixture.events).toHaveLength(0);
		expect(fixture.requests.has("seerr-a:41")).toBe(true);
	});
	for (const action of ["approve", "decline", "delete"] as const) {
		it(`joins both ${action} audit writes before the real handler ticket ends`, async () => {
			const response = await send("POST", "/requests/seerr-a/bulk", {
				action,
				requestIds: [41, 42],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ totalSuccess: 2, totalFailed: 0, totalUnknown: 0 });
			expect(providerWrites()).toHaveLength(2);
			expect(fixture.accepted).toHaveLength(2);
			expect(
				(await fixture.audit()).map((row) => ({ targetId: row.targetId, success: row.success })),
			).toEqual([
				{ targetId: "41", success: true },
				{ targetId: "42", success: true },
			]);
			expect(
				fixture.logs.filter((entry) => entry.msg === "Failed to log Seerr action"),
			).toHaveLength(0);
			expect(fixture.requests.get("seerr-b:41")?.status).toBe(1);
		});
	}
	it("joins unknown and successful audit outcomes without replaying an accepted action", async () => {
		fixture.fail({ method: "POST", path: "/api/v1/request/42/approve", loseAcceptedReply: true });
		const response = await send("POST", "/requests/seerr-a/bulk", {
			action: "approve",
			requestIds: [41, 42],
		});
		expect(response.statusCode).toBe(207);
		expect(response.json()).toMatchObject({ totalSuccess: 1, totalFailed: 0, totalUnknown: 1 });
		expect(providerWrites()).toHaveLength(2);
		expect(fixture.accepted).toHaveLength(2);
		expect(
			(await fixture.audit()).map((row) => ({
				targetId: row.targetId,
				success: row.success,
				detail: row.detail,
			})),
		).toEqual([
			{ targetId: "41", success: true, detail: null },
			{ targetId: "42", success: false, detail: '{"outcome":"unknown"}' },
		]);
	});
	it("keeps acknowledged provider success after actual SQLite audit rejection without another mutation", async () => {
		await fixture.failFinalAudit();
		const response = await send("POST", "/requests/seerr-a/bulk", {
			action: "approve",
			requestIds: [41, 42],
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ totalSuccess: 2, totalFailed: 0, totalUnknown: 0 });
		expect(providerWrites()).toHaveLength(2);
		expect(fixture.accepted).toHaveLength(2);
		expect((await fixture.audit()).map((row) => row.targetId)).toEqual(["41"]);
		const warnings = fixture.logs.filter((entry) => entry.msg === "Failed to log Seerr action");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.entry?.targetId).toBe("42");
		// Prisma normalizes SQLite's trigger constraint; this must reach SQL,
		// rather than fail after the handler's native ticket was released.
		expect(warnings[0]?.err?.name).toBe("PrismaClientKnownRequestError");
		expect(warnings[0]?.err?.message).toMatch(/constraint/i);
	});
});

describe("Seerr mutation cache readback", () => {
	it("refreshes only the selected notification cache after an accepted write loses its reply", async () => {
		await send("GET", "/notifications/seerr-a");
		await send("GET", "/notifications/seerr-b");
		fixture.events.length = 0;
		fixture.fail({
			method: "POST",
			path: "/api/v1/settings/notifications/discord",
			loseAcceptedReply: true,
		});
		const response = await send("POST", "/notifications/seerr-a/discord", { enabled: true });
		expect(response.statusCode).toBe(502);
		expect(response.json().message).toMatch(/outcome is unknown/i);
		expect(providerWrites()).toHaveLength(1);
		expect(fixture.accepted).toHaveLength(1);
		fixture.clearFailure();
		const read = await send("GET", "/notifications/seerr-a");
		expect(read.json().agents.find((agent: { id: string }) => agent.id === "discord").enabled).toBe(
			true,
		);
		expect(
			(await send("GET", "/notifications/seerr-b"))
				.json()
				.agents.find((agent: { id: string }) => agent.id === "discord").enabled,
		).toBe(false);
		expect(fixture.events.every((event) => event.instance === "seerr-a")).toBe(true);
		expect(
			fixture.events.filter(
				(event) => event.method === "GET" && event.path.includes("/settings/notifications/"),
			),
		).toHaveLength(11);
	});
	it("preserves a warmed notification cache after definite provider rejection", async () => {
		await send("GET", "/notifications/seerr-a");
		fixture.events.length = 0;
		fixture.fail({ method: "POST", path: "/api/v1/settings/notifications/discord", reject: 422 });
		expect(
			(await send("POST", "/notifications/seerr-a/discord", { enabled: true })).statusCode,
		).toBe(422);
		const read = await send("GET", "/notifications/seerr-a");
		expect(read.json().agents.find((agent: { id: string }) => agent.id === "discord").enabled).toBe(
			false,
		);
		expect(fixture.accepted).toHaveLength(0);
		expect(
			fixture.events.filter(
				(event) => event.path.includes("/settings/notifications/") && event.method === "GET",
			),
		).toHaveLength(0);
	});
	for (const loseAcceptedReply of [false, true]) {
		it(`refreshes exact issue counts after ${loseAcceptedReply ? "an uncertain" : "an acknowledged"} resolution and preserves peer cache`, async () => {
			const url = "/library-enrichment/seerr-a?tmdbIds=1041&types=tv";
			expect((await send("GET", url)).json().items["tv:1041"].openIssueCount).toBe(1);
			fixture.app.seerrCache.set("issue_counts:seerr-b", new Map([["tv:1041", 7]]), 10000);
			if (loseAcceptedReply)
				fixture.fail({
					method: "POST",
					path: "/api/v1/issue/41/resolved",
					loseAcceptedReply: true,
				});
			const response = await send("PUT", "/issues/seerr-a/41", { status: "resolved" });
			expect(response.statusCode).toBe(loseAcceptedReply ? 502 : 200);
			if (loseAcceptedReply) expect(response.json().message).toMatch(/outcome is unknown/i);
			expect(providerWrites()).toHaveLength(1);
			expect(fixture.accepted).toHaveLength(1);
			fixture.clearFailure();
			const read = await send("GET", url);
			expect(read.statusCode).toBe(200);
			expect(read.json().items["tv:1041"].openIssueCount).toBe(0);
			expect(fixture.app.seerrCache.get("issue_counts:seerr-b")).toEqual(new Map([["tv:1041", 7]]));
			expect(
				(await fixture.audit()).map((row) => ({ success: row.success, detail: row.detail })),
			).toEqual([
				{
					success: !loseAcceptedReply,
					detail: loseAcceptedReply ? '{"outcome":"unknown"}' : '{"status":"resolved"}',
				},
			]);
		});
	}
});

async function seedStoredDiagnostics(instanceId = "seerr-a", disable = true) {
	await fixture.run(async () => {
		const instance = await fixture.prisma.serviceInstance.findUniqueOrThrow({
			where: { id: instanceId },
		});
		await fixture.prisma.seerrActionLog.create({
			data: {
				id: `synthetic-diagnostic-${instanceId}`,
				instanceId,
				userId: instance.userId,
				action: "approve_request",
				targetType: "request",
				targetId: "41",
				success: false,
				detail: '{"outcome":"unknown"}',
				createdAt: new Date("2026-01-02T03:04:05.000Z"),
			},
		});
		await fixture.prisma.cacheRefreshStatus.create({
			data: {
				instanceId,
				cacheType: "seerr_health",
				lastResult: "error",
				lastRefreshedAt: new Date("2026-01-02T03:04:05.000Z"),
				lastErrorMessage: "Synthetic retained health error",
			},
		});
		if (disable)
			await fixture.prisma.serviceInstance.update({
				where: { id: instanceId },
				data: { enabled: false },
			});
	});
}

describe("disabled connection diagnostic compatibility", () => {
	it("returns retained owned audit rows after disablement without provider HTTP", async () => {
		await seedStoredDiagnostics();
		await seedStoredDiagnostics("seerr-b");
		const response = await send("GET", "/status/seerr-a/audit");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([
			{
				id: "synthetic-diagnostic-seerr-a",
				action: "approve_request",
				targetType: "request",
				targetId: "41",
				detail: { outcome: "unknown" },
				success: false,
				createdAt: "2026-01-02T03:04:05.000Z",
			},
		]);
		expect(fixture.events).toHaveLength(0);
		expect((await fixture.audit()).map((row) => row.instanceId).sort()).toEqual([
			"seerr-a",
			"seerr-b",
		]);
	});
	it("returns retained owned cached health after disablement while mutations stay refused", async () => {
		await seedStoredDiagnostics();
		const response = await send("GET", "/status/seerr-a/health");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			status: "error",
			lastCheckedAt: "2026-01-02T03:04:05.000Z",
			error: "Synthetic retained health error",
		});
		expect((await send("DELETE", "/requests/seerr-a/41")).statusCode).toBe(404);
		expect(fixture.events).toHaveLength(0);
		expect(fixture.requests.has("seerr-a:41")).toBe(true);
	});
	it("preserves disabled read compatibility through the existing notification client", async () => {
		await seedStoredDiagnostics();
		const response = await send("GET", "/notifications/seerr-a");
		expect(response.statusCode).toBe(200);
		expect(response.json().agents).toHaveLength(11);
		expect(fixture.events).toHaveLength(11);
		expect(
			fixture.events.every((event) => event.method === "GET" && event.instance === "seerr-a"),
		).toBe(true);
		expect(fixture.accepted).toHaveLength(0);
	});
	it("allows owned disabled local cache clearing while preserving the peer cache", async () => {
		await seedStoredDiagnostics();
		fixture.app.seerrCache.set("issue_counts:seerr-a", new Map([["tv:1041", 1]]), 10000);
		fixture.app.seerrCache.set("issue_counts:seerr-b", new Map([["tv:1041", 2]]), 10000);
		const response = await send("POST", "/status/seerr-a/cache/clear");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ cleared: 1 });
		expect(fixture.app.seerrCache.get("issue_counts:seerr-a")).toBeUndefined();
		expect(fixture.app.seerrCache.get("issue_counts:seerr-b")).toEqual(new Map([["tv:1041", 2]]));
		expect(fixture.events).toHaveLength(0);
	});
	it("denies missing and foreign stored diagnostic reads before provider HTTP", async () => {
		const foreign = await fixture.run(() =>
			fixture.prisma.user.create({ data: { username: "synthetic-diagnostic-other" } }),
		);
		await fixture.run(() =>
			fixture.prisma.serviceInstance.update({
				where: { id: "seerr-b" },
				data: { userId: foreign.id },
			}),
		);
		await seedStoredDiagnostics("seerr-b");
		for (const instance of ["missing", "seerr-b"])
			for (const route of ["audit", "health"]) {
				expect((await send("GET", `/status/${instance}/${route}`)).statusCode).toBe(404);
			}
		expect(fixture.events).toHaveLength(0);
		expect(await fixture.audit()).toHaveLength(1);
	});
	it("retains service-type denial for stored diagnostic reads", async () => {
		await seedStoredDiagnostics("seerr-a", false);
		await fixture.run(() =>
			fixture.prisma.serviceInstance.update({
				where: { id: "seerr-a" },
				data: { service: "RADARR" },
			}),
		);
		for (const route of ["audit", "health"])
			expect((await send("GET", `/status/seerr-a/${route}`)).statusCode).toBe(400);
		expect(fixture.events).toHaveLength(0);
	});
});

describe("notification read coverage", () => {
	it("caches complete verified configuration without another provider read", async () => {
		const response = await send("GET", "/notifications/seerr-a");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ coverage: "complete", unavailableAgents: [] });
		expect(response.json().agents).toHaveLength(11);
		const count = fixture.events.length;
		expect((await send("GET", "/notifications/seerr-a")).json()).toEqual(response.json());
		expect(fixture.events).toHaveLength(count);
		expect(providerWrites()).toHaveLength(0);
	});
	it("skips only genuine unsupported 404 and caches that complete result", async () => {
		fixture.failNotificationRead("discord", 404);
		const response = await send("GET", "/notifications/seerr-a");
		expect(response.json()).toMatchObject({ coverage: "complete", unavailableAgents: [] });
		expect(response.json().agents).toHaveLength(10);
		const count = fixture.events.length;
		await send("GET", "/notifications/seerr-a");
		expect(fixture.events).toHaveLength(count);
		expect(providerWrites()).toHaveLength(0);
	});
	it("keeps verified agents but marks a 503 read partial without caching it", async () => {
		fixture.failNotificationRead("discord", 503);
		const response = await send("GET", "/notifications/seerr-a");
		expect(response.json()).toMatchObject({
			coverage: "partial",
			unavailableAgents: [{ id: "discord", name: "Discord" }],
		});
		expect(response.json().agents).toHaveLength(10);
		expect(response.json().agents.some((agent: { id: string }) => agent.id === "discord")).toBe(
			false,
		);
		expect(response.body).not.toContain("Synthetic private provider detail");
		expect(fixture.app.seerrCache.get("notification-agents:seerr-a")).toBeUndefined();
		expect(providerWrites()).toHaveLength(0);
	});
	it("reports unavailable rather than complete empty when all supported reads fail", async () => {
		fixture.failNotificationRead("*", 403);
		const response = await send("GET", "/notifications/seerr-a");
		expect(response.json()).toMatchObject({ coverage: "unavailable", agents: [] });
		expect(response.json().unavailableAgents).toHaveLength(11);
		expect(fixture.app.seerrCache.get("notification-agents:seerr-a")).toBeUndefined();
		expect(providerWrites()).toHaveLength(0);
	});
	it("marks malformed supported-agent payload unavailable without inventing configuration", async () => {
		fixture.failNotificationRead("discord", "malformed");
		const response = await send("GET", "/notifications/seerr-a");
		expect(response.json()).toMatchObject({
			coverage: "partial",
			unavailableAgents: [{ id: "discord", name: "Discord" }],
		});
		expect(response.json().agents).toHaveLength(10);
		expect(fixture.app.seerrCache.get("notification-agents:seerr-a")).toBeUndefined();
		expect(providerWrites()).toHaveLength(0);
	});
	it("fresh explicit recovery restores the missing agent and conserves peer cache", async () => {
		const peer = (await send("GET", "/notifications/seerr-b")).json();
		fixture.failNotificationRead("discord", 503);
		expect((await send("GET", "/notifications/seerr-a")).json().coverage).toBe("partial");
		fixture.clearNotificationReadFailures();
		const before = fixture.events.length;
		const recovered = (await send("GET", "/notifications/seerr-a")).json();
		expect(recovered).toMatchObject({ coverage: "complete", unavailableAgents: [] });
		expect(recovered.agents).toHaveLength(11);
		expect(fixture.events.length - before).toBe(11);
		const after = fixture.events.length;
		expect((await send("GET", "/notifications/seerr-b")).json()).toEqual(peer);
		expect(fixture.events).toHaveLength(after);
		expect(providerWrites()).toHaveLength(0);
	});
	it("treats all genuine 404s as supported-complete empty, not unavailable", async () => {
		fixture.failNotificationRead("*", 404);
		expect((await send("GET", "/notifications/seerr-a")).json()).toEqual({
			agents: [],
			coverage: "complete",
			unavailableAgents: [],
		});
		expect(fixture.app.seerrCache.get("notification-agents:seerr-a")).toBeDefined();
		expect(providerWrites()).toHaveLength(0);
	});
});
