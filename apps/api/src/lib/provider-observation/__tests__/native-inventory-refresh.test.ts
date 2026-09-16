import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import type {
	OwnedProviderPublicationSnapshot,
	ProviderPublicationAuthority,
} from "../../services/provider-identity-guard.js";
import type { ProviderCacheRefreshAttempt } from "../../services/provider-cache-status.js";
import {
	refreshNativeInventory,
	type NativeInventoryRefreshContext,
} from "../native-inventory-refresh.js";

const seams = vi.hoisted(() => ({
	withCurrent: vi.fn(),
	withGuarded: vi.fn(),
	beginInTransaction: vi.fn(),
	publishInTransaction: vi.fn(),
	failInTransaction: vi.fn(),
}));

vi.mock("../../services/provider-identity-guard.js", () => ({
	withCurrentProviderPublicationAuthority: seams.withCurrent,
	withGuardedProviderPublication: seams.withGuarded,
	ProviderIdentityGuardError: class ProviderIdentityGuardError extends Error {},
}));

vi.mock("../native-inventory.js", () => ({
	beginNativeInventoryAttemptInTransaction: seams.beginInTransaction,
	publishNativeInventoriesInTransaction: seams.publishInTransaction,
	failNativeInventoryAttemptInTransaction: seams.failInTransaction,
}));

const authority: ProviderPublicationAuthority = {
	id: "provider-1",
	userId: "user-1",
	service: "PLEX",
	baseUrl: "https://plex.invalid",
	enabled: true,
	encryptedApiKey: "ciphertext",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "machine-a",
	identityStatus: "VERIFIED",
	connectionGeneration: 4,
	identityGeneration: 9,
};

const instance = {
	...authority,
	apiKey: "secret",
	httpAuthHeaders: {},
} as OwnedProviderPublicationSnapshot;

const attempt: ProviderCacheRefreshAttempt = {
	attemptedAt: new Date("2026-09-14T12:00:00.000Z"),
	resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
};

const nativeAttempt = {
	attemptedAt: attempt.attemptedAt,
	resultMarker: "in_progress:00000000-0000-4000-8000-000000000002",
	domains: ["library" as const],
};

const snapshot = {
	domain: "library" as const,
	scopeKeys: ["library:one"],
	rows: [],
};

function canonicalClaim(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		lastAttemptAt: attempt.attemptedAt,
		lastAttemptResult: attempt.resultMarker,
		connectionGeneration: authority.connectionGeneration,
		identityGeneration: authority.identityGeneration,
		...overrides,
	};
}

function context(overrides: Partial<NativeInventoryRefreshContext> = {}) {
	return {
		prisma: {} as PrismaClient,
		instance,
		log: { warn: vi.fn() } as never,
		cacheType: "plex" as const,
		attempt,
		domains: ["library" as const],
		collect: vi.fn(async () => ({ complete: true as const, snapshots: [snapshot] })),
		cleanupRunClaimToken: "cleanup-claim",
		...overrides,
	};
}

function setup() {
	const tx = {
		cacheRefreshStatus: { findUnique: vi.fn(async () => canonicalClaim()) },
	};
	seams.withCurrent.mockImplementation(async (_prisma, _authority, action) => ({
		matched: true,
		value: await action(tx),
	}));
	seams.withGuarded.mockImplementation(async (_prisma, _instance, _log, collect, publish) => {
		const collected = await collect();
		return await publish(tx, collected);
	});
	seams.beginInTransaction.mockResolvedValue({
		status: "acquired",
		token: nativeAttempt.resultMarker,
		attempt: nativeAttempt,
		attemptedAt: nativeAttempt.attemptedAt,
		authority,
		domains: nativeAttempt.domains,
	});
	seams.publishInTransaction.mockResolvedValue({
		status: "published",
		generationId: "native-generation-1",
		observedAt: attempt.attemptedAt,
		itemCounts: { library: 0 },
	});
	seams.failInTransaction.mockResolvedValue({ status: "recorded" });
	return tx;
}

