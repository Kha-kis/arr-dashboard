import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerRecentlyAddedRoutes } from "../../../routes/jellyfin/recently-added-routes.js";
import { registerOnDeckRoutes as registerJellyfinOnDeckRoutes } from "../../../routes/jellyfin/on-deck-routes.js";
import { registerOnDeckRoutes } from "../../../routes/plex/on-deck-routes.js";
import { registerRecentlyAddedRoutes as registerPlexRecentlyAddedRoutes } from "../../../routes/plex/recently-added-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../../jellyfin/jellyfin-generation-metadata.js";

afterEach(closeScopedWriteFixtures);

describe("cached Dashboard card read acquisition", { timeout: 20_000 }, () => {
	// Break caught: using the ordinary client for instance selection or evidence
	// must not make populated cached cards unavailable during an unrelated write.
	it("serves committed owned rows while an ordinary transaction holds uncommitted instance changes", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		const observedAt = new Date();
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		for (const service of ["PLEX", "JELLYFIN"] as const) {
			const suffix = service.toLowerCase();
			const identityKind = service === "PLEX" ? "PLEX_MACHINE_IDENTIFIER" : "JELLYFIN_SERVER_ID";
			await f.plain.serviceInstance.update({
				where: { id: `synthetic-${suffix}` },
				data: { label: `Committed ${suffix}`, identityKind, identityVerifiedAt: observedAt },
			});
			await f.plain.serviceInstance.create({
				data: {
					id: `foreign-${suffix}`,
					userId: "foreign-user",
					service,
					label: `Foreign ${suffix}`,
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "synthetic-cipher",
					encryptionIv: "synthetic-iv",
					expectedIdentity: "synthetic-provider",
					identityKind,
					identityStatus: "VERIFIED",
					identityVerifiedAt: observedAt,
					connectionGeneration: 1,
					identityGeneration: 1,
				},
			});
		}
		const receipt = (provider: "plex" | "jellyfin") => ({
			version: 1 as const,
			provider,
			attemptStartedAt: observedAt.toISOString(),
			observedAt: observedAt.toISOString(),
			evidence: "complete" as const,
			units: [
				{
					scopeKey: "library",
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 1,
					sourceBindings: 1,
					canonicalEntities: 1,
					acceptedSkips: [],
					fatalCount: 0,
				},
			],
			publishedCanonicalEntities: 1,
		});
		for (const owner of ["synthetic", "foreign"]) {
			const plexRow = {
				instanceId: `${owner}-plex`,
				tmdbId: 1,
				mediaType: "movie",
				sectionId: "synthetic-section",
				sectionTitle: "Synthetic",
				title: owner === "synthetic" ? "Committed movie" : "Foreign movie",
				ratingKey: "same-provider-item",
				watchedByUsers: "[]",
				collections: "[]",
				labels: "[]",
				onDeck: true,
				addedAt: observedAt,
				connectionGeneration: 1,
				identityGeneration: 1,
			};
			if (owner === "synthetic") {
				await f.plain.plexCache.update({ where: { id: "synthetic-cache" }, data: plexRow });
			} else {
				await f.plain.plexCache.create({ data: plexRow });
			}
			const jellyfinRow = await f.plain.jellyfinCache.create({
				data: {
					instanceId: `${owner}-jellyfin`,
					tmdbId: 1,
					mediaType: "movie",
					libraryId: "synthetic-section",
					libraryName: "Synthetic",
					title: plexRow.title,
					jellyfinId: "same-provider-item",
					watchedByUsers: "[]",
					collections: "[]",
					addedAt: observedAt,
					onDeck: true,
					connectionGeneration: 1,
					identityGeneration: 1,
				},
			});
			for (const cacheType of ["plex", "jellyfin"] as const) {
				const generationMetadata =
					cacheType === "plex"
						? JSON.stringify({
								version: 5,
								publicationLevel: "authoritative",
								completeness: "complete",
								itemCount: 1,
								canonicalizationVersion: 1,
								sections: [
									{
										key: "synthetic-section",
										uuid: "synthetic-section-uuid",
										title: "Synthetic",
										type: "movie",
										refreshing: false,
										scannedAt: 1,
										updatedAt: 1,
									},
								],
								roots: [
									{ sectionKey: "synthetic-section", domain: "membership", digest: "a".repeat(64) },
								],
								targetLedgerVersion: 1,
								targetCount: 1,
								targetDigest: "b".repeat(64),
								partialReasons: [],
								coverageReceipt: receipt("plex"),
							})
						: encodeJellyfinLibraryGenerationMetadata({
								version: 1,
								provider: "jellyfin",
								cacheType: "jellyfin",
								publicationLevel: "authoritative",
								completeness: "complete",
								canonicalizationVersion: 1,
								itemCount: 1,
								connectionGeneration: 1,
								identityGeneration: 1,
								contentFingerprint: fingerprintJellyfinLibraryRows([
									{ ...jellyfinRow, mediaType: "movie" },
								]),
								coverageReceipt: receipt("jellyfin"),
							});
				await f.plain.cacheRefreshStatus.create({
					data: {
						instanceId: `${owner}-${cacheType}`,
						cacheType,
						lastRefreshedAt: observedAt,
						lastResult: "success",
						lastAttemptAt: observedAt,
						lastAttemptResult: "success",
						itemCount: 1,
						generationId: `${owner}-${cacheType}-generation`,
						generationMetadata,
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				});
			}
		}

		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.addHook("onRequest", async (request) => {
			request.currentUser = { id: "synthetic-user" } as typeof request.currentUser;
		});
		await app.register(registerOnDeckRoutes, { prefix: "/plex-on-deck" });
		await app.register(registerRecentlyAddedRoutes, { prefix: "/jellyfin-recently-added" });
		await app.register(registerPlexRecentlyAddedRoutes, { prefix: "/plex-recently-added" });
		await app.register(registerJellyfinOnDeckRoutes, { prefix: "/jellyfin-on-deck" });
		await app.ready();
		const urls = [
			"/plex-on-deck/",
			"/jellyfin-recently-added/?limit=1",
			"/plex-recently-added/?limit=1",
			"/jellyfin-on-deck/",
		];
		const read = (url: string) => f.runtime.runOperation(() => app.inject({ method: "GET", url }));
		let release = () => {};
		let publication: Promise<unknown> | undefined;
		const rollback = new Error("synthetic-dashboard-card-rollback");
		try {
			const baseline = await Promise.all(urls.map(read));
			for (const [index, response] of baseline.entries()) {
				expect(response.statusCode, response.body).toBe(200);
				expect(response.json().items).toEqual([
					expect.objectContaining({
						tmdbId: 1,
						title: "Committed movie",
						instanceId: index === 1 || index === 3 ? "synthetic-jellyfin" : "synthetic-plex",
						instanceName: index === 1 || index === 3 ? "Committed jellyfin" : "Committed plex",
					}),
				]);
			}
			let entered!: () => void;
			const transactionEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			publication = f.runtime
				.runOperation(() =>
					f.client.prisma.$transaction(
						async (tx) => {
							await tx.serviceInstance.updateMany({
								where: { userId: "synthetic-user" },
								data: { enabled: false, label: "Uncommitted" },
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
			await Promise.race([
				transactionEntered,
				publication.then(() => {
					throw new Error("Ordinary transaction ended before holding its write");
				}),
			]);
			const responses = await Promise.all(urls.map(read));
			expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
			for (const [index, response] of responses.entries()) {
				expect(response.json().items).toEqual(baseline[index]!.json().items);
				expect(response.body).not.toMatch(/Uncommitted|Foreign|foreign-/);
			}
			expect(responses[0]!.json().evidence).toMatchObject({
				availability: "current",
				authority: "authoritative",
			});
			expect(responses[1]!.json().providerStatus).toMatchObject({ availability: "current" });
			expect(responses[3]!.json().providerStatus).toMatchObject({ availability: "current" });
		} finally {
			release();
			if (publication) expect(await publication).toBe(rollback);
			await app.close();
			expect(f.losses).toEqual([]);
			expect(
				await f.plain.serviceInstance.findMany({
					where: { userId: "synthetic-user" },
					select: { id: true, enabled: true, label: true },
					orderBy: { id: "asc" },
				}),
			).toEqual([
				{ id: "synthetic-jellyfin", enabled: true, label: "Committed jellyfin" },
				{ id: "synthetic-plex", enabled: true, label: "Committed plex" },
			]);
		}
	});
});
