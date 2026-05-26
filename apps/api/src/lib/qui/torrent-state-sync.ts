import { normalizeTorrentState } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { logQuiActivity, type QuiSyncCompleteDetails } from "./activity-log.js";
import { createQuiClient } from "./client-factory.js";
import { listQuiInstances } from "./instance-helpers.js";
import {
	buildNotificationPayloads,
	classifyTransition,
	type ProblemTransition,
} from "./torrent-state-notifier.js";

/**
 * Periodic snapshot of qui torrent state into LibraryCache (Phase 2.1).
 *
 * Walks every user with at least one enabled qui instance, fetches all
 * torrents from each instance, then bulk-updates `LibraryCache` rows that
 * match by `infoHash`. State is normalized via @arr/shared's
 * `normalizeTorrentState` so the schema stores operator-vocabulary, not
 * qBit-native strings.
 *
 * Designed to be safe to run while users are interacting:
 *   - per-row updates instead of a wrapping transaction (no long-held locks)
 *   - Promise.all bounded by user count, not torrent count
 *   - failures are logged per-instance and do NOT abort the rest of the run
 *
 * The on-demand `/qui/library-item/torrent-state` endpoint also writes
 * through to LibraryCache, so recently-viewed items stay fresher than the
 * sync interval — this job is the floor for staleness, not the ceiling.
 */
export interface TorrentStateSyncResult {
	usersScanned: number;
	instancesScanned: number;
	torrentsSeen: number;
	rowsUpdated: number;
	/**
	 * Rows whose `torrentState` was nulled because their infoHash is no longer
	 * in qui's response — most often because the user deleted the torrent in
	 * qui. Without this cleanup the badge would keep showing the last-known
	 * state forever, which actively misleads (user thinks the torrent is
	 * healthy when it's gone).
	 */
	rowsCleared: number;
	errors: number;
	durationMs: number;
}

