import { describe, expect, it, vi } from "vitest";
import {
	createLibraryRefreshRecoveryBridge,
	type LibraryRefreshRecoveryRequest,
} from "../library-refresh-recovery.js";
import { claimProviderCacheRefreshAttempt } from "../provider-cache-status.js";

async function request(): Promise<LibraryRefreshRecoveryRequest> {
	const authority = {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX" as const,
		baseUrl: "https://plex.invalid",
		enabled: true,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "server",
		identityStatus: "VERIFIED" as const,
		connectionGeneration: 1,
		identityGeneration: 1,
	};
	// Only SQL is doubled: use the real successful claim boundary with the same
	// attemptedAt for every request to exclude clock ordering.
	const tx = {
		libraryCleanupConfig: {
			upsert: async () => ({ id: "cleanup" }),
			findUnique: async () => ({ runClaimToken: null }),
		},
		serviceInstance: { findFirst: async () => ({ id: authority.id }) },
		cacheRefreshStatus: { findUnique: async () => null, create: async () => ({}) },
	};
	const prisma = {
		$transaction: async (fn: (value: typeof tx) => Promise<unknown>) => await fn(tx),
	};
	const claim = await claimProviderCacheRefreshAttempt(prisma as never, "plex", authority, {
		now: () => new Date("2026-09-14T12:00:00.000Z"),
	});
	if (claim.status !== "acquired") throw new Error("missing ordered test claim");
	return {
		provider: "plex",
		userId: authority.userId,
		instanceId: authority.id,
		authority,
		attempt: claim.attempt,
	};
}

describe("library refresh recovery bridge", () => {
	it("FAR-SAF-003 rejects delayed older admission and settlement after a newer committed claim", async () => {
		const bridge = createLibraryRefreshRecoveryBridge();
		const handler = vi.fn().mockResolvedValue({ status: "accepted" as const });
		bridge.register("plex", handler);
		const older = await request(),
			newer = await request();
		expect(bridge.admit(newer)).toBe(true);
		expect(bridge.admit(older)).toBe(false);
		await expect(bridge.arm(older)).resolves.toEqual({ status: "unavailable" });
		expect(handler).not.toHaveBeenCalled();
		await expect(bridge.arm(newer)).resolves.toEqual({ status: "accepted" });
	});
	it("FAR-SAF-003 admits the exact object idempotently and rejects unknown, cloned, altered authority and mutated attempts", async () => {
		const bridge = createLibraryRefreshRecoveryBridge();
		const owned = await request();
		expect(bridge.admit(owned)).toBe(true);
		expect(bridge.admit({ ...owned })).toBe(true);
		expect(bridge.admit({ ...owned, attempt: { ...owned.attempt } })).toBe(false);
		expect(bridge.admit({ ...owned, instanceId: "other" })).toBe(false);
		expect(bridge.admit({ ...owned, userId: "other" })).toBe(false);
		expect(bridge.admit({ ...owned, provider: "jellyfin" })).toBe(false);
		for (const change of [
			{ baseUrl: "https://other.invalid" },
			{ encryptedApiKey: "other" },
			{ encryptionIv: "other" },
			{ encryptedHttpAuthCredentials: "other" },
			{ httpAuthEncryptionIv: "other" },
			{ expectedIdentity: "other" },
			{ identityStatus: "UNVERIFIED" as const },
			{ enabled: false },
			{ connectionGeneration: 2 },
			{ identityGeneration: 2 },
			{ service: "JELLYFIN" as const },
		])
			expect(bridge.admit({ ...owned, authority: { ...owned.authority, ...change } })).toBe(false);
		const marker = owned.attempt.resultMarker;
		owned.attempt.resultMarker = "in_progress:00000000-0000-4000-8000-000000000099";
		expect(bridge.admit(owned)).toBe(false);
		owned.attempt.resultMarker = marker;
		expect(bridge.admit(owned)).toBe(true);
		const time = owned.attempt.attemptedAt.getTime();
		owned.attempt.attemptedAt.setTime(time + 1);
		expect(bridge.admit(owned)).toBe(false);
		owned.attempt.attemptedAt.setTime(time);
		const url = owned.authority.baseUrl;
		owned.authority.baseUrl = "https://mutated.invalid";
		expect(bridge.admit(owned)).toBe(false);
		owned.authority.baseUrl = url;
		expect(bridge.admit(owned)).toBe(true);
	});
});
