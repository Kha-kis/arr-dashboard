import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ServiceInstance } from "../prisma.js";
import { logQuiActivity, type QuiBackfillCompleteDetails } from "../qui/activity-log.js";

/**
 * Backfill `LibraryCache.infoHash` from *arr download history (Phase 2.1).
 *
 * Used by:
 *   - the on-demand path in `/qui/library-item/torrent-state` (one item)
 *   - the periodic `infohash-backfill-scheduler` (batched walk)
 *
 * Both call sites need the same logic: query the *arr instance's `/api/v3/history`
 * for the item, scan the most recent records (grab + import both preserve
 * `downloadId`), and pick the first one that looks like a torrent infohash.
 *
 * Returns the lower-cased hash on success, `null` when no matching record
 * exists (manual import, history pruned, item never grabbed via the *arr).
 */

/**
 * Heuristic for "looks like a real torrent hash" — qBit info hashes are 40-hex
 * (SHA-1) or 64-hex (SHA-256). Some clients emit other downloadId formats
 * (NZB, magnet variants) that we deliberately reject so they don't pollute
 * `LibraryCache.infoHash`.
 */
const HASH_RE = /^[a-f0-9]{40,64}$/;

function looksLikeInfoHash(value: unknown): value is string {
	return typeof value === "string" && HASH_RE.test(value.toLowerCase());
}

/**
 * Sentinel error class for *arr-side failures we want to propagate up the
 * sweep stack (401/403/5xx) rather than swallow as a benign "no record found"
 * null-return. The sweep's per-row catch increments `result.errors` when this
 * is thrown, which the catch-up scheduler's no-progress guard then surfaces
 * to operators with an actionable hint ("check *arr API key" vs "permanent
 * backlog tail"). The fetch-level outer catch re-throws this class while
 * still null-returning generic `Error`s.
 */
export class ArrHistoryFetchError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "ArrHistoryFetchError";
	}
}

export interface FetchInfoHashArgs {
	app: FastifyInstance;
	arrInstance: ServiceInstance;
	itemType: "movie" | "series";
	arrItemId: number;
	log?: FastifyBaseLogger;
}

/**
 * Fetch the latest infoHash for a single library item from *arr history.
 * Does NOT mutate the LibraryCache row — caller decides whether to persist.
 *
 * Uses the dedicated `/api/v3/history/movie` (Radarr) and
 * `/api/v3/history/series` (Sonarr) subpath endpoints. The base
 * `/api/v3/history` endpoint takes `movieIds`/`seriesIds` *plural arrays*
 * — passing the singular `movieId=`/`seriesId=` is silently ignored, and
 * the API returns global history sorted by date descending, causing the
 * SAME hash to be assigned to every item. The subpath endpoints take the
 * singular id, return a flat array (not paginated), and filter correctly.
 */
