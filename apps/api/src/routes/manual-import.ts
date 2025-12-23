import {
	manualImportCandidateListSchema,
	manualImportFetchQuerySchema,
	manualImportSubmissionSchema,
} from "@arr/shared";
import type { ManualImportSubmission } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { SonarrClient, RadarrClient } from "arr-sdk";
import {
	ManualImportError,
	type ManualImportFetchOptions,
	fetchManualImportCandidatesWithSdk,
	submitManualImportCommandWithSdk,
} from "./manual-import-utils.js";

const manualImportQuerySchema = manualImportFetchQuerySchema.extend({
	instanceId: z.string(),
	service: z.enum(["sonarr", "radarr"]),
});

const manualImportRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	app.get("/manual-import", async (request, reply) => {
		const query = manualImportQuerySchema.parse(request.query ?? {});

		if (!query.downloadId && !query.folder) {
			reply.status(400);
			return {
				message: "Provide either downloadId or folder to fetch manual import candidates.",
			};
		}

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: query.instanceId,
				userId: request.currentUser?.id,
			},
		});

		if (!instance || instance.service.toLowerCase() !== query.service) {
			reply.status(404);
			return { message: "Instance not found" };
		}

		const client = app.arrClientFactory.create(instance);

		// Validate client type matches service
		if (query.service === "sonarr" && !(client instanceof SonarrClient)) {
			reply.status(400);
			return { message: "Invalid client type for Sonarr instance" };
		}
		if (query.service === "radarr" && !(client instanceof RadarrClient)) {
			reply.status(400);
			return { message: "Invalid client type for Radarr instance" };
		}

		const options: ManualImportFetchOptions = {
			downloadId: query.downloadId,
			folder: query.folder,
			seriesId: query.seriesId,
			seasonNumber: query.seasonNumber,
			filterExistingFiles: query.filterExistingFiles,
		};

		try {
			const candidates = await fetchManualImportCandidatesWithSdk(client, query.service, options);
			const parsed = manualImportCandidateListSchema.parse(candidates);
			return reply.send({
				candidates: parsed,
				total: parsed.length,
			});
		} catch (error) {
			const status = error instanceof ManualImportError ? error.statusCode : 502;
			const message =
				error instanceof Error ? error.message : "Unable to fetch manual import candidates.";
			reply.status(status);
			return { message };
		}
	});

	app.post("/manual-import", async (request, reply) => {
		const body = manualImportSubmissionSchema.parse(request.body ?? {}) as ManualImportSubmission;

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: body.instanceId,
				userId: request.currentUser?.id,
			},
		});

		if (!instance || instance.service.toLowerCase() !== body.service) {
			reply.status(404);
			return { success: false, message: "Instance not found" };
		}

		const client = app.arrClientFactory.create(instance);

		// Validate client type matches service
		if (body.service === "sonarr" && !(client instanceof SonarrClient)) {
			reply.status(400);
			return { success: false, message: "Invalid client type for Sonarr instance" };
		}
		if (body.service === "radarr" && !(client instanceof RadarrClient)) {
			reply.status(400);
			return { success: false, message: "Invalid client type for Radarr instance" };
		}

		try {
			await submitManualImportCommandWithSdk(client, body.service, body.files, body.importMode ?? "auto");
		} catch (error) {
			const status = error instanceof ManualImportError ? error.statusCode : 502;
			const message = error instanceof Error ? error.message : "Manual import failed.";
			reply.status(status);
			return { success: false, message };
		}

		return reply.status(204).send();
	});

	done();
};

export const registerManualImportRoutes = manualImportRoute;
