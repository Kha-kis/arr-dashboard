import {
	queueActionRequestSchema,
	queueBulkActionRequestSchema,
	queueItemSchema,
} from "@arr/shared";
import type { QueueItem } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { fetchQueueItems } from "../../lib/dashboard/fetch-utils.js";
import { parseQueueId, queueApiPath, triggerQueueSearch } from "../../lib/dashboard/queue-utils.js";
import { ManualImportError, autoImportByDownloadId } from "../manual-import-utils.js";

/**
 * Queue-related routes for the dashboard
 */
export const queueRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /dashboard/queue
	 * Fetches the download queue from all enabled Sonarr and Radarr instances
	 */
	app.get("/dashboard/queue", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { instances: [], aggregated: [], totalCount: 0 };
		}

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser.id, enabled: true },
		});

		const results: Array<{
			instanceId: string;
			instanceName: string;
			service: "sonarr" | "radarr";
			data: QueueItem[];
		}> = [];
		const aggregated: QueueItem[] = [];

		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			if (service !== "sonarr" && service !== "radarr") {
				continue;
			}

			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				const items = await fetchQueueItems(fetcher, service);
				const enriched = items.map((item: unknown) => ({
					...item as Record<string, unknown>,
					instanceId: instance.id,
					instanceName: instance.label,
				}));
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: enriched.map((item: unknown) => queueItemSchema.parse(item)),
				});
				aggregated.push(...enriched.map((item: unknown) => queueItemSchema.parse(item)));
			} catch (error: unknown) {
				request.log.error({ err: error, instance: instance.id }, "queue fetch failed");
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: [],
				});
			}
		}

		return reply.send({
			instances: results,
			aggregated,
			totalCount: aggregated.length,
		});
	});

	/**
	 * POST /dashboard/queue/action
	 * Performs an action on a single queue item (remove, retry, or manual import)
	 */
	app.post("/dashboard/queue/action", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { success: false };
		}

		const body = queueActionRequestSchema.parse(request.body);
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: body.instanceId, userId: request.currentUser.id },
		});

		if (!instance || instance.service.toLowerCase() !== body.service) {
			reply.status(404);
			return { success: false, message: "Instance not found" };
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		const queueId = parseQueueId(body.itemId);

		if (queueId === null) {
			reply.status(400);
			return { success: false, message: "Invalid queue identifier" };
		}

		if (body.action === "manualImport") {
			const downloadId = typeof body.downloadId === "string" ? body.downloadId.trim() : "";

			if (!downloadId) {
				reply.status(400);
				return {
					success: false,
					message: "Manual import requires a download identifier.",
				};
			}

			try {
				await autoImportByDownloadId(fetcher, body.service, downloadId);
			} catch (error) {
				// Type guard for errors with HTTP status codes
				const hasStatusCode = (err: unknown): err is Error & { statusCode: number } => {
					return (
						err instanceof Error &&
						"statusCode" in err &&
						typeof (err as Record<string, unknown>).statusCode === "number"
					);
				};

				const status =
					error instanceof ManualImportError
						? error.statusCode
						: hasStatusCode(error)
							? error.statusCode
							: 502;

				const message =
					error instanceof Error && error.message ? error.message : "ARR manual import failed.";

				reply.status(status);
				return { success: false, message };
			}
		} else if (body.action === "retry") {
			// Retry by removing from queue without blocklisting, allowing ARR to retry automatically
			const search = new URLSearchParams({
				removeFromClient: String(body.removeFromClient ?? true),
				blocklist: "false",
				changeCategory: "false",
			});
			await fetcher(`${queueApiPath(body.service)}/${queueId}?${search.toString()}`, {
				method: "DELETE",
			});
		} else {
			const search = new URLSearchParams({
				removeFromClient: String(body.removeFromClient),
				blocklist: String(body.blocklist),
				changeCategory: String(body.changeCategory),
			});
			await fetcher(`${queueApiPath(body.service)}/${queueId}?${search.toString()}`, {
				method: "DELETE",
			});
			if (body.search) {
				try {
					await triggerQueueSearch(fetcher, body.service, body.searchPayload);
				} catch (error) {
					request.log.error(
						{ err: error, queueId, service: body.service },
						"queue search trigger failed",
					);
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
		if (!request.currentUser) {
			reply.status(401);
			return { success: false };
		}

		const body = queueBulkActionRequestSchema.parse(request.body);
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: body.instanceId, userId: request.currentUser.id },
		});

		if (!instance || instance.service.toLowerCase() !== body.service) {
			reply.status(404);
			return { success: false, message: "Instance not found" };
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		const queueIds: number[] = [];
		for (const id of body.ids) {
			const parsed = parseQueueId(id);
			if (parsed === null) {
				reply.status(400);
				return { success: false, message: "Invalid queue identifier" };
			}
			queueIds.push(parsed);
		}

		if (body.action === "manualImport") {
			reply.status(400);
			return {
				success: false,
				message: "Manual import cannot be processed as a bulk action.",
			};
		}

		if (body.action === "retry") {
			// Retry by removing from queue without blocklisting, allowing ARR to retry automatically
			await fetcher(`${queueApiPath(body.service)}/bulk`, {
				method: "DELETE",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					ids: queueIds,
					removeFromClient: body.removeFromClient ?? true,
					blocklist: false,
					changeCategory: false,
				}),
			});
		} else {
			await fetcher(`${queueApiPath(body.service)}/bulk`, {
				method: "DELETE",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					ids: queueIds,
					removeFromClient: body.removeFromClient,
					blocklist: body.blocklist,
					changeCategory: body.changeCategory,
				}),
			});
		}

		return reply.status(204).send();
	});

	done();
};
