import type {
	TautulliHistoryIncompleteReason,
	TautulliHistorySource,
	TautulliWatchHistoryItem,
	TautulliWatchHistoryResponse,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	type TautulliClient,
	MAX_TAUTULLI_HISTORY_PAGE_LENGTH,
} from "../../lib/tautulli/tautulli-client.js";
import {
	createCurrentTautulliClient,
	isTautulliConnectionChanged,
} from "../../lib/tautulli/current-tautulli-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

/** Maximum cross-instance history prefix a public request may retrieve. */
export const MAX_TAUTULLI_HISTORY_RETRIEVAL_DEPTH = 5_000;

const historyQuery = z
	.object({
		offset: z.coerce.number().int().min(0).default(0),
		limit: z.coerce.number().int().min(1).max(100).default(25),
	})
	.superRefine(({ offset, limit }, context) => {
		if (offset + limit > MAX_TAUTULLI_HISTORY_RETRIEVAL_DEPTH) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["limit"],
				message: `offset plus limit must not exceed ${MAX_TAUTULLI_HISTORY_RETRIEVAL_DEPTH}`,
			});
		}
	});

export async function registerHistoryRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/", async (request, reply) => {
		const { offset, limit } = validateRequest(historyQuery, request.query);
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser!.id, service: "TAUTULLI", enabled: true },
			orderBy: { label: "asc" },
		});
		const requestedDepth = offset + limit;
		const results = await Promise.all(
			instances.map(async (instance) => {
				try {
					const { client, ensureCurrent } = createCurrentTautulliClient(app, instance);
					const data = await getRequestedHistoryPrefix(client, requestedDepth);
					await ensureCurrent();
					return {
						instance,
						data,
					};
				} catch (error) {
					request.log.warn(
						{ err: error, instanceId: instance.id },
						"Tautulli history request failed",
					);
					return {
						instance,
						incompleteReason: isTautulliConnectionChanged(error)
							? ("connection_changed" as const)
							: ("source_unreachable" as const),
					};
				}
			}),
		);
		const sources: TautulliHistorySource[] = results.map((item) => {
			if (!item.data) {
				return {
					instanceId: item.instance.id,
					instanceLabel: item.instance.label,
					totalCount: 0,
					history: [],
					complete: false,
					incompleteReason: item.incompleteReason!,
				};
			}
			if (!item.data.complete) {
				return {
					instanceId: item.instance.id,
					instanceLabel: item.instance.label,
					totalCount: item.data.totalCount,
					history: mapHistory(item.data.items, item.instance).slice(offset, offset + limit),
					complete: false,
					incompleteReason: item.data.incompleteReason,
				};
			}
			return {
				instanceId: item.instance.id,
				instanceLabel: item.instance.label,
				totalCount: item.data.totalCount,
				history: mapHistory(item.data.items, item.instance).slice(offset, offset + limit),
				complete: true,
			};
		});
		const response: TautulliWatchHistoryResponse = {
			provider: "tautulli",
			configured: instances.length > 0,
			sources,
			pagination: {
				offset,
				limit,
				complete: sources.every((source) => source.complete),
			},
		};
		return reply.send(response);
	});
}

type TautulliHistoryPage = Awaited<ReturnType<TautulliClient["getHistoryNewestPage"]>>;

async function getRequestedHistoryPrefix(
	client: TautulliClient,
	requestedDepth: number,
): Promise<
	{
		items: TautulliHistoryPage["data"];
		totalCount: number;
	} & ({ complete: true } | { complete: false; incompleteReason: TautulliHistoryIncompleteReason })
> {
	const items: TautulliHistoryPage["data"] = [];
	let totalCount = 0;
	let totalRecords = 0;
	let previousDate: number | undefined;
	let previousRowId: number | undefined;
	const rowIds = new Set<number>();

	for (let start = 0; start < requestedDepth; start += MAX_TAUTULLI_HISTORY_PAGE_LENGTH) {
		const length = Math.min(MAX_TAUTULLI_HISTORY_PAGE_LENGTH, requestedDepth - start);
		const page = await client.getHistoryNewestPage({ start, length });
		if (page.recordsTotal < page.recordsFiltered) {
			return { items, totalCount, complete: false, incompleteReason: "upstream_total_changed" };
		}
		if (start === 0) {
			totalCount = page.recordsFiltered;
			totalRecords = page.recordsTotal;
		} else if (page.recordsFiltered !== totalCount || page.recordsTotal !== totalRecords) {
			return { items, totalCount, complete: false, incompleteReason: "upstream_total_changed" };
		}

		const remaining = Math.max(0, totalCount - start);
		const expectedRows = Math.min(length, remaining);
		if (page.data.length > expectedRows) {
			return { items, totalCount, complete: false, incompleteReason: "page_overflow" };
		}
		for (const row of page.data) {
			if (row.row_id === undefined) {
				return { items, totalCount, complete: false, incompleteReason: "missing_row_id" };
			}
			if (rowIds.has(row.row_id)) {
				return { items, totalCount, complete: false, incompleteReason: "duplicate_row_id" };
			}
			if (
				previousDate !== undefined &&
				(row.date > previousDate ||
					(row.date === previousDate && previousRowId !== undefined && row.row_id >= previousRowId))
			) {
				return { items, totalCount, complete: false, incompleteReason: "unstable_row_id" };
			}
			rowIds.add(row.row_id);
			previousDate = row.date;
			previousRowId = row.row_id;
			items.push(row);
		}
		if (page.data.length < expectedRows) {
			return { items, totalCount, complete: false, incompleteReason: "page_truncated" };
		}
		if (items.length >= totalCount || start + length >= requestedDepth) {
			return { items, totalCount, complete: true };
		}
	}

	return { items, totalCount, complete: true };
}

function mapHistory(
	items: TautulliHistoryPage["data"],
	instance: { id: string; label: string },
): TautulliWatchHistoryItem[] {
	return items.map((raw) => ({
		title: raw.title,
		grandparentTitle: raw.grandparent_title || undefined,
		mediaType:
			raw.media_type === "movie" || raw.media_type === "episode" || raw.media_type === "track"
				? raw.media_type
				: "unknown",
		watchedAt: new Date(raw.date * 1000).toISOString(),
		user: raw.user,
		ratingKey: raw.rating_key,
		instanceId: instance.id,
		instanceLabel: instance.label,
	}));
}
