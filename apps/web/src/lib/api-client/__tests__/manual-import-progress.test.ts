import { afterEach, describe, expect, it, vi } from "vitest";
import * as dashboard from "../dashboard";
import {
	fetchManualImportLegacyProgress,
	fetchManualImportSourceProgress,
	performQueueAction,
	submitManualImport,
} from "../dashboard";

const payload = {
	instanceId: "instance",
	service: "radarr" as const,
	importMode: "auto" as const,
	idempotencyKey: "attempt-1",
	files: [{ path: "/synthetic/private-file", downloadId: "source", movieId: 12 }],
};
const status = {
	operationId: "operation-1",
	state: "pending",
	reason: null,
	selectedFileCount: 1,
	verifiedFileCount: 0,
	canConsiderNewAttempt: false,
};
afterEach(() => vi.unstubAllGlobals());
describe("explicit remaining-candidate review client", () => {
	const query = { instanceId: "instance", service: "radarr" as const, downloadId: "source/+&?" };
	const review = {
		operation: { ...status, state: "failed", canConsiderNewAttempt: true },
		importMode: "copy",
		sourceFileCount: 1,
		sourceVerifiedFileCount: 0,
		verifiedEpisodeCount: 0,
		unavailableFileCount: 1,
		candidates: [],
	};
	it("uses one scoped provider-read GET, not a new import command", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(review), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		expect(await dashboard.fetchManualImportRemainderReview("operation-1", query)).toEqual(review);
		expect(fetch).toHaveBeenCalledWith(
			"/api/manual-import/operations/operation-1/remainder?instanceId=instance&service=radarr&downloadId=source%2F%2B%26%3F",
			expect.objectContaining({ method: "GET", body: undefined, credentials: "include" }),
		);
	});
	it.each([
		{ ...review, operation: { ...review.operation, operationId: "foreign" } },
		{ ...review, unavailableFileCount: 0 },
		{ ...review, permissionToImport: true },
	])("contains mismatched, inconsistent or authority-bearing proposals", async (body) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
		await expect(dashboard.fetchManualImportRemainderReview("operation-1", query)).rejects.toThrow(
			"Remaining-file review is unavailable.",
		);
	});
	it.each([404, 503])(
		"contains private %s errors and preserves their generic status",
		async (code) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ error: "synthetic-private-provider-error" }), {
						status: code,
					}),
				),
			);
			await expect(
				dashboard.fetchManualImportRemainderReview("operation-1", query),
			).rejects.toMatchObject({
				status: code,
				message: "Remaining-file review is unavailable.",
				payload: undefined,
			});
		},
	);
});

describe("Cached legacy progress client", () => {
	const query = { instanceId: "instance", service: "radarr" as const, downloadId: "source/+&?" };
	it.each([
		{ kind: "none" },
		{ kind: "unavailable", reason: "evidence-unavailable" },
		{ kind: "observed", operation: status },
	])("preserves the closed $kind result through the scoped GET", async (body) => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		expect(await fetchManualImportLegacyProgress(query)).toEqual(body);
		expect(fetch).toHaveBeenCalledWith(
			"/api/manual-import/legacy?instanceId=instance&service=radarr&downloadId=source%2F%2B%26%3F",
			expect.objectContaining({ credentials: "include" }),
		);
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", body: undefined });
	});
	it.each([
		undefined,
		{ kind: "none", path: "/private" },
		{ kind: "unavailable", reason: "private provider error" },
		{ kind: "observed", operation: { ...status, state: "completed" } },
		{ kind: "observed", operation: { ...status, selectedFileCount: 0 } },
	])("rejects malformed/private results with a generic error %#", async (body) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(body === undefined ? null : JSON.stringify(body), {
					status: body === undefined ? 204 : 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		await expect(fetchManualImportLegacyProgress(query)).rejects.toThrow(
			"Cached legacy import progress is unavailable.",
		);
	});
	it.each(["", " source", "x".repeat(1025)])(
		"rejects a malformed source before sending GET %#",
		async (downloadId) => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			await expect(fetchManualImportLegacyProgress({ ...query, downloadId })).rejects.toThrow(
				"Cached legacy import progress is unavailable.",
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it.each([404, 503])(
		"contains private %s errors while retaining the generic status",
		async (httpStatus) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ error: "private provider details" }), {
						status: httpStatus,
						headers: { "content-type": "application/json" },
					}),
				),
			);
			await expect(fetchManualImportLegacyProgress(query)).rejects.toMatchObject({
				status: httpStatus,
				message: "Cached legacy import progress is unavailable.",
				payload: undefined,
			});
		},
	);
});