export async function runQuiTorrentStateSync(
	app: FastifyInstance,
	log: FastifyBaseLogger = app.log,
): Promise<TorrentStateSyncResult> {
	const startedAt = Date.now();
	const result: TorrentStateSyncResult = {
		usersScanned: 0,
		instancesScanned: 0,
		torrentsSeen: 0,
		rowsUpdated: 0,
		rowsCleared: 0,
		errors: 0,
		durationMs: 0,
	};

	// Find every user that has at least one enabled qui instance. Users without
	// qui pay zero cost from this job.
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
		result.usersScanned++;
		const userStartedAt = Date.now();
		// Per-user slice of the run's totals — used for the activity log emit
		// at the end of the user's loop. Each user gets one row per run.
		let userInstancesScanned = 0;
		let userTorrentsSeen = 0;
		let userRowsUpdated = 0;
		let userRowsCleared = 0;
		const instances = await listQuiInstances(app, userId);

		// Track every hash this user's qui instances reported across all of them
		// THIS sync run — used at the end of the user's loop for stale-state
		// cleanup. Per-user scoping is critical: one user's qui won't have
		// torrents from another user's qui, so cross-user diff would be wrong.
		const seenHashesThisRun = new Set<string>();
		// `runStartedAt` is the cleanup cutoff: only rows last synced BEFORE this
		// run are candidates for nulling. Rows updated by THIS run, or by the
		// on-demand write-through path mid-run, are off-limits.
		const runStartedAt = new Date();

		// Prior-state snapshot for transition detection (Phase 2.5). Captured
		// BEFORE any updateMany so it reflects the state at the start of this
		// run. Keyed by lowercase hash → { state, title }. Only *arr-correlated
		// torrents (those with a LibraryCache row) get an entry, so only
		// library content can trigger a notification. One findMany per user.
		const priorStates = new Map<string, { state: string | null; title: string }>();
		try {
			const priorRows = await app.prisma.libraryCache.findMany({
				where: { instance: { userId }, infoHash: { not: null } },
				select: { infoHash: true, torrentState: true, title: true },
			});
			for (const row of priorRows) {
				if (row.infoHash) {
					priorStates.set(row.infoHash, { state: row.torrentState, title: row.title });
				}
			}
		} catch (error) {
			// Non-fatal: without priors we just don't emit notifications this
			// run. State sync itself proceeds normally.
			log.warn(
				{ err: error, userId },
				"qui torrent-state sync: prior-state snapshot failed; notifications skipped this run",
			);
		}
		// Transitions detected this run, across all of the user's instances.
		const transitions: ProblemTransition[] = [];
		// Per-user error count — DRIVES THE CLEANUP DECISION. If we used the
		// global `result.errors` instead, one user's failed sync would suppress
		// stale-state cleanup for every user that runs after them in this tick,
		// leaving deleted torrents showing as still-seeding indefinitely.
		let userErrors = 0;

		for (const instance of instances) {
			result.instancesScanned++;
			userInstancesScanned++;
			try {
				const client = createQuiClient(app, instance);
				// Single qui call returns torrents across every qBit instance behind
				// this qui — exactly what we need for hash-based correlation.
				const torrents = await client.listAllTorrents();
				result.torrentsSeen += torrents.length;
				userTorrentsSeen += torrents.length;

				if (torrents.length === 0) continue;

				const updates = torrents.map(async (torrent) => {
					const normalizedState = normalizeTorrentState(torrent.state);
					const hashLower = torrent.hash.toLowerCase();
					seenHashesThisRun.add(hashLower);

					// Transition detection (Phase 2.5): if this torrent has a
					// prior LibraryCache entry and just crossed into a problem
					// state, queue a notification. `classifyTransition` returns
					// null for non-problem and same-state cases, so a torrent
					// that STAYS errored across runs only notifies once.
					const prior = priorStates.get(hashLower);
					if (prior) {
						const kind = classifyTransition(prior.state, normalizedState);
						if (kind) {
							transitions.push({
								kind,
								infoHash: hashLower,
								title: prior.title,
								instanceLabel: instance.label,
								oldState: prior.state,
								newState: normalizedState,
							});
						}
					}
					// SECURITY: scope by userId via the instance relation. When two
					// users own the same infoHash (legitimate when they downloaded
					// the same public torrent), one user's sync would otherwise
					// write into the other user's row. updateMany returns count
					// without throwing on no-match — fine for "update if exists".
					const updated = await app.prisma.libraryCache.updateMany({
						where: { infoHash: hashLower, instance: { userId } },
						data: {
							torrentState: normalizedState,
							torrentRatio: Number.isFinite(torrent.ratio) ? torrent.ratio : null,
							torrentSyncedAt: new Date(),
						},
					});
					result.rowsUpdated += updated.count;
					userRowsUpdated += updated.count;
				});

				await Promise.all(updates);
			} catch (error) {
				userErrors++;
				result.errors++;
				log.warn(
					{ err: error, userId, instanceId: instance.id, instanceLabel: instance.label },
					"qui torrent-state sync failed for instance",
				);
			}
		}

		// Stale-state cleanup: any row this user owns whose infoHash was NOT in
		// any of their qui instances' responses this run, AND was last synced
		// BEFORE this run, gets its torrent state nulled. The user deleted the
		// torrent in qui (or it was never there), so the badge would otherwise
		// show last-known state forever. Skipped if THIS USER had errors —
		// failed instance might mean we have an incomplete view of qui's
		// torrents and would over-clear. Use per-user `userErrors`, not the
		// global `result.errors`, otherwise one user's failure would suppress
		// every other user's cleanup.
		if (userErrors > 0) {
			log.info(
				{ userId, userErrors, seenHashes: seenHashesThisRun.size },
				"qui torrent-state sync: skipping stale-state cleanup for user (instance errors → incomplete view, over-clearing risk)",
			);
		} else if (seenHashesThisRun.size === 0) {
			log.debug(
				{ userId },
				"qui torrent-state sync: skipping stale-state cleanup for user (no torrents seen)",
			);
		} else if (userErrors === 0 && seenHashesThisRun.size > 0) {
			try {
				// Two-step diff-and-batch-update to avoid SQLite's
				// IN/NOT-IN parameter cap (P2029). The naive
				// `updateMany({ where: { infoHash: { notIn: [...10k hashes] } } })`
				// crashed in production every scheduler tick (silently
				// suppressed via try/catch, so stale state drifted
				// indefinitely). Same shape as the fix in
				// episode-file-backfill.ts.
				const staleCandidates = await app.prisma.libraryCache.findMany({
					where: {
						instance: { userId },
						torrentState: { not: null },
						torrentSyncedAt: { lt: runStartedAt },
					},
					select: { id: true, infoHash: true },
				});
				const staleIds = staleCandidates
					.filter((r) => r.infoHash && !seenHashesThisRun.has(r.infoHash))
					.map((r) => r.id);

				// Chunk size matches the episode-file-backfill fix —
				// well below SQLite's 32K cap and any Prisma quirks.
				const CHUNK = 500;
				let userCleared = 0;
				for (let i = 0; i < staleIds.length; i += CHUNK) {
					const batch = staleIds.slice(i, i + CHUNK);
					const cleared = await app.prisma.libraryCache.updateMany({
						where: { id: { in: batch } },
						data: {
							torrentState: null,
							torrentRatio: null,
							torrentSyncedAt: null,
						},
					});
					userCleared += cleared.count;
				}
				result.rowsCleared += userCleared;
				userRowsCleared += userCleared;
			} catch (error) {
				log.warn({ err: error, userId }, "qui torrent-state sync: stale-state cleanup failed");
			}
		}

		// Emit qui torrent-state notifications (Phase 2.5). Dedup by
		// (infoHash, kind) first — a cross-seeded hash can surface on more
		// than one qui instance, but the operator only needs one alert per
		// content-problem. Fire-and-forget: notification failures must not
		// abort or slow the sync.
		if (transitions.length > 0 && app.notificationService) {
			const seenTransitionKeys = new Set<string>();
			const deduped = transitions.filter((t) => {
				const key = `${t.infoHash}:${t.kind}`;
				if (seenTransitionKeys.has(key)) return false;
				seenTransitionKeys.add(key);
				return true;
			});
			const payloads = buildNotificationPayloads(deduped);
			for (const payload of payloads) {
				app.notificationService.notify(payload).catch((err) => {
					log.warn(
						{ err, userId, eventType: payload.eventType },
						"qui torrent-state notification dispatch failed",
					);
				});
			}
			log.info(
				{ userId, transitions: deduped.length, payloads: payloads.length },
				"qui torrent-state sync emitted torrent-state notifications",
			);
		}

		// Activity log: one row per user per run. Status reflects this user's
		// success — global errors from OTHER users shouldn't taint this user's
		// timeline. Fire-and-forget; logQuiActivity swallows failures.
		const userDetails: QuiSyncCompleteDetails = {
			instancesScanned: userInstancesScanned,
			torrentsSeen: userTorrentsSeen,
			rowsUpdated: userRowsUpdated,
			rowsCleared: userRowsCleared,
			errors: userErrors,
			durationMs: Date.now() - userStartedAt,
		};
		await logQuiActivity({
			app,
			userId,
			eventType: "qui_sync_complete",
			details: userDetails,
			status: userErrors > 0 ? "error" : "ok",
			log,
		});
	}

	result.durationMs = Date.now() - startedAt;
	log.info(
		{
			usersScanned: result.usersScanned,
			instancesScanned: result.instancesScanned,
			torrentsSeen: result.torrentsSeen,
			rowsUpdated: result.rowsUpdated,
			rowsCleared: result.rowsCleared,
			errors: result.errors,
			durationMs: result.durationMs,
		},
		"qui torrent-state sync completed",
	);
	return result;
}
