import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "../../__tests__/test-helpers.js";
import { registerSectionRoutes } from "../section-routes.js";
import { sectionCatalogFixture } from "./section-catalog-fixture.js";

describe("GET /api/plex/sections authority separation", () => {
	async function read(change: (fixture: ReturnType<typeof sectionCatalogFixture>) => void) {
		const fixture = sectionCatalogFixture();
		change(fixture);
		const app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", fixture.prisma as never);
		await app.register(registerSectionRoutes, { prefix: "/api/plex/sections" });
		try {
			return await createInjectAuthenticated(app)("GET", "/api/plex/sections");
		} finally {
			await app.close();
		}
	}

	it("does not expose a silently truncated section list when one owned instance is unavailable", async () => {
		const response = await read((f) => {
			f.instances.push({ ...f.instance, id: "plex-2", identityStatus: "UNVERIFIED" });
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
		expect(response.json()).toMatchObject({
			catalog: { availability: "unavailable", observedAt: null },
		});
	});

	it("does not present retained catalog values as current or promote failed canonical evidence", async () => {
		const response = await read((f) => {
			f.status.lastAttemptResult = "error";
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			catalog: { availability: "last-known" },
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				reasonCodes: ["latest_attempt_failed"],
			},
		});
	});

	it("withholds section contents from a V4 positive-only catalog without independent receipt proof", async () => {
		const response = await read((f) => {
			const {
				coverageReceipt: _receipt,
				ambiguousTmdbCandidates: _candidates,
				...legacy
			} = f.metadata;
			f.status.generationMetadata = JSON.stringify({
				...legacy,
				version: 4,
				partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
			});
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("sections");
	});
});
