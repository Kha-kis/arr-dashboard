import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { withCurrentProviderPublicationAuthority } from "../provider-identity-guard.js";

afterEach(closeScopedWriteFixtures);

describe("guarded provider publication WAL write intent", { timeout: 30_000 }, () => {
	// Removing scoped reservation must fail at the real PlexCache update after
	// the second connection commits against the guard's pinned WAL snapshot.
	it("publishes through ordinary runtime after a competing WAL write attempt", async () => {
		const f = await createScopedWriteFixture();
		const protectedBefore = snapshotProtectedRows(f);
		const competition = interceptScopedWriteCompetition(f, { compete: true });
		let callbacks = 0;
		let failure: unknown;
		let result: unknown;
		try {
			result = await f.runtime.runOperation(() =>
				withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) => {
					callbacks++;
					return await tx.plexCache.updateMany({
						where: { id: "synthetic-cache", instanceId: f.authority.id },
						data: { watchCount: 7 },
					});
				}),
			);
		} catch (error) {
			failure = error;
		}
		recordScopedWriteEvidence("publisher", {
			competition,
			callbacks,
			error:
				failure instanceof Error
					? { name: failure.name, code: Reflect.get(failure, "code") }
					: null,
			result,
		});
		expect(competition.commits + competition.blocked).toBe(1);
		if (failure) {
			expect(snapshotProtectedRows(f)).toEqual(protectedBefore);
			expect(competition.rollbacks).toBeGreaterThan(0);
		}
		expect(callbacks).toBe(1);
		expect(
			failure,
			"real publication should survive the controlled competing WAL attempt",
		).toBeUndefined();
		expect(result).toEqual({ matched: true, value: { count: 1 } });
		expect(
			f.writer.prepare("SELECT watchCount FROM plex_cache WHERE id='synthetic-cache'").get(),
		).toEqual({ watchCount: 7 });
		expect(f.losses).toEqual([]);
	});

	// A writer reservation is never publication authority. Owner, provider
	// generation and cleanup lease mismatches must still refuse the callback.
	it.each(["owner", "identity-generation", "cleanup-lease"] as const)(
		"refuses %s authority loss without publishing",
		async (kind) => {
			const f = await createScopedWriteFixture();
			if (kind === "owner") {
				await f.plain.user.create({
					data: { id: "synthetic-other-owner", username: "synthetic-other-owner" },
				});
				await f.plain.libraryCleanupConfig.create({
					data: { id: "synthetic-other-cleanup", userId: "synthetic-other-owner" },
				});
			}
			if (kind === "cleanup-lease")
				await f.plain.libraryCleanupConfig.update({
					where: { id: "synthetic-cleanup" },
					data: { runClaimToken: "synthetic-other-cleanup" },
				});
			const before = snapshotProtectedRows(f);
			const authority = {
				...f.authority,
				...(kind === "owner" ? { userId: "synthetic-other-owner" } : {}),
				...(kind === "identity-generation" ? { identityGeneration: 0 } : {}),
			};
			let callbacks = 0;
			const result = await f.runtime.runOperation(() =>
				withCurrentProviderPublicationAuthority(f.client.prisma, authority, async (tx) => {
					callbacks++;
					return await tx.plexCache.updateMany({
						where: { id: "synthetic-cache" },
						data: { watchCount: 7 },
					});
				}),
			);
			expect(result).toEqual({ matched: false });
			expect(callbacks).toBe(0);
			expect(snapshotProtectedRows(f)).toEqual(before);
			expect(f.losses).toEqual([]);
		},
	);
});
