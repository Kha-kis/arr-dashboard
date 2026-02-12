import { manualImportFetchQuerySchema, manualImportSubmissionSchema } from "@arr/shared";
import type { ManualImportSubmission } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { SonarrClient, RadarrClient, LidarrClient, ReadarrClient } from "arr-sdk";
import { requireInstance } from "../lib/arr/instance-helpers.js";
import {
	type ManualImportFetchOptions,
	fetchManualImportCandidatesWithSdk,
	submitManualImportCommandWithSdk,
	setManualImportLogger,
} from "./manual-import-utils.js";

const manualImportQuerySchema = manualImportFetchQuerySchema.extend({
	instanceId: z.string(),
	service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
});

const manualImportRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Initialize the logger for manual import utilities
	setManualImportLogger({
		warn: (msg, ...args) => app.log.warn({ ...args[0] as object }, msg),
		debug: (msg, ...args) => app.log.debug({ ...args[0] as object }, msg),
	});

	app.get("/manual-import", async (request, reply) => {
		const query = manualImportQuerySchema.parse(request.query ?? {});

		if (!query.downloadId && !query.folder) {
			reply.status(400);
			return {
				error: "Provide either downloadId or folder to fetch manual import candidates.",
			};
		}

		const instance = await requireInstance(app, request.currentUser!.id, query.instanceId);

		if (instance.service.toLowerCase() !== query.service) {
			reply.status(404);
			return { error: "Instance not found" };
		}

		const client = app.arrClientFactory.create(instance) as
			SonarrClient | RadarrClient | LidarrClient | ReadarrClient;

		// Validate client type matches service
		if (query.service === "sonarr" && !(client instanceof SonarrClient)) {
			request.log.warn({ instanceId: query.instanceId, service: query.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Sonarr instance" };
		}
		if (query.service === "radarr" && !(client instanceof RadarrClient)) {
			request.log.warn({ instanceId: query.instanceId, service: query.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Radarr instance" };
		}
		if (query.service === "lidarr" && !(client instanceof LidarrClient)) {
			request.log.warn({ instanceId: query.instanceId, service: query.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Lidarr instance" };
		}
		if (query.service === "readarr" && !(client instanceof ReadarrClient)) {
			request.log.warn({ instanceId: query.instanceId, service: query.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Readarr instance" };
		}

		const options: ManualImportFetchOptions = {
			downloadId: query.downloadId,
			folder: query.folder,
			seriesId: query.seriesId,
			seasonNumber: query.seasonNumber,
			filterExistingFiles: query.filterExistingFiles,
		};

		try {
			// fetchManualImportCandidatesWithSdk already validates via Zod - no need to re-parse
			const candidates = await fetchManualImportCandidatesWithSdk(client, query.service, options);
			return reply.send({
				candidates,
				total: candidates.length,
			});
		} catch (error) {
			request.log.error(
				{ err: error, service: query.service, instanceId: query.instanceId },
				"Failed to fetch manual import candidates",
			);
			throw error;
		}
	});

	app.post("/manual-import", async (request, reply) => {
		const body = manualImportSubmissionSchema.parse(request.body ?? {}) as ManualImportSubmission;

		const instance = await requireInstance(app, request.currentUser!.id, body.instanceId);

		if (instance.service.toLowerCase() !== body.service) {
			reply.status(404);
			return { error: "Instance not found" };
		}

		const client = app.arrClientFactory.create(instance) as
			SonarrClient | RadarrClient | LidarrClient | ReadarrClient;

		// Validate client type matches service
		if (body.service === "sonarr" && !(client instanceof SonarrClient)) {
			request.log.warn({ instanceId: body.instanceId, service: body.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Sonarr instance" };
		}
		if (body.service === "radarr" && !(client instanceof RadarrClient)) {
			request.log.warn({ instanceId: body.instanceId, service: body.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Radarr instance" };
		}
		if (body.service === "lidarr" && !(client instanceof LidarrClient)) {
			request.log.warn({ instanceId: body.instanceId, service: body.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Lidarr instance" };
		}
		if (body.service === "readarr" && !(client instanceof ReadarrClient)) {
			request.log.warn({ instanceId: body.instanceId, service: body.service }, "Client type mismatch");
			reply.status(400);
			return { error: "Invalid client type for Readarr instance" };
		}

		try {
			await submitManualImportCommandWithSdk(
				client,
				body.service,
				body.files,
				body.importMode ?? "auto",
			);
		} catch (error) {
			request.log.error(
				{ err: error, service: body.service, instanceId: body.instanceId, fileCount: body.files.length },
				"Manual import command failed",
			);
			throw error;
		}

		return reply.status(204).send();
	});

	done();
};

export const registerManualImportRoutes = manualImportRoute;