export async function fetchInfoHashFromArrHistory({
	app,
	arrInstance,
	itemType,
	arrItemId,
	log,
}: FetchInfoHashArgs): Promise<string | null> {
	const path =
		itemType === "series"
			? `/api/v3/history/series?seriesId=${arrItemId}`
			: `/api/v3/history/movie?movieId=${arrItemId}`;

	try {
		const response = await app.arrClientFactory.rawRequest(
			{
				id: arrInstance.id,
				baseUrl: arrInstance.baseUrl,
				encryptedApiKey: arrInstance.encryptedApiKey,
				encryptionIv: arrInstance.encryptionIv,
				service: arrInstance.service,
				label: arrInstance.label,
			},
			path,
		);

		if (!response.ok) {
			// 401/403 are persistent: every row in this sweep will fail until
			// operator rotates the API key. Throwing surfaces it as a sweep-level
			// `errors++` counter rather than letting hundreds of rows quietly
			// count as "missed" — the latter masks a real config issue as a
			// permanent backlog tail. 5xx is also operator-actionable (transient
			// or otherwise) so we throw there too. 404 stays a benign null:
			// some items genuinely have no history record.
			if (response.status === 401 || response.status === 403) {
				log?.error(
					{
						status: response.status,
						arrInstanceId: arrInstance.id,
						instanceLabel: arrInstance.label,
					},
					"infoHash backfill: *arr returned auth error — API key likely needs rotation",
				);
				throw new ArrHistoryFetchError(
					`*arr history auth failure (HTTP ${response.status}) on ${arrInstance.label}`,
					response.status,
				);
			}
			if (response.status >= 500) {
				log?.warn(
					{ status: response.status, arrInstanceId: arrInstance.id, arrItemId, itemType },
					"infoHash backfill: *arr history returned 5xx — transient or service down",
				);
				throw new ArrHistoryFetchError(
					`*arr history server error (HTTP ${response.status}) on ${arrInstance.label}`,
					response.status,
				);
			}
			log?.warn(
				{ status: response.status, arrInstanceId: arrInstance.id, arrItemId, itemType },
				"infoHash backfill: *arr history request failed",
			);
			return null;
		}

		// Subpath endpoints return a raw array, not the paginated `{ records: [] }`
		// shape of the base history endpoint.
		const data = (await response.json()) as Array<{ downloadId?: unknown }>;
		if (!Array.isArray(data)) {
			log?.warn(
				{ arrInstanceId: arrInstance.id, arrItemId, itemType },
				"infoHash backfill: unexpected response shape (not an array)",
			);
			return null;
		}
		const found = data.find((r) => looksLikeInfoHash(r.downloadId));
		return found && typeof found.downloadId === "string" ? found.downloadId.toLowerCase() : null;
	} catch (error) {
		// Re-throw sentinel errors (auth / 5xx) so the sweep can count them
		// as `errors`, not silently as `rowsMissed`. Generic network errors
		// (DNS failure, ECONNREFUSED, JSON parse) stay as null-returns —
		// those are transient and not worth elevating to error counters.
		if (error instanceof ArrHistoryFetchError) {
			throw error;
		}
		log?.warn(
			{ err: error, arrInstanceId: arrInstance.id, arrItemId, itemType },
			"infoHash backfill from *arr history failed",
		);
		return null;
	}
}

/**
 * Backfill the infoHash for a single LibraryCache row, persisting if found.
 * Returns the freshly-discovered hash, or null if the lookup didn't yield
 * one. Caller is responsible for the prior cache hit + null check on
 * `cached.infoHash` — this function assumes a backfill is needed.
 *
 * Used by the on-demand qui route handler.
 */
export async function backfillInfoHashForRow(args: {
	app: FastifyInstance;
	cacheRowId: string;
	userId: string;
	arrInstanceId: string;
	itemType: "movie" | "series";
	arrItemId: number;
	log?: FastifyBaseLogger;
}): Promise<string | null> {
	const { app, cacheRowId, userId, arrInstanceId, itemType, arrItemId, log } = args;

	const arrService = itemType === "movie" ? "RADARR" : "SONARR";
	const arrInstance = await app.prisma.serviceInstance.findFirst({
		where: { id: arrInstanceId, userId, service: arrService },
	});
	if (!arrInstance) return null;

	const hash = await fetchInfoHashFromArrHistory({
		app,
		arrInstance,
		itemType,
		arrItemId,
		log,
	});
	if (!hash) return null;

	await app.prisma.libraryCache.update({
		where: { id: cacheRowId },
		data: { infoHash: hash },
	});
	return hash;
}

/**
 * Result of a periodic backfill tick — surfaced into pino logs and the
 * scheduler-registry telemetry so operators can see coverage growing
 * (or failing) over time.
 */
export interface BackfillSweepResult {
	usersScanned: number;
	rowsScanned: number;
	rowsHashed: number;
	rowsMissed: number;
	errors: number;
	durationMs: number;
}

interface SweepArgs {
	app: FastifyInstance;
	log?: FastifyBaseLogger;
	/** Max LibraryCache rows to process across all users in one tick. */
	batchSize: number;
	/** Sleep between per-row *arr calls to avoid thundering-herd against history endpoint. */
	perRowSleepMs?: number;
}

/**
 * One tick of the periodic backfill: walks LibraryCache rows where
 * `infoHash IS NULL`, scoped to users with at least one enabled qui
 * instance (no point burning *arr history budget for users who don't
 * use qui), and backfills up to `batchSize` rows.
 *
 * Order is `cachedAt ASC` (oldest first) so newer items — which the
 * lazy on-demand path is most likely to cover via UI views — get
 * processed only after the long tail.
 */
