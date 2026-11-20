import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";
import { registerSectionRoutes } from "../section-routes.js";
import { sectionCatalogFixture } from "./section-catalog-fixture.js";

const provider = vi.hoisted(() => ({
	create: vi.fn(() => {
		throw new Error("GET must not contact Plex");
	}),
}));
vi.mock("../../../lib/plex/plex-client.js", async (original) => ({
	...(await original<typeof import("../../../lib/plex/plex-client.js")>()),
	createPlexClient: provider.create,
}));

describe("cached Plex section catalog", () => {
	async function read(
		change: (fixture: ReturnType<typeof sectionCatalogFixture>) => void = () => {},
	) {
		const fixture = sectionCatalogFixture();
		change(fixture);
		const app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", fixture.prisma as never);
		await app.register(registerSectionRoutes, { prefix: "/api/plex/sections" });
		try {
			return {
				response: await createInjectAuthenticated(app)("GET", "/api/plex/sections"),
				fixture,
			};
		} finally {
			await app.close();
		}
	}

	it("serves a proved catalog when unrelated canonical authority is positive-only, without provider reads", async () => {
		const { response } = await read();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sections: [
				{
					sectionId: "1",
					sectionUuid: "section-uuid",
					sectionTitle: "Movies",
					instanceId: "plex-1",
				},
			],
			catalog: { availability: "current", observedAt: expect.any(String) },
			evidence: { authority: "positive-only", completeness: "partial" },
		});
		expect(provider.create).not.toHaveBeenCalled();
	});

	it("labels retained catalog values last-known after a failed latest attempt", async () => {
		const { response } = await read(({ status }) => {
			status.lastAttemptResult = "error";
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			catalog: { availability: "last-known" },
			sections: [{ sectionUuid: "section-uuid" }],
			evidence: { authority: "unavailable", attemptState: "error" },
		});
	});

	it.each([
		"unverified identity",
		"connection mismatch",
		"missing coverage",
		"different scope",
		"duplicate section",
	])("withholds a catalog with %s", async (reason) => {
		const { response } = await read((f) => {
			if (reason === "unverified identity") f.instance.identityStatus = "UNVERIFIED";
			if (reason === "connection mismatch") f.status.connectionGeneration++;
			if (reason === "missing coverage")
				f.metadata.coverageReceipt.domains[0]!.evidence = "unknown";
			if (reason === "different scope")
				f.metadata.coverageReceipt.domains[0]!.units[0]!.scopeKey = "section:2:inventory";
			if (reason === "duplicate section") f.metadata.sections.push({ ...f.section });
			f.publishMetadata();
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
	});

	it("does not silently omit a configured unavailable instance", async () => {
		const { response } = await read((f) => {
			f.instances.push({ ...f.instance, id: "plex-2", identityStatus: "UNVERIFIED" });
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
	});

	it("never returns a different owner's sections", async () => {
		const { response, fixture } = await read((f) => {
			f.instance.userId = "other-user";
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
		expect(fixture.prisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ userId: "user-1", service: "PLEX", enabled: true }),
			}),
		);
	});

	it("withholds an ambiguous section UUID even when separate section-key coverage is complete", async () => {
		const { response } = await read((f) => {
			f.metadata.sections.push({ ...f.section, key: "2" });
			f.metadata.coverageReceipt.domains[0]!.units.push({
				scopeKey: "section:2:inventory",
				expectedRawCount: 0,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 0,
				sourceBindings: 0,
				canonicalEntities: 0,
				acceptedSkips: [],
				fatalCount: 0,
			});
			f.publishMetadata();
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
	});

	it("does not accept a legacy receipt whose covered section differs from its named catalog", async () => {
		const { response } = await read((f) => {
			const {
				observedRoots: _roots,
				capabilities: _capabilities,
				ambiguousTmdbCandidates: _candidates,
				...base
			} = f.metadata;
			f.status.lastAttemptResult = "success";
			f.status.generationMetadata = JSON.stringify({
				...base,
				version: 5,
				publicationLevel: "authoritative",
				completeness: "complete",
				roots: [{ sectionKey: "1", domain: "membership", digest: "a".repeat(64) }],
				coverageReceipt: {
					version: 1,
					provider: "plex",
					attemptStartedAt: f.metadata.coverageReceipt.attemptStartedAt,
					observedAt: f.metadata.coverageReceipt.observedAt,
					evidence: "complete",
					units: [
						{ ...f.metadata.coverageReceipt.domains[4]!.units[0], scopeKey: "section:other" },
					],
				},
			});
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
	});

	it("does not expose a catalog after its stored connection changes during the read", async () => {
		const { response } = await read((f) => {
			f.prisma.cacheRefreshStatus.findMany.mockImplementation(async () => {
				f.instance.connectionGeneration++;
				return [f.status];
			});
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
	});

	it("does not turn a database failure into an empty section list", async () => {
		const { response } = await read((f) => {
			f.prisma.cacheRefreshStatus.findMany.mockRejectedValue(
				new Error("synthetic database failure"),
			);
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
	});

	it("returns all same-key, same-title sections from separate owned instances without merging their UUIDs", async () => {
		const { response } = await read((f) => {
			f.instances.push({ ...f.instance, id: "plex-2", expectedIdentity: "machine-2" });
			f.prisma.cacheRefreshStatus.findMany.mockImplementation(
				async ({ where }: { where: { instanceId: string } }) => [
					{
						...f.status,
						instanceId: where.instanceId,
						generationMetadata:
							where.instanceId === "plex-2"
								? JSON.stringify({
										...f.metadata,
										sections: [{ ...f.section, uuid: "section-uuid-2" }],
									})
								: f.status.generationMetadata,
					},
				],
			);
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().sections).toEqual([
			expect.objectContaining({
				instanceId: "plex-1",
				sectionId: "1",
				sectionUuid: "section-uuid",
			}),
			expect.objectContaining({
				instanceId: "plex-2",
				sectionId: "1",
				sectionUuid: "section-uuid-2",
			}),
		]);
	});

	it("keeps a verified empty library section in the catalog even when no canonical item rows exist", async () => {
		const { response } = await read((f) => {
			f.prisma.plexCache.count.mockResolvedValue(0);
			f.status.itemCount = 0;
			f.status.lastAttemptResult = "success";
			f.status.generationMetadata = JSON.stringify({
				version: 5,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 0,
				canonicalizationVersion: 1,
				sections: [f.section],
				roots: [{ sectionKey: "1", domain: "membership", digest: "a".repeat(64) }],
				targetLedgerVersion: 1,
				targetCount: 0,
				targetDigest: "b".repeat(64),
				partialReasons: [],
				coverageReceipt: {
					version: 1,
					provider: "plex",
					attemptStartedAt: f.metadata.coverageReceipt.attemptStartedAt,
					observedAt: f.metadata.coverageReceipt.observedAt,
					evidence: "complete",
					units: [
						{
							scopeKey: "section:1",
							expectedRawCount: 0,
							rawObserved: 0,
							sourceBindings: 0,
							canonicalEntities: 0,
							acceptedSkips: [],
							fatalCount: 0,
							pagesAttempted: 1,
							pagesCompleted: 1,
						},
					],
				},
			});
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			sections: [{ sectionId: "1", sectionUuid: "section-uuid" }],
			catalog: { availability: "current" },
		});
	});
});
