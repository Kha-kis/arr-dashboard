/**
 * Plex Section Routes
 *
 * Returns distinct library sections from PlexCache for use in cleanup rule filtering.
 */

import type { PlexSectionsResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	hasAuthoritativeSelectedPlexEvidence,
	loadUserSelectedEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-evidence-repository.js";
import { mapToSections } from "./lib/section-helpers.js";

export async function registerSectionRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/sections
	 *
	 * Returns distinct (sectionId, sectionTitle, mediaType) tuples from PlexCache,
	 * scoped to the current user's Plex instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const evidence = await loadUserSelectedEvidence(app.prisma, {
			userId,
			selection: { kind: "authority-only" },
		});
		const summary = summarizePlexEvidence(evidence);
		if (!hasAuthoritativeSelectedPlexEvidence(evidence)) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: summary,
			});
		}
		const publishedSections = evidence.flatMap((entry) =>
			entry.sections.map((section) => ({
				...section,
				instanceId: entry.instanceId,
				instanceName: entry.instanceName,
			})),
		);
		const instanceMap = new Map(
			publishedSections.map((section) => [section.instanceId, section.instanceName]),
		);
		const sections = mapToSections(
			publishedSections.map((section) => ({
				instanceId: section.instanceId,
				sectionId: section.key,
				sectionTitle: section.title,
				mediaType: section.type === "show" ? "series" : "movie",
			})),
			instanceMap,
		);

		return reply.send({ sections, evidence: summary } satisfies PlexSectionsResponse);
	});
}
