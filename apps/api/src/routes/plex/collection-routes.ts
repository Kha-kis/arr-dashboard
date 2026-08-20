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
	loadInstanceEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-evidence-repository.js";
import { requirePlexClient } from "../../lib/plex/plex-helpers.js";
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

		const evidence = await loadInstanceEvidence(app.prisma, { userId, instanceId });
		const summary = summarizePlexEvidence([evidence]);
		if (!evidence.available || !isCurrentAuthoritativePlexEvidence(evidence.evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const collectionCounts = new Map<string, number>();
		for (const row of evidence.rows) {
			try {
				const parsed = JSON.parse(row.collections) as string[];
				for (const name of parsed) {
					if (name) collectionCounts.set(name, (collectionCounts.get(name) ?? 0) + 1);
				}
			} catch {
				// Skip malformed JSON
			}
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

		const evidence = await loadInstanceEvidence(app.prisma, { userId, instanceId });
		const summary = summarizePlexEvidence([evidence]);
		if (!evidence.available || !isCurrentAuthoritativePlexEvidence(evidence.evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const labelCounts = new Map<string, number>();
		for (const row of evidence.rows) {
			try {
				const parsed = JSON.parse(row.labels) as string[];
				for (const name of parsed) {
					if (name) labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
				}
			} catch {
				// Skip malformed JSON
			}
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

		const { client } = await requirePlexClient(app, userId, instanceId);
		await client.updateMetadataTags(ratingKey, body.type, body.action, body.name);

		return reply.send({ success: true });
	});
}
