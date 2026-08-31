import { createHash, randomBytes } from "node:crypto";
import { ARR_SERVICES_UPPER, type HistoryQuery, historyQuerySchema } from "@arr/shared";
import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { z } from "zod";
import type { ArrClient } from "../../lib/arr/client-factory.js";
import {
	isLidarrClient,
	isProwlarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../../lib/arr/client-helpers.js";
import {
	type HistoryCursor,
	HistoryCursorStaleError,
	type HistoryProviderStream,
	type HistoryService,
	historyCursorSchema,
	normalizeHistoryItem,
	paginateHistoryStreams,
} from "../../lib/dashboard/history-utils.js";
import { validateRequest } from "../../lib/utils/validate.js";

const historyCursorBindingSchema = z.object({
	instanceId: z.string(),
	service: z.string(),
	connectionGeneration: z.number().int().nonnegative(),
	identityGeneration: z.number().int().nonnegative(),
	updatedAt: z.string(),
});

const historyCursorEnvelopeSchema = z.object({
	version: z.literal(1),
	userId: z.string(),
	queryHash: z.string(),
	bindings: z.array(historyCursorBindingSchema),
	cursor: historyCursorSchema,
});

type HistoryCursorBinding = z.infer<typeof historyCursorBindingSchema>;
type HistoryCursorEnvelope = z.infer<typeof historyCursorEnvelopeSchema>;

const HISTORY_CURSOR_TTL_MS = 30 * 60 * 1000;

const historyQueryHash = (query: Omit<HistoryQuery, "cursor">): string =>
	createHash("sha256").update(JSON.stringify(query)).digest("base64url");

const historyCursorHandleHash = (handle: string): string =>
	createHash("sha256").update(handle).digest("hex");

const bindingsMatch = (left: HistoryCursorBinding[], right: HistoryCursorBinding[]): boolean =>
	JSON.stringify(left) === JSON.stringify(right);

const cursorConflict = (reply: FastifyReply) =>
	reply.status(409).send({
		error: "History changed while paging. Refresh to restart from the newest records.",
	});

const fetchHistoryPage = (
	client: ArrClient,
	service: HistoryService,
	request: { page: number; pageSize: number },
	query: Pick<HistoryQuery, "startDate" | "endDate" | "sortDirection">,
) => {
	const common = {
		page: request.page,
		pageSize: request.pageSize,
		sortKey: "date" as const,
		sortDirection: query.sortDirection,
	};
	const dated = {
		...common,
		...(query.startDate && { since: query.startDate }),
		...(query.endDate && { until: query.endDate }),
	};

	if (isSonarrClient(client)) return client.history.get(dated);
	if (isRadarrClient(client)) return client.history.get(dated);
	if (isProwlarrClient(client)) return client.history.get(common);
	if (isLidarrClient(client)) return client.history.get(dated);
	if (isReadarrClient(client)) return client.history.get(dated);
	throw new Error(`Unsupported History client for ${service}`);
};

/**
 * History-related routes for the dashboard.
 */
export const historyRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get<{ Querystring: HistoryQuery }>("/dashboard/history", async (request, reply) => {
		const query = validateRequest(historyQuerySchema, request.query ?? {});
		const {
			cursor: cursorHandle,
			pageSize,
			sortDirection,
			service: serviceFilter,
			instanceId,
			status,
			searchTerm,
			hideProwlarrRss,
			startDate,
			endDate,
		} = query;
		const normalizedQuery = {
			startDate,
			endDate,
			pageSize,
			sortKey: query.sortKey,
			sortDirection,
			service: serviceFilter,
			instanceId,
			status,
			searchTerm,
			hideProwlarrRss,
		};
		const queryHash = historyQueryHash(normalizedQuery);
		const selectedServiceTypes = serviceFilter
			? [serviceFilter.toUpperCase() as (typeof ARR_SERVICES_UPPER)[number]]
			: [...ARR_SERVICES_UPPER];

		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId: request.currentUser!.id,
				enabled: true,
				service: { in: selectedServiceTypes },
				...(instanceId ? { id: { in: [instanceId] } } : {}),
			},
			orderBy: [{ label: "asc" }, { id: "asc" }],
		});
		const bindings: HistoryCursorBinding[] = instances
			.map((instance) => ({
				instanceId: instance.id,
				service: instance.service,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
				updatedAt: instance.updatedAt.toISOString(),
			}))
			.sort((left, right) => left.instanceId.localeCompare(right.instanceId));

		let cursor: HistoryCursor | null = null;
		if (cursorHandle) {
			try {
				const storedCursor = await app.prisma.historyCursorState.findFirst({
					where: {
						id: historyCursorHandleHash(cursorHandle),
						userId: request.currentUser!.id,
						expiresAt: { gt: new Date() },
					},
				});
				if (!storedCursor) return cursorConflict(reply);
				const envelope = historyCursorEnvelopeSchema.parse(
					JSON.parse(
						app.encryptor.decrypt({
							value: storedCursor.encryptedState,
							iv: storedCursor.encryptionIv,
						}),
					),
				);
				if (
					envelope.userId !== request.currentUser!.id ||
					envelope.queryHash !== queryHash ||
					!bindingsMatch(envelope.bindings, bindings)
				) {
					return cursorConflict(reply);
				}
				cursor = envelope.cursor;
			} catch {
				return cursorConflict(reply);
			}
		}

		const streams: HistoryProviderStream[] = instances.map((instance) => {
			const service = instance.service.toLowerCase() as HistoryService;
			let client: ArrClient | undefined;
			return {
				instanceId: instance.id,
				instanceName: instance.label,
				service,
				fetchPage: async (providerRequest) => {
					try {
						client ??= app.arrClientFactory.create(instance);
						return await fetchHistoryPage(client, service, providerRequest, {
							startDate,
							endDate,
							sortDirection,
						});
					} catch (error) {
						request.log.error(
							{ err: error, instanceId: instance.id, service },
							"History provider request failed",
						);
						throw error;
					}
				},
				normalize: (rawRecord) => ({
					...normalizeHistoryItem(rawRecord, service),
					instanceId: instance.id,
					instanceName: instance.label,
				}),
			};
		});

		try {
			const result = await paginateHistoryStreams({
				streams,
				options: {
					pageSize,
					sortDirection,
					startDate,
					endDate,
					service: serviceFilter,
					instanceId,
					status,
					searchTerm,
					hideProwlarrRss,
				},
				cursor,
			});

			let nextCursor: string | null = null;
			if (result.nextCursor) {
				const envelope: HistoryCursorEnvelope = {
					version: 1,
					userId: request.currentUser!.id,
					queryHash,
					bindings,
					cursor: result.nextCursor,
				};
				const handle = randomBytes(32).toString("base64url");
				const encrypted = app.encryptor.encrypt(JSON.stringify(envelope));
				const now = new Date();
				await app.prisma.historyCursorState.deleteMany({
					where: { userId: request.currentUser!.id, expiresAt: { lte: now } },
				});
				await app.prisma.historyCursorState.create({
					data: {
						id: historyCursorHandleHash(handle),
						userId: request.currentUser!.id,
						encryptedState: encrypted.value,
						encryptionIv: encrypted.iv,
						expiresAt: new Date(now.getTime() + HISTORY_CURSOR_TTL_MS),
					},
				});
				nextCursor = handle;
			}

			return reply.send({
				version: 2 as const,
				instances: result.providers,
				aggregated: result.items,
				totalCount: result.totalCount,
				pagination: {
					pageSize,
					nextCursor,
					hasMore: nextCursor !== null,
					incomplete: result.incomplete,
					sortKey: "date" as const,
					sortDirection,
					budgetUsed: result.budgetUsed,
				},
			});
		} catch (error) {
			if (error instanceof HistoryCursorStaleError) {
				return cursorConflict(reply);
			}
			throw error;
		}
	});

	done();
};
