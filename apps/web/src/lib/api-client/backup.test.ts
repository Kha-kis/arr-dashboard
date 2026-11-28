import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../auth-session-signal";
import { backupApi } from "./backup";

const restoreId = "767478b4-9726-485c-bc91-c379fb118d12";
const committed = {
	restoreId,
	outcome: "committed",
	success: true,
	reason: null,
	restartRequired: true,
	restart: "automatic-requested",
};
const refused = {
	restoreId,
	outcome: "not-committed",
	success: false,
	reason: "state-changed",
	restartRequired: true,
	restart: "manual-required",
};
const unavailable = {
	restoreId,
	outcome: "unavailable",
	success: false,
	reason: "commit-unknown",
	restartRequired: true,
	restart: "manual-required",
};

function response(body: unknown, status: number) {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
});

describe.each(["upload", "stored"] as const)("checked %s Restore transport", (selection) => {
	const request = () =>
		selection === "upload"
			? backupApi.restoreBackup({ backupData: "e30=", password: "synthetic-password" })
			: backupApi.restoreBackupFromFile({ id: "a".repeat(24), password: "synthetic-password" });
	const path = selection === "upload" ? "/api/backup/restore" : "/api/backup/restore-from-file";

	it.each([
		[200, committed],
		[409, refused],
		[503, unavailable],
	] as const)("accepts only the strict result aligned with HTTP %i", async (status, result) => {
		let calls = 0;
		vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
			calls++;
			expect(url).toBe(path);
			expect(options.method).toBe("POST");
			expect(options.credentials).toBe("include");
			expect(JSON.parse(options.body as string)).toEqual(
				selection === "upload"
					? { backupData: "e30=", password: "synthetic-password" }
					: { id: "a".repeat(24), password: "synthetic-password" },
			);
			return response(result, status);
		});
		expect(await request()).toEqual(result);
		expect(calls).toBe(1);
	});

	it.each([
		[200, { success: true }],
		[202, committed],
		[204, null],
		[200, refused],
		[200, unavailable],
		[409, committed],
		[503, refused],
		[400, committed],
		[500, committed],
		[200, { ...committed, success: false }],
		[200, { ...committed, restoreId: "unverified" }],
		[200, { ...committed, private: "synthetic-private-response" }],
		[503, { ...unavailable, restart: "automatic-requested" }],
		[503, { category: "publication-unconfirmed", error: "Restore request rejected" }],
		[409, { error: "synthetic-private-error" }],
		[400, { category: "unverified-category", error: "synthetic-private-error" }],
	] as const)(
		"does not turn HTTP %i with unverified evidence into success or a safe retry",
		async (status, body) => {
			let calls = 0;
			vi.stubGlobal("fetch", async () => {
				calls++;
				return response(body, status);
			});
			const result = request();
			await expect(result).rejects.toMatchObject({
				name: "RestoreUnconfirmedError",
				message: "Restore outcome could not be confirmed. Do not repeat the restore request.",
			});
			const error = await result.catch((value: unknown) => value);
			expect(error).not.toHaveProperty("payload");
			expect(error).not.toHaveProperty("cause");
			expect(calls).toBe(1);
		},
	);

	it.each([
		[400, "invalid-backup"],
		[409, "invalid-backup"],
		[409, "restore-busy"],
		[409, "maintenance-conflict"],
		[503, "destination-unavailable"],
	] as const)(
		"keeps a bounded acknowledged pre-publication rejection at HTTP %i",
		async (status, category) => {
			let calls = 0;
			vi.stubGlobal("fetch", async () => {
				calls++;
				return response({ error: "Restore request rejected", category }, status);
			});
			const result = request();
			await expect(result).rejects.toMatchObject({
				name: "RestoreRequestRejectedError",
				status,
				category,
			});
			const error = await result.catch((value: unknown) => value);
			expect(error).not.toHaveProperty("payload");
			expect(calls).toBe(1);
		},
	);

	it("recognizes only the server's bounded rate-limit refusal without replay", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return response(
				{
					error: "Restore request rejected",
					category: "restore-rate-limited",
					retryAfterSeconds: 300,
				},
				429,
			);
		});
		const result = request();
		await expect(result).rejects.toMatchObject({
			name: "RestoreRequestRejectedError",
			status: 429,
			category: "restore-rate-limited",
			retryAfterSeconds: 300,
		});
		const error = await result.catch((value: unknown) => value);
		expect(error).not.toHaveProperty("payload");
		expect(error).not.toHaveProperty("cause");
		expect(calls).toBe(1);
	});

	it.each([
		[429, { error: "Gateway rate limit" }],
		[429, { error: "Restore request rejected", category: "restore-rate-limited" }],
		...[0, -1, 301, 1.5, "300", null].map((retryAfterSeconds): [number, unknown] => [
			429,
			{ error: "Restore request rejected", category: "restore-rate-limited", retryAfterSeconds },
		]),
		[
			429,
			{
				error: "Restore request rejected",
				category: "restore-rate-limited",
				retryAfterSeconds: 300,
				restoreId,
			},
		],
		[429, { error: 42, category: "restore-rate-limited", retryAfterSeconds: 300 }],
		[
			503,
			{
				error: "Restore request rejected",
				category: "restore-rate-limited",
				retryAfterSeconds: 300,
			},
		],
		[
			400,
			{
				error: "Restore request rejected",
				category: "restore-rate-limited",
				retryAfterSeconds: 300,
			},
		],
	])("keeps unverified rate-limit evidence at HTTP %i unconfirmed", async (status, payload) => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return response(payload, Number(status));
		});
		await expect(request()).rejects.toMatchObject({ name: "RestoreUnconfirmedError" });
		expect(calls).toBe(1);
	});

	it("preserves the existing unauthorized signal without retaining a private body", async () => {
		vi.stubGlobal("fetch", async () => response({ private: "synthetic-private" }, 401));
		await expect(request()).rejects.toMatchObject({
			name: "RestoreRequestRejectedError",
			status: 401,
			category: "unauthorized",
		});
		expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
	});

	it("does not replay a disconnected POST or retain a transport error", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			throw new Error("synthetic-private-transport");
		});
		const result = request();
		await expect(result).rejects.toMatchObject({ name: "RestoreUnconfirmedError" });
		const error = await result.catch((value: unknown) => value);
		expect(String(error)).not.toContain("synthetic-private");
		expect(error).not.toHaveProperty("cause");
		expect(calls).toBe(1);
	});
});

describe("protected positive Restore status", () => {
	it.each([null, { restoreId, committedAt: "2026-10-09T10:00:00.000Z" }])(
		"returns only verified latest-positive evidence",
		async (latestCommitted) => {
			let calls = 0;
			vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
				calls++;
				expect(url).toBe("/api/backup/restore/status");
				expect(options).toMatchObject({ method: "GET", credentials: "include" });
				return response({ latestCommitted }, 200);
			});
			expect(await backupApi.getRestoreStatus()).toEqual({ latestCommitted });
			expect(calls).toBe(1);
		},
	);
	it.each([
		[200, {}],
		[200, { latestCommitted: { restoreId, committedAt: "yesterday" } }],
		[200, { latestCommitted: null, owner: "synthetic-private" }],
		[202, { latestCommitted: null }],
	] as const)(
		"does not treat unverified HTTP %i status as positive or rollback proof",
		async (status, payload) => {
			vi.stubGlobal("fetch", async () => response(payload, status));
			await expect(backupApi.getRestoreStatus()).rejects.toThrow(
				"Restore status could not be verified.",
			);
		},
	);
});
