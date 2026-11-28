import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSabnzbdRoutes } from "../sabnzbd.js";

const sabInstance = {
	id: "sab-instance-1",
	userId: "owner-1",
	service: "SABNZBD",
	label: "Downloads",
	baseUrl: "http://sab.example/base",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv",
	enabled: true,
	isDefault: true,
	createdAt: new Date("2026-11-28T00:00:00Z"),
};

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function buildApp(instances = [sabInstance]) {
	const app = fastify();
	const findMany = vi.fn().mockResolvedValue(instances);
	const findFirst = vi
		.fn()
		.mockImplementation(async ({ where }: { where: { userId: string; id: string } }) =>
			where.userId === sabInstance.userId
				? (instances.find((instance) => instance.id === where.id) ?? null)
				: null,
		);
	app.decorate("prisma", { serviceInstance: { findMany, findFirst } } as never);
	app.decorate("encryptor", {
		decrypt: vi.fn(({ value }: { value: string }) =>
			value === "encrypted-http-auth"
				? JSON.stringify({ v: 1, username: "proxy-user", password: "proxy-password" })
				: "synthetic-api-key",
		),
	} as never);
	app.addHook("preHandler", async (request) => {
		Object.assign(request, { currentUser: { id: "owner-1" } });
	});
	await app.register(registerSabnzbdRoutes, { prefix: "/api/sabnzbd" });
	return { app, findMany, findFirst };
}

