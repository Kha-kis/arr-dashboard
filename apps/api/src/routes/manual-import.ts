import {
	manualImportCandidateListSchema,
	manualImportFetchQuerySchema,
	manualImportSubmissionSchema,
} from "@arr/shared";
import type { ManualImportCandidate, ManualImportSubmission } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";
import {
	ManualImportError,
	type ManualImportFetchOptions,
	fetchManualImportCandidates,
	submitManualImportCommand,
} from "./manual-import-utils.js";

const manualImportQuerySchema = manualImportFetchQuerySchema.extend({
	instanceId: z.string(),
	service: z.enum(["sonarr", "radarr"]),
});

const manualImportRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/manual-import", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { candidates: [] as ManualImportCandidate[] };
		}

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
			},
		});

		if (!instance || instance.service.toLowerCase() !== query.service) {
			reply.status(404);
			return { message: "Instance not found" };
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		const options: ManualImportFetchOptions = {
			downloadId: query.downloadId,
			folder: query.folder,
			seriesId: query.seriesId,
			seasonNumber: query.seasonNumber,
			filterExistingFiles: query.filterExistingFiles,
		};

		try {
			const candidates = await fetchManualImportCandidates(fetcher, query.service, options);
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
		if (!request.currentUser) {
			reply.status(401);
			return { success: false };
		}

		const body = manualImportSubmissionSchema.parse(request.body ?? {}) as ManualImportSubmission;

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: body.instanceId,
			},
		});

		if (!instance || instance.service.toLowerCase() !== body.service) {
			reply.status(404);
			return { success: false, message: "Instance not found" };
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			await submitManualImportCommand(fetcher, body.service, body.files, body.importMode ?? "auto");
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
