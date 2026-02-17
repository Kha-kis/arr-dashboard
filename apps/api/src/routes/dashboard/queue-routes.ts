import {
	queueActionRequestSchema,
	queueBulkActionRequestSchema,
	queueItemSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import type { SonarrClient, RadarrClient, LidarrClient, ReadarrClient } from "arr-sdk";
import {
	executeOnInstances,
	getClientForInstance,
	isSonarrClient,
	isRadarrClient,
	isLidarrClient,
	isReadarrClient,
} from "../../lib/arr/client-helpers.js";
import {
	normalizeQueueItem,
	parseQueueId,
	triggerQueueSearchWithSdk,
	type QueueService,
	type QueueClient,
} from "../../lib/dashboard/queue-utils.js";
import { autoImportByDownloadIdWithSdk, setManualImportLogger } from "../manual-import-utils.js";
import { validateRequest } from "../../lib/utils/validate.js";

/**
 * Queue-related routes for the dashboard
 */
export const queueRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Initialize the logger for manual import utilities (used by auto-import feature)
	setManualImportLogger({
		warn: (msg, ...args) => app.log.warn({ ...(args[0] as object) }, msg),
		debug: (msg, ...args) => app.log.debug({ ...(args[0] as object) }, msg),
	});

	/**
	 * GET /dashboard/queue
	 * Fetches the download queue from all enabled Sonarr, Radarr, Lidarr, and Readarr instances
	 */
	app.get("/dashboard/queue", async (request, reply) => {
		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: ["SONARR", "RADARR", "LIDARR", "READARR"] },
			async (client, instance) => {
				const service = instance.service.toLowerCase() as QueueService;

				// Use SDK to fetch queue items based on service type
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
				} else if (isLidarrClient(client)) {
					const result = await client.queue.get({
						pageSize: 1000,
						includeUnknownArtistItems: true,
					});
					rawItems = result.records ?? [];
				} else if (isReadarrClient(client)) {
					const result = await client.queue.get({
						pageSize: 1000,
						includeUnknownAuthorItems: true,
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
			service: result.service as QueueService,
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
		const body = validateRequest(queueActionRequestSchema, request.body);

		const clientResult = await getClientForInstance(app, request, body.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				success: false,
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as QueueService;

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

		if (body.action === "manualImport") {
			const downloadId = typeof body.downloadId === "string" ? body.downloadId.trim() : "";

			if (!downloadId) {
				return reply.status(400).send({
					success: false,
					message: "Manual import requires a download identifier.",
				});
			}

			// Manual import supported for all *arr services with download queues
			await autoImportByDownloadIdWithSdk(
				client as SonarrClient | RadarrClient | LidarrClient | ReadarrClient,
				service,
				downloadId,
			);
		} else if (body.action === "retry") {
			// Retry by removing from queue without blocklisting
			const deleteOptions = {
				removeFromClient: body.removeFromClient ?? true,
				blocklist: false,
				changeCategory: false,
			};

			if (isSonarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			} else if (isRadarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			} else if (isLidarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			} else if (isReadarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			}
		} else {
			// Remove action
			const deleteOptions = {
				removeFromClient: body.removeFromClient,
				blocklist: body.blocklist,
				changeCategory: body.changeCategory,
			};

			if (isSonarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			} else if (isRadarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			} else if (isLidarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			} else if (isReadarrClient(client)) {
				await client.queue.delete(queueId, deleteOptions);
			}

			// Trigger search if requested
			if (body.search) {
				try {
					await triggerQueueSearchWithSdk(client as QueueClient, service, body.searchPayload);
				} catch (error) {
					request.log.error({ err: error, queueId, service }, "queue search trigger failed");
				}
			}
		}

		return reply.status(204).send();
	});

	/**
	 * POST /dashboard/queue/bulk
	 * Performs an action on multiple queue items at once
	 */
	app.post("/dashboard/queue/bulk", async (request, reply) => {
		const body = validateRequest(queueBulkActionRequestSchema, request.body);

		const clientResult = await getClientForInstance(app, request, body.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				success: false,
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as QueueService;

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

		const deleteOptions =
			body.action === "retry"
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
		} else if (isLidarrClient(client)) {
			// Lidarr's bulkDelete takes a combined object with ids and options
			await client.queue.bulkDelete({ ids: queueIds, ...deleteOptions });
		} else if (isReadarrClient(client)) {
			await client.queue.bulkDelete(queueIds, deleteOptions);
		}

		return reply.status(204).send();
	});

	done();
};
