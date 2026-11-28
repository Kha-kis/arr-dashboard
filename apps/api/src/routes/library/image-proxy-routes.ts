import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { withIsolatedRuntimePrismaReadClient } from "../../lib/backup/restore-runtime-client.js";
import {
	LIBRARY_POSTER_SERVICES,
	libraryPosterPath,
	readLibraryPoster,
} from "../../lib/library/poster-delivery.js";
import { validateRequest } from "../../lib/utils/validate.js";

const posterParams = z.object({
	instanceId: z.string().min(1).max(200),
	itemType: z.enum(["movie", "series", "artist", "author"]),
	itemId: z
		.string()
		.regex(/^[1-9]\d*$/)
		.transform(Number)
		.pipe(z.number().int().positive().max(2147483647)),
});

export const registerImageProxyRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/library/poster/:instanceId/:itemType/:itemId", async (request, reply) => {
		reply.header("Cache-Control", "no-store");
		reply.header("Vary", "Cookie");
		const { instanceId, itemType, itemId } = validateRequest(posterParams, request.params);
		const row = await withIsolatedRuntimePrismaReadClient(app.prisma, (prisma) =>
			prisma.libraryCache.findFirst({
				where: {
					instanceId,
					arrItemId: itemId,
					itemType,
					instance: {
						userId: request.currentUser!.id,
						enabled: true,
						service: LIBRARY_POSTER_SERVICES[itemType],
					},
				},
				select: { instanceId: true, arrItemId: true, itemType: true, data: true, instance: true },
			}),
		);
		if (!row) return reply.code(404).send({ error: "Poster not found" });

		// Provider I/O must not hold the serialized database display-read lane.
		// Credentials and the configured base URL stay inside the existing client.
		try {
			const response = await app.arrClientFactory.rawRequest(
				row.instance,
				libraryPosterPath(itemType, row.arrItemId, row.data),
				{ method: "GET", timeout: 5000, redirect: "error" },
			);
			if (!response.ok) {
				await response.body?.cancel();
				return reply.code(response.status === 404 ? 404 : 502).send({
					error: response.status === 404 ? "Poster not found" : "Invalid poster response",
				});
			}
			const poster = await readLibraryPoster(response);
			if (!poster) return reply.code(502).send({ error: "Invalid poster response" });
			return reply
				.header("Cache-Control", "private, max-age=300")
				.header("X-Content-Type-Options", "nosniff")
				.type(poster.contentType)
				.send(poster.bytes);
		} catch {
			// Do not forward/log provider errors: their message may contain secrets.
			return reply.code(503).send({ error: "Poster temporarily unavailable" });
		}
	});
	done();
};