describe("SABnzbd read routes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("keeps proxy Basic authentication on global action readback", async () => {
		const instance = {
			...sabInstance,
			encryptedHttpAuthCredentials: "encrypted-http-auth",
			httpAuthEncryptionIv: "http-auth-iv",
		};
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`,
			);
			if (url.searchParams.get("mode") === "pause") return jsonResponse({ status: true });
			if (url.searchParams.get("mode") === "queue")
				return jsonResponse({ queue: { paused_all: true, noofslots: 0, slots: [] } });
			return jsonResponse({ error: "unexpected request" });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp([instance]);
		const response = await app.inject({ method: "POST", url: "/api/sabnzbd/sab-instance-1/pause" });
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ outcome: "verified" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("returns a bounded safe multi-observation projection for owned instances", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					queue: {
						version: "5.1.3",
						status: "Downloading",
						paused_all: true,
						speed: "1.2 M",
						kbpersec: "1228.8",
						sizeleft: "2.4 GB",
						timeleft: "0:20:00",
						diskspace1: "10 GB",
						diskspacetotal1: "20 GB",
						noofslots: 2,
						noofslots_total: 2,
						slots: [
							{
								nzo_id: "36-character-opaque-id-000000000001",
								filename: "/private/downloads/Synthetic.Nzb.File",
								status: "Paused",
								size: "2.4 GB",
								sizeleft: "2.0 GB",
								timeleft: "0:20:00",
								percentage: "16",
								cat: "tv",
								priority: "Normal",
							},
							{
								nzo_id: "36-character-opaque-id-000000000002",
								filename: "Second.Synthetic.Item",
								status: "Queued",
							},
						],
					},
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					history: {
						noofslots: 1,
						slots: [
							{
								nzo_id: "36-character-opaque-id-000000000003",
								name: "Synthetic.Failed.Item",
								status: "Failed",
								size: "700 MB",
								completed: 1795820000,
								fail_message: "Synthetic fixture failure",
								category: "tv",
								path: "/private/history/path",
								stage_log: [{ actions: ["private"] }],
							},
						],
					},
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ warnings: [{ text: "Warning in /private/config" }] }))
			.mockResolvedValueOnce(jsonResponse({ categories: ["*", "tv"] }));
		vi.stubGlobal("fetch", fetchMock);
		const { app, findMany } = await buildApp();

		const response = await app.inject({ method: "GET", url: "/api/sabnzbd" });
		const body = response.json();
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "owner-1", service: "SABNZBD", enabled: true },
			}),
		);
		expect(body.configured).toBe(true);
		expect(body.instances[0]).toMatchObject({
			id: "sab-instance-1",
			reachable: true,
			version: "5.1.3",
			paused: true,
			queueCount: 2,
			pausedJobs: 1,
			failedRecent: 1,
			queueCoverage: "complete",
			historyCoverage: "complete",
		});
		expect(body.instances[0].queue[0].nzoId).toBe("36-character-opaque-id-000000000001");
		expect(body.instances[0].warnings[0].text).toBe("SABnzbd reported a warning.");
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("synthetic-api-key");
		expect(serialized).not.toContain("private");
		expect(serialized).not.toContain("stage_log");
		for (const [, options] of fetchMock.mock.calls) {
			expect(options.redirect).toBe("error");
		}
	});

	it("returns explicit unavailable coverage instead of treating malformed data as an empty result", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ queue: {} }))
			.mockResolvedValueOnce(jsonResponse({ history: {} }))
			.mockResolvedValueOnce(jsonResponse({ warnings: [] }))
			.mockResolvedValueOnce(jsonResponse({ categories: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();

		const response = await app.inject({ method: "GET", url: "/api/sabnzbd" });
		const instance = response.json().instances[0];
		await app.close();

		expect(instance.reachable).toBe(true);
		expect(instance.queue).toEqual([]);
		expect(instance.history).toEqual([]);
		expect(instance.queueCoverage).toBe("unavailable");
		expect(instance.historyCoverage).toBe("unavailable");
		expect(instance.error).toContain("temporarily unavailable");
	});

	it("keeps malformed provider totals partial instead of inventing complete empty coverage", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ queue: { noofslots_total: "", slots: [] } }))
			.mockResolvedValueOnce(jsonResponse({ history: { noofslots: "", slots: [] } }))
			.mockResolvedValueOnce(jsonResponse({ warnings: [] }))
			.mockResolvedValueOnce(jsonResponse({ categories: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();

		const instance = (await app.inject({ method: "GET", url: "/api/sabnzbd" })).json().instances[0];
		await app.close();

		expect(instance.queueCoverage).toBe("partial");
		expect(instance.historyCoverage).toBe("partial");
	});

	it("rejects non-string provider job identities rather than coercing them", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ queue: { noofslots_total: 1, slots: [{ nzo_id: 123 }] } }),
			)
			.mockResolvedValueOnce(jsonResponse({ history: { noofslots: 1, slots: [{ nzo_id: 123 }] } }))
			.mockResolvedValueOnce(jsonResponse({ warnings: [] }))
			.mockResolvedValueOnce(jsonResponse({ categories: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const instance = (await app.inject({ method: "GET", url: "/api/sabnzbd" })).json().instances[0];
		await app.close();
		expect(instance.queueCoverage).toBe("unavailable");
		expect(instance.historyCoverage).toBe("unavailable");
	});

	it("marks truncated queue and history observations partial", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ queue: { noofslots_total: 101, slots: [] } }))
			.mockResolvedValueOnce(jsonResponse({ history: { noofslots: 200, slots: [] } }))
			.mockResolvedValueOnce(jsonResponse({ warnings: [] }))
			.mockResolvedValueOnce(jsonResponse({ categories: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();

		const instance = (await app.inject({ method: "GET", url: "/api/sabnzbd" })).json().instances[0];
		await app.close();

		expect(instance.queueCoverage).toBe("partial");
		expect(instance.historyCoverage).toBe("partial");
	});

	it("does not claim a 100-row first page is complete when the provider reports more jobs", async () => {
		const slots = Array.from({ length: 100 }, (_, index) => ({ nzo_id: `opaque-${index}` }));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ queue: { noofslots_total: 101, slots } }))
			.mockResolvedValueOnce(jsonResponse({ history: { noofslots: 0, slots: [] } }))
			.mockResolvedValueOnce(jsonResponse({ warnings: [] }))
			.mockResolvedValueOnce(jsonResponse({ categories: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const instance = (await app.inject({ method: "GET", url: "/api/sabnzbd" })).json().instances[0];
		await app.close();
		expect(instance.queue).toHaveLength(100);
		expect(instance.queueCount).toBe(101);
		expect(instance.queueCoverage).toBe("partial");
	});

	it("rejects duplicate or malformed item identities and bounds extreme completion dates", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					queue: { noofslots_total: 2, slots: [{ nzo_id: "dup" }, { nzo_id: "dup" }] },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					history: {
						noofslots: 1,
						slots: [
							{
								nzo_id: "hist-1",
								status: "Failed",
								completed: 1e100,
								fail_message: "/private/secret",
							},
						],
					},
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ warnings: [] }))
			.mockResolvedValueOnce(jsonResponse({ categories: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const instance = (await app.inject({ method: "GET", url: "/api/sabnzbd" })).json().instances[0];
		await app.close();
		expect(instance.queueCoverage).toBe("unavailable");
		expect(instance.historyCoverage).toBe("complete");
		expect(instance.history[0].completedAt).toBe("");
		expect(instance.history[0].failMessage).toBe("SABnzbd marked this job as failed.");
		expect(JSON.stringify(instance)).not.toContain("/private/secret");
	});

	it("pages owner-scoped history with a hard provider limit and reports coverage", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				history: {
					noofslots: 2,
					slots: [
						{
							nzo_id: "36-character-opaque-id-000000000002",
							name: "Second.Synthetic.Item",
							status: "Completed",
							completed: 1795820000,
						},
					],
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { app, findFirst } = await buildApp();

		const response = await app.inject({
			method: "GET",
			url: "/api/sabnzbd/sab-instance-1/history?start=1&limit=1",
		});
		const body = response.json();
		await app.close();

		expect(response.statusCode).toBe(200);
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "sab-instance-1", userId: "owner-1", service: "SABNZBD", enabled: true },
			}),
		);
		expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("start")).toBe("1");
		expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("limit")).toBe("1");
		expect(body.start).toBe(1);
		expect(body.coverage).toBe("complete");
		expect(body.items[0].nzoId).toBe("36-character-opaque-id-000000000002");
	});

	it("retries one exact failed item once and requires the new identity plus old-history disappearance", async () => {
		const oldId = "failed-job-id";
		const replacementId = "replacement-job-id";
		let retried = false;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const mode = url.searchParams.get("mode");
			const nzoIds = url.searchParams.get("nzo_ids");
			if (mode === "history" && nzoIds === oldId) {
				return jsonResponse({
					history: {
						noofslots: retried ? 0 : 1,
						slots: retried ? [] : [{ nzo_id: oldId, status: "Failed" }],
					},
				});
			}
			if (mode === "retry") {
				retried = true;
				return jsonResponse({ status: true, nzo_id: replacementId });
			}
			if (mode === "queue" && nzoIds === replacementId) {
				return jsonResponse({
					queue: {
						noofslots: 1,
						noofslots_total: 1,
						slots: [{ nzo_id: replacementId, status: "Queued" }],
					},
				});
			}
			return jsonResponse({ error: "unexpected synthetic request" });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const response = await app.inject({
			method: "POST",
			url: `/api/sabnzbd/sab-instance-1/history/${oldId}/retry`,
		});
		const body = response.json();
		await app.close();
		expect(response.statusCode).toBe(200);
		expect(body).toMatchObject({ outcome: "verified", replacementId });
		expect(
			fetchMock.mock.calls.filter(
				([input]) => new URL(String(input)).searchParams.get("mode") === "retry",
			),
		).toHaveLength(1);
	});

	it("requires explicit item-delete confirmation and always preserves downloaded files", async () => {
		const jobId = "job-to-remove";
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.searchParams.get("mode") === "queue" && url.searchParams.get("name") === "delete") {
				expect(url.searchParams.get("del_files")).toBe("0");
				return jsonResponse({ status: true });
			}
			if (url.searchParams.get("mode") === "queue")
				return jsonResponse({
					queue: { noofslots: 1, noofslots_total: 1, slots: [{ nzo_id: jobId, status: "Queued" }] },
				});
			return jsonResponse({});
		});
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const refused = await app.inject({
			method: "POST",
			url: `/api/sabnzbd/sab-instance-1/jobs/${jobId}`,
			payload: { action: "delete" },
		});
		expect(refused.statusCode).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
		await app.close();
	});

	it("verifies one exact queue removal only after explicit empty filtered readback", async () => {
		const jobId = "queue-job-to-remove";
		let removed = false;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.searchParams.get("mode") === "queue" && url.searchParams.get("name") === "delete") {
				expect(url.searchParams.get("value")).toBe(jobId);
				expect(url.searchParams.get("del_files")).toBe("0");
				removed = true;
				return jsonResponse({ status: true });
			}
			if (url.searchParams.get("mode") === "queue")
				return jsonResponse({
					queue: {
						noofslots: removed ? 0 : 1,
						noofslots_total: 3,
						slots: removed ? [] : [{ nzo_id: jobId, status: "Queued" }],
					},
				});
			return jsonResponse({});
		});
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const response = await app.inject({
			method: "POST",
			url: `/api/sabnzbd/sab-instance-1/jobs/${jobId}`,
			payload: { action: "delete", confirmed: true },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ outcome: "verified" });
		await app.close();
	});

	it("does not treat a missing queue pause flag as verified resumed state", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ status: true }))
			.mockResolvedValueOnce(
				jsonResponse({ queue: { noofslots: 0, noofslots_total: 0, slots: [] } }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const response = await app.inject({
			method: "POST",
			url: "/api/sabnzbd/sab-instance-1/resume",
		});
		expect(response.statusCode).toBe(202);
		expect(response.json()).toMatchObject({ outcome: "unconfirmed" });
		await app.close();
	});

	it("removes one exact history item without deleting files and verifies its absence", async () => {
		const jobId = "failed-history-item";
		let removed = false;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.searchParams.get("mode") === "history" && url.searchParams.get("name") === "delete") {
				expect(url.searchParams.get("value")).toBe(jobId);
				expect(url.searchParams.get("archive")).toBe("0");
				expect(url.searchParams.get("del_files")).toBe("0");
				removed = true;
				return jsonResponse({ status: true });
			}
			if (url.searchParams.get("mode") === "history")
				return jsonResponse({
					history: {
						noofslots: removed ? 0 : 1,
						noofslots_total: 2,
						slots: removed ? [] : [{ nzo_id: jobId, status: "Failed" }],
					},
				});
			return jsonResponse({});
		});
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const response = await app.inject({
			method: "POST",
			url: `/api/sabnzbd/sab-instance-1/history/${jobId}/remove`,
			payload: { confirmed: true },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ outcome: "verified" });
		expect(
			fetchMock.mock.calls.filter(
				([input]) => new URL(String(input)).searchParams.get("name") === "delete",
			),
		).toHaveLength(1);
		await app.close();
	});

	it("does not replay a retry whose provider receipt is uncertain", async () => {
		const jobId = "failed-history-item";
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.searchParams.get("mode") === "retry") return jsonResponse({ status: true });
			if (url.searchParams.get("mode") === "history")
				return jsonResponse({
					history: {
						noofslots: 1,
						noofslots_total: 1,
						slots: [{ nzo_id: jobId, status: "Failed" }],
					},
				});
			return jsonResponse({});
		});
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();
		const response = await app.inject({
			method: "POST",
			url: `/api/sabnzbd/sab-instance-1/history/${jobId}/retry`,
		});
		expect(response.statusCode).toBe(202);
		expect(
			fetchMock.mock.calls.filter(
				([input]) => new URL(String(input)).searchParams.get("mode") === "retry",
			),
		).toHaveLength(1);
		await app.close();
	});

	it("does not request provider data when an instance belongs to another user", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { app } = await buildApp();

		const response = await app.inject({
			method: "GET",
			url: "/api/sabnzbd/not-owned/history",
		});
		await app.close();

		expect(response.statusCode).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