function warningCalls(value: ReturnType<typeof context>): unknown[][] {
	return (value.log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("refreshNativeInventory", () => {
	it("admits the native attempt under the exact canonical claim and publishes through the guarded boundary", async () => {
		const tx = setup();
		const value = context();

		await expect(refreshNativeInventory(value)).resolves.toEqual({ status: "published" });
		expect(seams.beginInTransaction).toHaveBeenCalledWith(tx, {
			userId: authority.userId,
			instance: authority,
			domains: ["library"],
			now: attempt.attemptedAt,
		});
		expect(value.collect).toHaveBeenCalledWith(instance, attempt);
		expect(seams.withGuarded).toHaveBeenCalledWith(
			value.prisma,
			instance,
			value.log,
			expect.any(Function),
			expect.any(Function),
			{ cleanupRunClaimToken: "cleanup-claim", timeout: 60_000 },
		);
		expect(seams.publishInTransaction).toHaveBeenCalledWith(tx, {
			userId: authority.userId,
			authority,
			attempt: nativeAttempt,
			snapshots: [snapshot],
		});
	});

	it("does not begin or collect when the canonical attempt has been replaced", async () => {
		const tx = setup();
		tx.cacheRefreshStatus.findUnique.mockResolvedValue(
			canonicalClaim({ lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000099" }),
		);
		const value = context();

		await expect(refreshNativeInventory(value)).resolves.toEqual({ status: "superseded" });
		expect(seams.beginInTransaction).not.toHaveBeenCalled();
		expect(value.collect).not.toHaveBeenCalled();
		expect(seams.failInTransaction).not.toHaveBeenCalled();
	});

	it("does not begin when the exact owned authority guard rejects the instance", async () => {
		setup();
		seams.withCurrent.mockResolvedValue({ matched: false });
		const value = context();

		await expect(refreshNativeInventory(value)).resolves.toEqual({ status: "superseded" });
		expect(seams.beginInTransaction).not.toHaveBeenCalled();
		expect(value.collect).not.toHaveBeenCalled();
	});

	it("records incomplete coverage as a native failure while retaining the prior publication", async () => {
		const tx = setup();
		const value = context({
			collect: vi.fn(async () => ({
				complete: false as const,
				reason: "coverage-incomplete" as const,
			})),
		});

		await expect(refreshNativeInventory(value)).resolves.toEqual({ status: "failed" });
		expect(seams.failInTransaction).toHaveBeenCalledWith(tx, {
			userId: authority.userId,
			authority,
			attempt: nativeAttempt,
			reason: "coverage-incomplete",
		});
		expect(seams.publishInTransaction).not.toHaveBeenCalled();
	});

	it("records provider collection errors only through the current native attempt", async () => {
		const tx = setup();
		const value = context({
			collect: vi.fn(async () => {
				throw new Error("private provider payload");
			}),
		});

		await expect(refreshNativeInventory(value)).resolves.toEqual({ status: "failed" });
		expect(seams.withCurrent).toHaveBeenCalledTimes(2);
		expect(seams.failInTransaction).toHaveBeenCalledWith(tx, {
			userId: authority.userId,
			authority,
			attempt: nativeAttempt,
			reason: "provider-unavailable",
		});
		expect(JSON.stringify(warningCalls(value))).not.toContain("private provider payload");
	});

	it("returns superseded when the canonical claim changes between collection and publication", async () => {
		const tx = setup();
		tx.cacheRefreshStatus.findUnique
			.mockResolvedValueOnce(canonicalClaim())
			.mockResolvedValueOnce(
				canonicalClaim({ lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000099" }),
			);
		const value = context();

		await expect(refreshNativeInventory(value)).resolves.toEqual({ status: "superseded" });
		expect(seams.publishInTransaction).not.toHaveBeenCalled();
		expect(seams.failInTransaction).not.toHaveBeenCalled();
	});

	it("sanitizes publication transaction errors and does not report success", async () => {
		setup();
		seams.publishInTransaction.mockRejectedValue(new Error("private transaction details"));
		const value = context();

		await expect(refreshNativeInventory(value)).resolves.toEqual({ status: "failed" });
		expect(seams.failInTransaction).toHaveBeenCalledOnce();
		expect(JSON.stringify(warningCalls(value))).not.toContain("private transaction details");
	});
});
