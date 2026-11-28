/**
 * Plex Library Scan Routes
 *
 * Triggers a Plex library section rescan. Useful after ARR imports to refresh Plex metadata.
 */

import type { PlexScanResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requirePlexClient } from "../../lib/plex/plex-helpers.js";
import { loadPlexSectionCatalog } from "../../lib/plex/plex-section-catalog.js";
import {
	createProviderPublicationAuthority,
	sameProviderPublicationAuthority,
} from "../../lib/services/provider-identity-guard.js";
import { validateRequest } from "../../lib/utils/validate.js";

const scanParams = z.object({
	instanceId: z.string().min(1),
	sectionId: z.string().min(1).regex(/^\d+$/, "sectionId must be numeric"),
});
const scanBody = z
	.object({
		sectionUuid: z
			.string()
			.trim()
			.min(1)
			.max(512)
			.refine((value) => !value.includes("\0")),
	})
	.strict();

export async function registerScanRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * POST /api/plex/:instanceId/sections/:sectionId/refresh
	 *
	 * Triggers a library section scan on the specified Plex instance.
	 */
	app.post("/:instanceId/sections/:sectionId/refresh", async (request, reply) => {
		const { instanceId, sectionId } = validateRequest(scanParams, request.params);
		const { sectionUuid } = validateRequest(scanBody, request.body);
		const userId = request.currentUser!.id;

		const { client, instance } = await requirePlexClient(app, userId, instanceId);
		const authority = createProviderPublicationAuthority(instance);
		const changed = () =>
			reply.status(409).send({
				error: "Plex server or section changed; reload the section list before requesting a scan",
			});
		const catalog = await loadPlexSectionCatalog(app.prisma, { userId, instanceId });
		if (!catalog.available)
			return reply.status(503).send({ error: "Plex section catalog is unavailable" });
		const selected = catalog.response.sections.filter(
			(section) => section.sectionId === sectionId && section.sectionUuid === sectionUuid,
		);
		if (
			selected.length !== 1 ||
			catalog.instances.length !== 1 ||
			!sameProviderPublicationAuthority(
				authority,
				createProviderPublicationAuthority(catalog.instances[0]!),
			)
		)
			return changed();
		try {
			const before = await client.getIdentity();
			if (before.machineIdentifier !== authority.expectedIdentity) return changed();
			const sections = await client.getLibrarySettlementSections({ uncached: true });
			const matchingKeys = sections.filter((section) => section.key === sectionId);
			const matchingUuids = sections.filter((section) => section.uuid === sectionUuid);
			const section = matchingKeys[0];
			if (
				matchingKeys.length !== 1 ||
				matchingUuids.length !== 1 ||
				!section ||
				section.uuid !== sectionUuid ||
				(section.type === "show" ? "series" : section.type) !== selected[0]!.mediaType ||
				section.refreshing
			)
				return changed();
			const after = await client.getIdentity();
			if (after.machineIdentifier !== authority.expectedIdentity) return changed();
		} catch {
			request.log.warn(
				{ category: "plex-section-scan-read-unavailable" },
				"Plex scan validation unavailable",
			);
			return reply
				.status(503)
				.send({ error: "Plex server or section could not be verified; no scan was requested" });
		}
		const current = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId, service: "PLEX", enabled: true },
		});
		if (
			!current ||
			!sameProviderPublicationAuthority(authority, createProviderPublicationAuthority(current))
		)
			return changed();

		try {
			await client.request(`/library/sections/${encodeURIComponent(sectionId)}/refresh`, {
				method: "POST",
			});
		} catch {
			request.log.warn(
				{ category: "plex-section-scan-unconfirmed" },
				"Plex scan acknowledgement unavailable",
			);
			return reply.status(502).send({
				error: "Plex library scan could not be confirmed; check server activity before retrying",
			});
		}

		const response: PlexScanResponse = {
			success: true,
			message: `Library scan triggered for section ${sectionId}`,
		};
		return reply.send(response);
	});
}
