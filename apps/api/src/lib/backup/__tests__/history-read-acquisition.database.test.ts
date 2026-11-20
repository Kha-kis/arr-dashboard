import { historyNormalizedPayloadV1Schema } from "@arr/shared";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { historyRoutes } from "../../../routes/dashboard/history-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { Encryptor } from "../../auth/encryption.js";

afterEach(closeScopedWriteFixtures);

describe("History committed read acquisition", { timeout: 20_000 }, () => {
	// Break caught: a writer must not strand owner-scoped, snapshot-consistent
	// History pagination or expose its uncommitted cascading source deletion.
	it("serves committed owned pages while an ordinary writer is held", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		const observedAt = new Date("2026-09-03T23:00:00.000Z");
		for (const [id, userId] of [
			["owned-sonarr", "synthetic-user"],
			["foreign-sonarr", "foreign-user"],
		]) {
			await f.plain.serviceInstance.create({
				data: {
					id: id!,
					userId: userId!,
					service: "SONARR",
					label: id!,
					baseUrl: "https://sonarr.invalid",
					encryptedApiKey: "synthetic-cipher",
					encryptionIv: "synthetic-iv",
					connectionGeneration: 1,
				},
			});
			await f.plain.historySourceStatus.create({
				data: {
					instanceId: id!,
					connectionGeneration: 1,
					publishedAt: observedAt,
					retainedObservationCount: 3,
					publicationRevision: 1,
					retentionEpoch: 0,
					publicationMetadata: JSON.stringify({
						version: 1,
						service: "sonarr",
						connectionGeneration: 1,
						publicationLevel: "positive-only",
						completeness: "partial",
						observedAt: observedAt.toISOString(),
						publishedObservationCount: 3,
						coverageReceipt: {
							version: 1,
							provider: "sonarr_history",
							evidence: "positive-only",
							attemptStartedAt: observedAt.toISOString(),
							observedAt: observedAt.toISOString(),
							units: [
								{
									scopeKey: "history",
									expectedRawCount: null,
									pagesAttempted: 1,
									pagesCompleted: 1,
									rawObserved: 3,
									sourceBindings: 3,
									canonicalEntities: 3,
									acceptedSkips: [],
									fatalCount: 0,
								},
							],
							publishedCanonicalEntities: 3,
						},
					}),
				},
			});
			for (const providerEventId of [1, 2, 3]) {
				const eventAt = new Date(`2026-09-03T22:00:0${providerEventId}.000Z`);
				await f.plain.historyObservation.create({
					data: {
						id: `${id}-row-${providerEventId}`,
						instanceId: id!,
						connectionGeneration: 1,
						providerEventId,
						eventAt,
						eventTypeKey: "download",
						searchText: "synthetic download",
						firstObservedAt: observedAt,
						lastObservedAt: observedAt,
						normalizedPayload: JSON.stringify(
							historyNormalizedPayloadV1Schema.parse({
								version: 1,
								service: "sonarr",
								providerEventId,
								eventAt: eventAt.toISOString(),
								eventType: "download",
								title: "Synthetic",
								seriesId: 10,
								episodeId: 11,
							}),
						),
					},
				});
			}
		}
		const before = snapshotProtectedRows(f);
		const observationsBefore = await f.plain.historyObservation.findMany({
			orderBy: { id: "asc" },
		});
		const statusesBefore = await f.plain.historySourceStatus.findMany({
			orderBy: { instanceId: "asc" },
		});
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.decorate("encryptor", new Encryptor("a".repeat(64)));
		app.decorate("dbProvider", "sqlite");
		app.decorateRequest("currentUser", null);
		app.addHook("onRequest", async (request) => {
			request.currentUser = { id: "synthetic-user" } as typeof request.currentUser;
		});
		await app.register(historyRoutes);
		await app.ready();
		const read = (url: string) => f.runtime.runOperation(() => app.inject({ method: "GET", url }));
		const rollback = new Error("synthetic-history-rollback");
		let release = () => {};
		let publication: Promise<unknown> | undefined;
		try {
			const baseline = await read("/dashboard/history?limit=2");
			expect(baseline.statusCode).toBe(200);
			expect(baseline.json().items.map((item: { id: string }) => item.id)).toEqual([
				"owned-sonarr-row-3",
				"owned-sonarr-row-2",
			]);
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
							await tx.serviceInstance.delete({ where: { id: "owned-sonarr" } });
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
			const first = await read("/dashboard/history?limit=2");
			expect(first.statusCode).toBe(200);
			expect(first.json().items.map((item: { id: string }) => item.id)).toEqual([
				"owned-sonarr-row-3",
				"owned-sonarr-row-2",
			]);
			expect(
				first.json().sources.map((source: { instanceId: string }) => source.instanceId),
			).toEqual(["owned-sonarr"]);
			expect(first.json().pageInfo).toMatchObject({ hasNextPage: true, matchingObservedCount: 3 });
			const cursor = first.json().pageInfo.nextCursor;
			expect(typeof cursor).toBe("string");
			const second = await read(`/dashboard/history?limit=2&cursor=${encodeURIComponent(cursor)}`);
			expect(second.statusCode).toBe(200);
			expect(second.json().items.map((item: { id: string }) => item.id)).toEqual([
				"owned-sonarr-row-1",
			]);
			expect(second.json().pageInfo).toEqual({
				nextCursor: null,
				hasNextPage: false,
				matchingObservedCount: 3,
			});
			expect(first.body + second.body).not.toMatch(/foreign-|synthetic-(?:cipher|iv)/);
		} finally {
			release();
			if (publication) expect(await publication).toBe(rollback);
			await app.close();
			expect(f.losses).toEqual([]);
			expect(snapshotProtectedRows(f)).toEqual(before);
			expect(await f.plain.historyObservation.findMany({ orderBy: { id: "asc" } })).toEqual(
				observationsBefore,
			);
			expect(
				await f.plain.historySourceStatus.findMany({ orderBy: { instanceId: "asc" } }),
			).toEqual(statusesBefore);
		}
	});
});
