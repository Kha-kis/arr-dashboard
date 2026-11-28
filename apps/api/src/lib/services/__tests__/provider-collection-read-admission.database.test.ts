import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { withIsolatedRuntimePrismaReadClient } from "../../backup/restore-runtime-client.js";

const identity = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../service-identity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../service-identity.js")>()),
	readProviderIdentity: identity.read,
}));

import {
	createProviderPublicationAuthority,
	withGuardedProviderCollection,
} from "../provider-identity-guard.js";

beforeEach(() => {
	identity.read.mockReset().mockResolvedValue({
		service: "JELLYFIN",
		identityKind: "jellyfin-server-id",
		rawIdentity: "synthetic-provider",
		confirmationDigest: "a".repeat(64),
		fingerprint: "a".repeat(12),
	});
});
afterEach(closeScopedWriteFixtures);

async function ownedSnapshot(f: ScopedWriteFixture) {
	return {
		...createProviderPublicationAuthority(
			await f.plain.serviceInstance.findFirstOrThrow({
				where: { id: "synthetic-jellyfin", userId: "synthetic-user" },
			}),
		),
		apiKey: "synthetic-only-provider-token",
	};
}

describe("guarded provider collection admission", { timeout: 20_000 }, () => {
	it("returns the collected page while an unrelated SQLite writer remains held", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		const snapshot = await ownedSnapshot(f);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const transactionEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const rollback = new Error("Synthetic unrelated publication rollback");
		const writer = f.runtime
			.runOperation(() =>
				f.client.prisma.$transaction(
					async (tx) => {
						await tx.plexCache.update({
							where: { id: "synthetic-cache" },
							data: { watchCount: 99 },
						});
						entered();
						await held;
						throw rollback;
					},
					{ timeout: 15_000 },
				),
			)
			.then(
				() => null,
				(error: unknown) => error,
			);
		let collected = false;
		const page = { startIndex: 0, totalRecordCount: 1, items: [{ id: "synthetic-episode" }] };
		try {
			await transactionEntered;
			const result = await f.runtime
				.runOperation(() =>
					withGuardedProviderCollection(
						f.client.prisma,
						snapshot,
						pino({ enabled: false }),
						async () => {
							collected = true;
							return page;
						},
					),
				)
				.then(
					(value) => ({ value, error: null }),
					(error: unknown) => ({ value: null, error }),
				);
			expect(collected).toBe(true);
			expect(result.error).toBeNull();
			expect(result.value).toBe(page);
			expect(identity.read).toHaveBeenCalledTimes(2);
		} finally {
			release();
			expect(await writer).toBe(rollback);
		}
		expect(await f.plain.plexCache.findUnique({ where: { id: "synthetic-cache" } })).toMatchObject({
			watchCount: 0,
		});
		expect(f.losses).toEqual([]);
	});

	it("rechecks committed owner, credentials, generations and cleanup lease after collection without initializing missing config", async () => {
		const f = await createScopedWriteFixture();
		const snapshot = await ownedSnapshot(f);
		await f.plain.user.create({ data: { id: "other-owner", username: "other-owner" } });
		const changes = [
			{ userId: "other-owner" },
			{ baseUrl: "http://replacement.invalid" },
			{ encryptedApiKey: "replacement-cipher" },
			{ encryptionIv: "replacement-iv" },
			{ encryptedHttpAuthCredentials: "replacement-auth-cipher" },
			{ httpAuthEncryptionIv: "replacement-auth-iv" },
			{ connectionGeneration: 2 },
			{ identityGeneration: 2 },
			{ expectedIdentity: "replacement-provider" },
			{ identityStatus: "UNVERIFIED" as const },
			{ service: "PLEX" as const },
			{ enabled: false },
		];
		for (const change of changes) {
			await expect(
				f.runtime.runOperation(() =>
					withGuardedProviderCollection(
						f.client.prisma,
						snapshot,
						pino({ enabled: false }),
						async () => {
							await f.plain.serviceInstance.update({ where: { id: snapshot.id }, data: change });
							return "collected-only";
						},
					),
				),
				JSON.stringify(Object.keys(change)),
			).rejects.toMatchObject({ code: "PUBLICATION_SUPERSEDED" });
			await f.plain.serviceInstance.update({
				where: { id: snapshot.id },
				data: {
					userId: snapshot.userId,
					baseUrl: snapshot.baseUrl,
					encryptedApiKey: snapshot.encryptedApiKey,
					encryptionIv: snapshot.encryptionIv,
					encryptedHttpAuthCredentials: snapshot.encryptedHttpAuthCredentials,
					httpAuthEncryptionIv: snapshot.httpAuthEncryptionIv,
					connectionGeneration: snapshot.connectionGeneration,
					identityGeneration: snapshot.identityGeneration,
					expectedIdentity: snapshot.expectedIdentity,
					identityStatus: snapshot.identityStatus,
					service: snapshot.service,
					enabled: true,
				},
			});
		}
		await f.plain.libraryCleanupConfig.update({
			where: { userId: snapshot.userId },
			data: { runClaimToken: "other-cleanup-worker" },
		});
		await expect(
			f.runtime.runOperation(() =>
				withGuardedProviderCollection(
					f.client.prisma,
					snapshot,
					pino({ enabled: false }),
					async () => "input",
				),
			),
		).rejects.toMatchObject({ code: "PUBLICATION_SUPERSEDED" });
		await f.plain.libraryCleanupConfig.delete({ where: { userId: snapshot.userId } });
		await expect(
			f.runtime.runOperation(() =>
				withGuardedProviderCollection(
					f.client.prisma,
					snapshot,
					pino({ enabled: false }),
					async () => "input",
				),
			),
		).rejects.toMatchObject({ code: "PUBLICATION_SUPERSEDED" });
		expect(await f.plain.libraryCleanupConfig.count({ where: { userId: snapshot.userId } })).toBe(
			0,
		);
		expect(f.losses).toEqual([]);
	});

	it.each(["before", "after"] as const)(
		"refuses %s-collection identity mismatch and cancellation without returning input",
		async (phase) => {
			const f = await createScopedWriteFixture();
			const snapshot = await ownedSnapshot(f);
			const cancellation = new AbortController();
			await expect(
				f.runtime.runOperation(() =>
					withGuardedProviderCollection(
						f.client.prisma,
						snapshot,
						pino({ enabled: false }),
						async () => {
							cancellation.abort();
							return "not-authorized-input";
						},
						{ signal: cancellation.signal },
					),
				),
			).rejects.toMatchObject({ code: "PUBLICATION_CANCELLED" });
			if (phase === "after")
				identity.read.mockResolvedValueOnce({
					service: "JELLYFIN",
					identityKind: "jellyfin-server-id",
					rawIdentity: "synthetic-provider",
					confirmationDigest: "a".repeat(64),
					fingerprint: "a".repeat(12),
				});
			identity.read.mockResolvedValueOnce({
				service: "JELLYFIN",
				identityKind: "jellyfin-server-id",
				rawIdentity: "different-provider",
				confirmationDigest: "b".repeat(64),
				fingerprint: "b".repeat(12),
			});
			let collected = false;
			await expect(
				f.runtime.runOperation(() =>
					withGuardedProviderCollection(
						f.client.prisma,
						snapshot,
						pino({ enabled: false }),
						async () => {
							collected = true;
							return "not-authorized-input";
						},
					),
				),
			).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
			expect(collected).toBe(phase === "after");
			expect(
				await f.plain.serviceInstance.findFirst({
					where: { id: snapshot.id, userId: snapshot.userId },
					select: { identityStatus: true },
				}),
			).toEqual({ identityStatus: "MISMATCH" });
			expect(f.losses).toEqual([]);
		},
	);

	it("does not retain read lanes while four provider collections remain pending", async () => {
		const f = await createScopedWriteFixture();
		const snapshot = await ownedSnapshot(f);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const allEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let active = 0;
		const collectors = Array.from({ length: 4 }, () =>
			f.runtime.runOperation(() =>
				withGuardedProviderCollection(
					f.client.prisma,
					snapshot,
					pino({ enabled: false }),
					async () => {
						if (++active === 4) entered();
						await held;
						return "collected-only";
					},
				),
			),
		);
		try {
			await Promise.race([allEntered, Promise.all(collectors)]);
			expect(active).toBe(4);
			const count = await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
					reader.serviceInstance.count({ where: { userId: snapshot.userId } }),
				),
			);
			expect(count).toBe(2);
			release();
			expect(await Promise.all(collectors)).toEqual(Array(4).fill("collected-only"));
		} finally {
			release();
			await Promise.allSettled(collectors);
		}
		expect(f.losses).toEqual([]);
	});
});
