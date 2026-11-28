import { createHash } from "node:crypto";
import {
	manualImportFetchQuerySchema,
	manualImportLegacyQuerySchema,
	manualImportRemainderParamsSchema,
	manualImportSourceQuerySchema,
	manualImportSubmissionSchema,
} from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { readImportRemainderReview } from "../lib/arr/import-operations/remainder-review.js";
import { importRequestFingerprint } from "../lib/arr/import-operations/selection.js";
import {
	readCachedImportStatus,
	readCachedImportStatusByAttemptKey,
	readCachedLegacyImportStatus,
	readCachedSourceImportStatus,
	serializeImportStatus,
} from "../lib/arr/import-operations/status.js";
import {
	ImportPreparationLimitError,
	submitTrackedImport,
	TrackedImportConflictError,
} from "../lib/arr/import-operations/submission.js";
import { requireInstance } from "../lib/arr/instance-helpers.js";
import { validateRequest } from "../lib/utils/validate.js";
import {
	fetchManualImportCandidatesWithSdk,
	type ManualImportFetchOptions,
	setManualImportLogger,
} from "./manual-import-utils.js";

const manualImportQuerySchema = manualImportFetchQuerySchema.extend({
	instanceId: z.string(),
	service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
});

const manualImportRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Initialize the logger for manual import utilities
	setManualImportLogger({
		warn: (msg, ...args) => app.log.warn({ ...(args[0] as object) }, msg),
		debug: (msg, ...args) => app.log.debug({ ...(args[0] as object) }, msg),
	});

	app.get("/manual-import", async (request, reply) => {
		const query = validateRequest(manualImportQuerySchema, request.query ?? {});

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
			| SonarrClient
			| RadarrClient
			| LidarrClient
			| ReadarrClient;

		// Validate client type matches service
		if (query.service === "sonarr" && !(client instanceof SonarrClient)) {
			request.log.warn(
				{ instanceId: query.instanceId, service: query.service },
				"Client type mismatch",
			);
			reply.status(400);
			return { error: "Invalid client type for Sonarr instance" };
		}
		if (query.service === "radarr" && !(client instanceof RadarrClient)) {
			request.log.warn(
				{ instanceId: query.instanceId, service: query.service },
				"Client type mismatch",
			);
			reply.status(400);
			return { error: "Invalid client type for Radarr instance" };
		}
		if (query.service === "lidarr" && !(client instanceof LidarrClient)) {
			request.log.warn(
				{ instanceId: query.instanceId, service: query.service },
				"Client type mismatch",
			);
			reply.status(400);
			return { error: "Invalid client type for Lidarr instance" };
		}
		if (query.service === "readarr" && !(client instanceof ReadarrClient)) {
			request.log.warn(
				{ instanceId: query.instanceId, service: query.service },
				"Client type mismatch",
			);
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

		// fetchManualImportCandidatesWithSdk already validates via Zod - no need to re-parse
		const candidates = await fetchManualImportCandidatesWithSdk(client, query.service, options);
		return reply.send({
			candidates,
			total: candidates.length,
		});
	});

	app.post("/manual-import", async (request, reply) => {
		const body = validateRequest(manualImportSubmissionSchema, request.body ?? {});
		if (body.files.length > 1000) throw new ImportPreparationLimitError();
		const userId = request.currentUser!.id;

		// Older clients cannot express a new intentional retry. Bind their identical
		// requests permanently to one attempt rather than minting replay permission.
		const idempotencyKey =
			body.idempotencyKey ??
			`manual-compat-v1:${createHash("sha256")
				.update(
					JSON.stringify([
						userId,
						body.instanceId,
						body.service,
						body.importMode === "copy" ? "Copy" : "Move",
						importRequestFingerprint(body.files),
					]),
				)
				.digest("hex")}`;
		const existing = await app.prisma.arrImportOperation.findFirst({
			where: { userId, idempotencyKey },
			select: { id: true },
		});
		if (!existing) {
			const instance = await requireInstance(app, userId, body.instanceId);
			if (instance.service.toLowerCase() !== body.service)
				return reply.status(404).send({ error: "Instance not found" });
		}
		// The shared tracker validates immutable bindings even on historical retries.
		// Current connection authority is needed for new work, not cached observation.
		const operation = await submitTrackedImport(
			{
				prisma: app.prisma,
				encryptor: app.encryptor,
				createClient: (ownedInstance, options) => {
					if (
						ownedInstance.service !== "SONARR" &&
						ownedInstance.service !== "RADARR" &&
						ownedInstance.service !== "LIDARR" &&
						ownedInstance.service !== "READARR"
					)
						throw new TrackedImportConflictError();
					return app.arrClientFactory.create(
						{ ...ownedInstance, service: ownedInstance.service },
						options,
					);
				},
			},
			{ ...body, userId, origin: "manual", idempotencyKey },
		);
		return reply.status(202).send(serializeImportStatus(operation));
	});

	app.get("/manual-import/operations", async (request, reply) => {
		const { idempotencyKey } = validateRequest(
			z.object({ idempotencyKey: manualImportSubmissionSchema.shape.idempotencyKey }).required(),
			request.query,
		);
		const status = await readCachedImportStatusByAttemptKey(
			app.prisma,
			request.currentUser!.id,
			idempotencyKey,
		);
		if (!status) return reply.status(404).send({ error: "Import operation not found" });
		return reply.send(status);
	});
	app.get("/manual-import/legacy", async (request, reply) => {
		const query = validateRequest(manualImportLegacyQuerySchema, request.query);
		const status = await readCachedLegacyImportStatus(app.prisma, request.currentUser!.id, query);
		if (!status) return reply.status(404).send({ error: "Instance not found" });
		return reply.send(status);
	});
	app.get("/manual-import/source", async (request, reply) => {
		const query = validateRequest(manualImportSourceQuerySchema, request.query);
		const status = await readCachedSourceImportStatus(app.prisma, request.currentUser!.id, query);
		if (!status) return reply.status(404).send({ error: "Instance not found" });
		return reply.send(status);
	});

	app.get("/manual-import/operations/:operationId", async (request, reply) => {
		const { operationId } = validateRequest(
			z.object({ operationId: z.string().min(1).max(128) }),
			request.params,
		);
		const status = await readCachedImportStatus(app.prisma, request.currentUser!.id, operationId);
		if (!status) return reply.status(404).send({ error: "Import operation not found" });
		return reply.send(status);
	});
	app.get("/manual-import/operations/:operationId/remainder", async (request, reply) => {
		const { operationId } = validateRequest(manualImportRemainderParamsSchema, request.params);
		const query = validateRequest(manualImportLegacyQuerySchema, request.query);
		const review = await readImportRemainderReview(
			{
				prisma: app.prisma,
				encryptor: app.encryptor,
				createClient: (instance, options) => {
					if (
						instance.service !== "SONARR" &&
						instance.service !== "RADARR" &&
						instance.service !== "LIDARR" &&
						instance.service !== "READARR"
					)
						throw new TrackedImportConflictError();
					return app.arrClientFactory.create({ ...instance, service: instance.service }, options);
				},
			},
			request.currentUser!.id,
			operationId,
			query,
		);
		return reply.send(review);
	});

	done();
};

export const registerManualImportRoutes = manualImportRoute;
