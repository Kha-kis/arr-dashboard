import {
	queueActionRequestSchema,
	queueBulkActionRequestSchema,
	queueItemSchema,
} from "@arr/shared";
import type { QueueItem } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { SonarrClient, RadarrClient } from "arr-sdk";
import {
	executeOnInstances,
	getClientForInstance,
	isSonarrClient,
	isRadarrClient,
} from "../../lib/arr/client-helpers.js";
import { ArrError, arrErrorToHttpStatus } from "../../lib/arr/client-factory.js";
import { normalizeQueueItem, parseQueueId, triggerQueueSearchWithSdk } from "../../lib/dashboard/queue-utils.js";
import { ManualImportError, autoImportByDownloadIdWithSdk } from "../manual-import-utils.js";

/**
 * Queue-related routes for the dashboard
 */
export const queueRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /dashboard/queue
	 * Fetches the download queue from all enabled Sonarr and Radarr instances
	 */
	app.get("/dashboard/queue", async (request, reply) => {
		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: ["SONARR", "RADARR"] },
			async (client, instance) => {
				const service = instance.service.toLowerCase() as "sonarr" | "radarr";

				// Use SDK to fetch queue items
				let rawItems: unknown[];
				if (isSonarrClient(client)) {
					const result = await client.queue.get({
						pageSize: 1000,
						includeUnknownSeriesItems: true,
					});
					rawItems = result.records ?? [];
				} else if (isRadarrClient(client)) {
					const result = await client.queue.get({
						pageSize: 1000,
					});
					rawItems = result.records ?? [];
				} else {
					return [];
				}

				// Normalize and enrich items
				return rawItems.map((raw) => {
					const normalized = normalizeQueueItem(raw, service);
					return queueItemSchema.parse({
						...normalized,
						instanceId: instance.id,
						instanceName: instance.label,
					});
				});
			},
		);

		// Transform results to match expected format
		const results = response.instances.map((result) => ({
			instanceId: result.instanceId,
			instanceName: result.instanceName,
			service: result.service as "sonarr" | "radarr",
			data: result.success ? result.data : [],
		}));

		return reply.send({
			instances: results,
			aggregated: response.aggregated,
			totalCount: response.totalCount,
		});
	});

	/**
	 * POST /dashboard/queue/action
	 * Performs an action on a single queue item (remove, retry, or manual import)
	 */
	app.post("/dashboard/queue/action", async (request, reply) => {
		const body = queueActionRequestSchema.parse(request.body);

		const clientResult = await getClientForInstance(app, request, body.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				success: false,
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as "sonarr" | "radarr";

		if (service !== body.service) {
			return reply.status(400).send({
				success: false,
				message: "Service type mismatch",
			});
		}

		const queueId = parseQueueId(body.itemId);
		if (queueId === null) {
			return reply.status(400).send({
				success: false,
				message: "Invalid queue identifier",
			});
		}

		try {
			if (body.action === "manualImport") {
				const downloadId = typeof body.downloadId === "string" ? body.downloadId.trim() : "";

				if (!downloadId) {
					return reply.status(400).send({
						success: false,
						message: "Manual import requires a download identifier.",
					});
				}

				await autoImportByDownloadIdWithSdk(
					client as SonarrClient | RadarrClient,
					service,
					downloadId,
				);
			} else if (body.action === "retry") {
				// Retry by removing from queue without blocklisting
				if (isSonarrClient(client)) {
					await client.queue.delete(queueId, {
						removeFromClient: body.removeFromClient ?? true,
						blocklist: false,
						changeCategory: false,
					});
				} else if (isRadarrClient(client)) {
					await client.queue.delete(queueId, {
						removeFromClient: body.removeFromClient ?? true,
						blocklist: false,
						changeCategory: false,
					});
				}
			} else {
				// Remove action
				if (isSonarrClient(client)) {
					await client.queue.delete(queueId, {
						removeFromClient: body.removeFromClient,
						blocklist: body.blocklist,
						changeCategory: body.changeCategory,
					});
				} else if (isRadarrClient(client)) {
					await client.queue.delete(queueId, {
						removeFromClient: body.removeFromClient,
						blocklist: body.blocklist,
						changeCategory: body.changeCategory,
					});
				}

				// Trigger search if requested
				if (body.search) {
					try {
						await triggerQueueSearchWithSdk(
							client as SonarrClient | RadarrClient,
							service,
							body.searchPayload,
						);
					} catch (error) {
						request.log.error(
							{ err: error, queueId, service },
							"queue search trigger failed",
						);
					}
				}
			}

			return reply.status(204).send();
		} catch (error) {
			if (error instanceof ManualImportError) {
				return reply.status(error.statusCode).send({
					success: false,
					message: error.message,
				});
			}

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					success: false,
					message: error.message,
				});
			}

			throw error;
		}
	});

	/**
	 * POST /dashboard/queue/bulk
	 * Performs an action on multiple queue items at once
	 */
	app.post("/dashboard/queue/bulk", async (request, reply) => {
		const body = queueBulkActionRequestSchema.parse(request.body);

		const clientResult = await getClientForInstance(app, request, body.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				success: false,
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as "sonarr" | "radarr";

		if (service !== body.service) {
			return reply.status(400).send({
				success: false,
				message: "Service type mismatch",
			});
		}

		const queueIds: number[] = [];
		for (const id of body.ids) {
			const parsed = parseQueueId(id);
			if (parsed === null) {
				return reply.status(400).send({
					success: false,
					message: "Invalid queue identifier",
				});
			}
			queueIds.push(parsed);
		}

		if (body.action === "manualImport") {
			return reply.status(400).send({
				success: false,
				message: "Manual import cannot be processed as a bulk action.",
			});
		}

		try {
			const deleteOptions = body.action === "retry"
				? {
						removeFromClient: body.removeFromClient ?? true,
						blocklist: false,
						changeCategory: false,
					}
				: {
						removeFromClient: body.removeFromClient,
						blocklist: body.blocklist,
						changeCategory: body.changeCategory,
					};

			if (isSonarrClient(client)) {
				await client.queue.bulkDelete(queueIds, deleteOptions);
			} else if (isRadarrClient(client)) {
				await client.queue.bulkDelete(queueIds, deleteOptions);
			}

			return reply.status(204).send();
		} catch (error) {
			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					success: false,
					message: error.message,
				});
			}

			throw error;
		}
	});

	done();
};