export async function runInfoHashBackfillSweep({
	app,
	log,
	batchSize,
	perRowSleepMs = 100,
}: SweepArgs): Promise<BackfillSweepResult> {
	const startedAt = Date.now();
	const result: BackfillSweepResult = {
		usersScanned: 0,
		rowsScanned: 0,
		rowsHashed: 0,
		rowsMissed: 0,
		errors: 0,
		durationMs: 0,
	};

	const usersWithQui = await app.prisma.serviceInstance.findMany({
		where: { service: "QUI", enabled: true },
		select: { userId: true },
		distinct: ["userId"],
	});
	if (usersWithQui.length === 0) {
		result.durationMs = Date.now() - startedAt;
		return result;
	}

	for (const { userId } of usersWithQui) {
		if (result.rowsScanned >= batchSize) break;
		result.usersScanned++;
		const userStartedAt = Date.now();
		const userInitialScanned = result.rowsScanned;
		const userInitialHashed = result.rowsHashed;
		const userInitialMissed = result.rowsMissed;

		const remaining = batchSize - result.rowsScanned;
		// Find LibraryCache rows for this user (joined via ServiceInstance.userId)
		// where infoHash is missing AND the item type is one qui can correlate.
		const rows = await app.prisma.libraryCache.findMany({
			where: {
				infoHash: null,
				itemType: { in: ["movie", "series"] },
				instance: { userId },
			},
			orderBy: { cachedAt: "asc" },
			take: remaining,
			select: {
				id: true,
				instanceId: true,
				itemType: true,
				arrItemId: true,
			},
		});

		for (const row of rows) {
			if (row.itemType !== "movie" && row.itemType !== "series") continue;
			result.rowsScanned++;
			try {
				const hash = await backfillInfoHashForRow({
					app,
					cacheRowId: row.id,
					userId,
					arrInstanceId: row.instanceId,
					itemType: row.itemType,
					arrItemId: row.arrItemId,
					log,
				});
				if (hash) {
					result.rowsHashed++;
				} else {
					result.rowsMissed++;
				}
			} catch (error) {
				result.errors++;
				log?.warn({ err: error, userId, cacheRowId: row.id }, "infoHash backfill row error");
			}
			if (perRowSleepMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, perRowSleepMs));
			}
		}

		// Activity log: per-user backfill tick. Captures only the slice of this
		// user's rows scanned in THIS tick (deltas from initial counters), so
		// the timeline shows one event per user per scheduler tick rather than
		// the global rolling-up. Fire-and-forget; failures are swallowed.
		const userRowsScanned = result.rowsScanned - userInitialScanned;
		// Only emit when this user actually contributed work this tick. Some
		// users may sit behind earlier users that already exhausted the batch.
		if (userRowsScanned > 0) {
			const userDetails: QuiBackfillCompleteDetails = {
				itemsScanned: userRowsScanned,
				itemsUpdated: result.rowsHashed - userInitialHashed,
				itemsWithoutHash: result.rowsMissed - userInitialMissed,
				durationMs: Date.now() - userStartedAt,
			};
			await logQuiActivity({
				app,
				userId,
				eventType: "qui_backfill_complete",
				details: userDetails,
				log,
			});
		}
	}

	result.durationMs = Date.now() - startedAt;
	log?.info(
		{
			usersScanned: result.usersScanned,
			rowsScanned: result.rowsScanned,
			rowsHashed: result.rowsHashed,
			rowsMissed: result.rowsMissed,
			errors: result.errors,
			durationMs: result.durationMs,
		},
		"infoHash backfill sweep completed",
	);
	return result;
}

/**
 * Count remaining backfill candidates without doing any work — used by the
 * scheduler's fast-path to decide whether to fire the next tick early.
 */
export async function countBackfillCandidates(app: FastifyInstance): Promise<number> {
	const usersWithQui = await app.prisma.serviceInstance.findMany({
		where: { service: "QUI", enabled: true },
		select: { userId: true },
		distinct: ["userId"],
	});
	if (usersWithQui.length === 0) return 0;
	const userIds = usersWithQui.map((u) => u.userId);
	return app.prisma.libraryCache.count({
		where: {
			infoHash: null,
			itemType: { in: ["movie", "series"] },
			instance: { userId: { in: userIds } },
		},
	});
}