describe("cached source discovery client", () => {
	it("validates bounded history and encodes its opaque cursor without a request body", async () => {
		const body = { kind: "history", operations: [status], nextCursor: status.operationId };
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		expect(
			await fetchManualImportSourceProgress({
				instanceId: "instance",
				service: "radarr",
				downloadId: "source",
				cursor: "page/+&?",
			}),
		).toEqual(body);
		expect(fetch).toHaveBeenCalledWith(
			"/api/manual-import/source?instanceId=instance&service=radarr&downloadId=source&cursor=page%2F%2B%26%3F",
			expect.objectContaining({ method: "GET", body: undefined }),
		);
	});
	it("reads tracked progress by source without a browser key or request body", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ kind: "observed", operation: status }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		expect(
			await fetchManualImportSourceProgress({
				instanceId: "instance",
				service: "radarr",
				downloadId: "source/+&?",
			}),
		).toEqual({ kind: "observed", operation: status });
		expect(fetch).toHaveBeenCalledWith(
			"/api/manual-import/source?instanceId=instance&service=radarr&downloadId=source%2F%2B%26%3F",
			expect.objectContaining({ method: "GET", body: undefined, credentials: "include" }),
		);
	});
	it.each([200, 503])("contains malformed or private %s evidence", async (httpStatus) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ kind: "none", error: "private details" }), {
					status: httpStatus,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		await expect(
			fetchManualImportSourceProgress({
				instanceId: "instance",
				service: "radarr",
				downloadId: "source",
			}),
		).rejects.toThrow("Cached import progress is unavailable.");
	});
	it("rejects an invalid source before any GET", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			fetchManualImportSourceProgress({
				instanceId: "instance",
				service: "radarr",
				downloadId: " source",
			}),
		).rejects.toThrow("Cached import progress is unavailable.");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("Manual Import client progress", () => {
	it("returns verified generic progress instead of discarding acknowledgement", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(status), {
				status: 202,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		expect(await submitManualImport(payload)).toEqual(status);
		expect(fetch).toHaveBeenCalledWith(
			"/api/manual-import",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(payload),
				credentials: "include",
			}),
		);
	});
	it.each([
		undefined,
		{ ...status, state: "completed" },
		{ ...status, selectedFileCount: 0 },
		{ ...status, path: "/synthetic/private-file" },
	])(
		"rejects empty/inconsistent/private progress rather than treating it as success",
		async (body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(body === undefined ? null : JSON.stringify(body), {
						status: body === undefined ? 204 : 202,
						headers: { "content-type": "application/json" },
					}),
				),
			);
			await expect(submitManualImport(payload)).rejects.toThrow(/import progress.*invalid/i);
		},
	);
});

describe("Queue Manual Import progress contract", () => {
	const queuePayload = {
		instanceId: "instance",
		service: "radarr" as const,
		itemId: 7,
		action: "manualImport" as const,
		downloadId: "source",
		removeFromClient: true,
		blocklist: false,
		changeCategory: false,
		search: false,
	};
	it("preserves durable progress for the Queue import caller", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(status), {
					status: 202,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		expect(await performQueueAction(queuePayload)).toEqual(status);
	});
	it("rejects a legacy empty acknowledgement instead of claiming import success", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
		await expect(performQueueAction(queuePayload)).rejects.toThrow(/import progress.*invalid/i);
	});
	it.each(["delete", "retry"] as const)(
		"%s still accepts the existing empty acknowledgement",
		async (action) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
			await expect(performQueueAction({ ...queuePayload, action })).resolves.toBeUndefined();
		},
	);
});
