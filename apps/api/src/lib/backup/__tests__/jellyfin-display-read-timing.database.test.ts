import Fastify from "fastify";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { registerWatchEnrichmentRoutes } from "../../../routes/jellyfin/watch-enrichment-routes.js";
import { registerSeriesProgressRoutes } from "../../../routes/jellyfin/series-progress-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";

afterEach(closeScopedWriteFixtures);

it.each(["watch", "progress"] as const)(
	"emits only generic timing for the real %s cached route without changing its response",
	async (kind) => {
		const f = await createScopedWriteFixture();
		const records: Record<string, unknown>[] = [];
		const app = Fastify({
			loggerInstance: pino(
				{ level: "info" },
				{
					write(line) {
						const value = JSON.parse(line);
						if (value.category === "jellyfin-display-read-timing") records.push(value);
					},
				},
			),
		});
		try {
			app.decorate("prisma", f.client.prisma);
			app.decorate("restoreRuntime", f.runtime);
			app.addHook("preHandler", async (request) => {
				request.currentUser = { id: "synthetic-user" } as NonNullable<typeof request.currentUser>;
			});
			await app.register(
				kind === "watch" ? registerWatchEnrichmentRoutes : registerSeriesProgressRoutes,
			);
			const response = await f.runtime.runOperation(() =>
				app.inject({
					method: "GET",
					url: kind === "watch" ? "/?tmdbIds=424242&types=movie" : "/?tmdbIds=424242",
				}),
			);
			expect(response.statusCode).toBe(200);
			if (kind === "watch") expect(response.json().items).toEqual({});
			else
				expect(response.json().progress).toEqual({
					"424242": {
						status: "unknown",
						total: null,
						watched: null,
						percent: null,
						watchedSemantics: "unknown",
					},
				});
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				category: "jellyfin-display-read-timing",
				kind,
				spansOverlap: true,
			});
			expect(Object.keys(records[0]!).sort()).toEqual(
				[
					"category",
					"kind",
					"level",
					"msg",
					"pid",
					"hostname",
					"spansOverlap",
					"stages",
					"runtime",
					"time",
				].sort(),
			);
			const serialized = JSON.stringify({
				stages: records[0]!.stages,
				runtime: records[0]!.runtime,
			});
			for (const forbidden of [
				"synthetic",
				"424242",
				"instanceId",
				"userId",
				"generationId",
				"error",
				"rows",
				"title",
				"label",
				"url",
			])
				expect(serialized).not.toContain(forbidden);
			for (const stages of [records[0]!.stages, records[0]!.runtime])
				for (const counter of Object.values(
					stages as Record<string, { count: number; totalMs: number; maxMs: number }>,
				)) {
					expect(Object.keys(counter).sort()).toEqual(["count", "maxMs", "totalMs"]);
					for (const n of Object.values(counter)) expect(Number.isFinite(n) && n >= 0).toBe(true);
				}
		} finally {
			await app.close();
		}
	},
);
