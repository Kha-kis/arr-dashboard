/**
 * Plex Collection & Label Management Routes
 *
 * CRUD endpoints for Plex collections and labels.
 * Reads from PlexCache for listing, writes back to Plex via PlexClient for mutations.
 */

import type { PlexTagItem, PlexTagsResponse, PlexTagUpdateRequest } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	isCurrentAuthoritativePlexEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import { PlexAuthorityService } from "../../lib/plex/plex-authority-service.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const instanceParams = z.object({
	instanceId: z.string().min(1),
});

const tagUpdateBody = z.object({
	type: z.enum(["collection", "label"]),
	action: z.enum(["add", "remove"]),
	name: z.string().min(1),
}) satisfies z.ZodType<PlexTagUpdateRequest>;

const ratingKeyParams = z.object({
	instanceId: z.string().min(1),
	ratingKey: z.string().min(1),
});

// ============================================================================
// Routes
// ============================================================================

export async function registerCollectionRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/:instanceId/collections
	 *
	 * Returns distinct collections from PlexCache for this instance.
	 */
	app.get("/:instanceId/collections", async (request, reply) => {
		const { instanceId } = validateRequest(instanceParams, request.params);
		const userId = request.currentUser!.id;
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId, service: "PLEX", enabled: true },
			select: { id: true },
		});
		if (!instance) {
			return reply.status(404).send({ error: "Instance not found or access denied" });
		}

		const collectionCounts = new Map<string, number>();
		const evidence = await new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		}).scanInstancePolicy({
			userId,
			instanceId,
			domains: ["membership", "collections"],
			onBatch: ({ rows }) => {
				for (const row of rows) {
					try {
						const parsed = JSON.parse(row.collections) as string[];
						for (const name of parsed) {
							if (name) collectionCounts.set(name, (collectionCounts.get(name) ?? 0) + 1);
						}
					} catch {
						// Skip malformed JSON
					}
				}
			},
		});
		const summary = summarizePlexEvidence([evidence]);
		if (!evidence.available || !isCurrentAuthoritativePlexEvidence(evidence.evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const collections: PlexTagItem[] = [...collectionCounts.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([name, count]) => ({ name, count }));

		const response: PlexTagsResponse = { collections, labels: [], evidence: summary };
		return reply.send(response);
	});

	/**
	 * GET /api/plex/:instanceId/labels
	 *
	 * Returns distinct labels from PlexCache for this instance.
	 */
	app.get("/:instanceId/labels", async (request, reply) => {
		const { instanceId } = validateRequest(instanceParams, request.params);
		const userId = request.currentUser!.id;
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId, service: "PLEX", enabled: true },
			select: { id: true },
		});
		if (!instance) {
			return reply.status(404).send({ error: "Instance not found or access denied" });
		}

		const labelCounts = new Map<string, number>();
		const evidence = await new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		}).scanInstancePolicy({
			userId,
			instanceId,
			domains: ["membership", "labels"],
			onBatch: ({ rows }) => {
				for (const row of rows) {
					try {
						const parsed = JSON.parse(row.labels) as string[];
						for (const name of parsed) {
							if (name) labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
						}
					} catch {
						// Skip malformed JSON
					}
				}
			},
		});
		const summary = summarizePlexEvidence([evidence]);
		if (!evidence.available || !isCurrentAuthoritativePlexEvidence(evidence.evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const labels: PlexTagItem[] = [...labelCounts.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([name, count]) => ({ name, count }));

		const response: PlexTagsResponse = { collections: [], labels, evidence: summary };
		return reply.send(response);
	});

	/**
	 * POST /api/plex/:instanceId/items/:ratingKey/tags
	 *
	 * Add or remove a collection/label from a Plex item.
	 */
	app.post("/:instanceId/items/:ratingKey/tags", async (request, reply) => {
		const { instanceId, ratingKey } = validateRequest(ratingKeyParams, request.params);
		const body = validateRequest(tagUpdateBody, request.body);
		const userId = request.currentUser!.id;

		const authority = new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		});
		const evidence = await authority.readInstance({
			userId,
			instanceId,
			domains: ["membership", body.type === "label" ? "labels" : "collections"],
		});
		if (!evidence.available || !isCurrentAuthoritativePlexEvidence(evidence.evidence)) {
			return reply.status(503).send({
				error: "Plex mutation authority is unavailable",
				evidence: evidence.evidence,
			});
		}
		const matches = evidence.rows.filter((row) => row.ratingKey?.trim() === ratingKey);
		if (
			matches.length !== 1 ||
			(matches[0]?.mediaType !== "movie" && matches[0]?.mediaType !== "series")
		) {
			return reply.status(409).send({ error: "Plex target identity is ambiguous or unavailable" });
		}
		const mutation = await authority.mutateMetadataTag({
			userId,
			instanceId,
			target: { tmdbId: matches[0].tmdbId, mediaType: matches[0].mediaType },
			expectedRatingKey: ratingKey,
			type: body.type,
			action: body.action,
			name: body.name,
		});
		if (!mutation.ok) {
			return reply.status(503).send({
				error: "Plex mutation authority changed before the upstream write",
				evidence: mutation.evidence,
			});
		}

		return reply.send({ success: true });
	});
}
