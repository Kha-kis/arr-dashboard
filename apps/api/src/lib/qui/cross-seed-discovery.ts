/**
 * Cross-Seed Discovery scan (Phase 3.1).
 *
 * Walks the user's LibraryCache rows in batches, joins each row's
 * `infoHash` against the user's qui torrent set, and resolves cross-seed
 * siblings per item. Returns one batch at a time so the frontend can
 * incrementally scan a large library without holding the whole result
 * set in memory or paying the full latency upfront.
 *
 * Design choices:
 *   - **No persistent cache for siblings.** Cross-seed data changes when
 *     users add/remove torrents; pre-caching would either stale fast or
 *     require a heavy sync job. qui's own sync-manager already caches
 *     reads, so live-fetch is cheap.
 *   - **Single `listTorrentInventory` per batch.** qui returns the
 *     cross-instance torrent set in one call; we join locally. Without
 *     this we'd need 2 qui calls per item (one to find the qBit instance
 *     id, one for siblings), N=batch-size apart.
 *   - **Bounded concurrency for sibling fetches.** 8 concurrent calls
 *     per batch keeps the burst small enough that qui's sync-manager
 *     handles it gracefully while keeping batch latency under a second.
 *   - **Cursor-based pagination.** LibraryCache.id is the cursor; ordered
 *     ascending, deterministic, deletion-tolerant.
 */

import type {
	CrossSeedDiscoveryAvailability,
	CrossSeedDiscoveryItem,
	CrossSeedDiscoveryResponse,
	QuiTorrent,
} from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ServiceInstance } from "../prisma.js";
import { createQuiClient } from "./client-factory.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const SIBLING_FETCH_CONCURRENCY = 8;

const SERVICE_TO_LABEL: Record<string, CrossSeedDiscoveryItem["arrService"] | null> = {
	SONARR: "sonarr",
	RADARR: "radarr",
	LIDARR: "lidarr",
	READARR: "readarr",
};

/**
 * Determine whether the user can run a discovery scan at all. Cheap query
 * — uses scalar counts only, no qui calls. Drives the empty-state copy.
 */
export async function getDiscoveryAvailability(
	app: FastifyInstance,
	userId: string,
): Promise<CrossSeedDiscoveryAvailability> {
	const quiInstance = await pickQuiInstance(app, userId);
	if (!quiInstance) {
		return { available: false, reason: "no_qui_instance" };
	}

	const scanCandidates = await app.prisma.libraryCache.count({
		where: { instance: { userId }, infoHash: { not: null } },
	});

	if (scanCandidates === 0) {
		return { available: false, reason: "no_correlated_items" };
	}

	return {
		available: true,
		quiInstanceId: quiInstance.id,
		quiInstanceLabel: quiInstance.label,
		scanCandidates,
	};
}

export interface DiscoveryScanArgs {
	app: FastifyInstance;
	userId: string;
	cursor: string | null;
	batchSize: number;
	log: FastifyBaseLogger;
}

/**
 * Execute a single discovery scan batch. Caller is responsible for
 * accumulating cumulative totals across batches — we report per-batch
 * counts only so this remains stateless and idempotent.
 */
export async function runDiscoveryBatch(
	args: DiscoveryScanArgs,
): Promise<CrossSeedDiscoveryResponse> {
	const { app, userId, cursor, log } = args;
	const batchSize = clampBatchSize(args.batchSize);

	const quiInstance = await pickQuiInstance(app, userId);
	if (!quiInstance) {
		throw Object.assign(new Error("Cross-seed discovery is unavailable. Retry the scan."), {
			statusCode: 503,
		});
	}

	const client = createQuiClient(app, quiInstance);

	// Build hash → torrent map for THIS batch. We re-fetch every batch so a
	// long scan reflects torrents added/removed mid-scan. qui's response is
	// cached internally so this is cheap; we don't need our own cache layer.
	const inventory = await client.listTorrentInventory();
	const torrentByHash = new Map<string, QuiTorrent>();
	for (const t of inventory.torrents) {
		torrentByHash.set(t.hash.toLowerCase(), t);
	}

	const rows = await app.prisma.libraryCache.findMany({
		where: {
			instance: { userId },
			infoHash: { not: null },
			...(cursor ? { id: { gt: cursor } } : {}),
		},
		select: {
			id: true,
			instanceId: true,
			instance: { select: { label: true, service: true } },
			arrItemId: true,
			itemType: true,
			title: true,
			year: true,
			infoHash: true,
		},
		orderBy: { id: "asc" },
		take: batchSize,
	});

	const items: CrossSeedDiscoveryItem[] = [];
	let lastScannedId: string | null = cursor;
	// Per-batch counter for sibling-fetch failures. Without this, the
	// frontend can't distinguish "we checked everything, no siblings found"
	// from "we tried but qui errored on N items". Surfaced in the response
	// so the page can render a "partial results" badge.
	let siblingFetchErrors = 0;

	// Pre-resolve which rows we can actually scan (in-qui torrents). For rows
	// whose infoHash qui doesn't know, we don't need a siblings call at all.
	type Candidate = {
		row: (typeof rows)[number];
		hash: string;
		torrent: QuiTorrent;
		service: CrossSeedDiscoveryItem["arrService"];
	};
	const candidates: Candidate[] = [];

	for (const row of rows) {
		lastScannedId = row.id;
		if (!row.infoHash) continue;
		const hash = row.infoHash.toLowerCase();
		const torrent = torrentByHash.get(hash);
		if (!torrent || torrent.instanceId === undefined) continue;
		const service = SERVICE_TO_LABEL[row.instance.service];
		// Skip unsupported services (qui only knows Sonarr/Radarr/Lidarr/Readarr —
		// any other service mapping returning null means we'd render a malformed
		// row, so we drop it cleanly).
		if (!service) continue;
		candidates.push({ row, hash, torrent, service });
	}

	// Bounded-concurrency sibling fetch. We could batch by qBit instance to
	// hit the same backend cache, but qui's local-matches endpoint is
	// instance-scoped already and cheap enough that the simple round-robin
	// pool is plenty.
	let cursorIdx = 0;
	const workers = Array.from({ length: SIBLING_FETCH_CONCURRENCY }, async () => {
		while (true) {
			const idx = cursorIdx++;
			if (idx >= candidates.length) break;
			const candidate = candidates[idx];
			if (!candidate) continue;
			const { row, hash, torrent, service } = candidate;
			try {
				const qbitInstanceId = torrent.instanceId;
				if (qbitInstanceId === undefined) continue;
				const siblings = await client.getCrossSeedMatches(qbitInstanceId, hash);
				if (siblings.length === 0) continue;

				items.push({
					libraryCacheId: row.id,
					arrInstanceId: row.instanceId,
					arrInstanceLabel: row.instance.label,
					arrService: service,
					itemType: row.itemType.toLowerCase() as CrossSeedDiscoveryItem["itemType"],
					arrItemId: row.arrItemId,
					title: row.title,
					year: row.year,
					primary: {
						hash: torrent.hash,
						qbitInstanceId,
						qbitInstanceName: torrent.instanceName ?? "qbit",
						state: torrent.state,
						ratio: torrent.ratio,
						tracker: null,
					},
					siblings,
				});
			} catch {
				// Per-item failure shouldn't abort the whole batch — log + count.
				// The counter surfaces to the frontend so operators can see "N
				// items couldn't be checked" rather than silently getting a
				// smaller result set with no clue that completeness suffered.
				siblingFetchErrors++;
			}
		}
	});
	await Promise.all(workers);
	if (siblingFetchErrors > 0) {
		log.warn(
			{ category: "cross_seed_sibling_read_failed", count: siblingFetchErrors },
			"Cross-seed discovery sibling reads failed",
		);
	}

	// Sort items by title within the batch for stable display ordering.
	items.sort((a, b) => a.title.localeCompare(b.title));

	const scannedThisBatch = rows.length;
	const exhausted = rows.length < batchSize;

	return {
		items,
		nextCursor: exhausted ? null : lastScannedId,
		scannedThisBatch,
		foundThisBatch: items.length,
		totalScanned: scannedThisBatch,
		totalFound: items.length,
		exhausted,
		quiInstanceLabel: quiInstance.label,
		siblingFetchErrors,
		torrentInventoryComplete: inventory.complete === true,
	};
}

/** Pick the user's default qui instance — same convention as the per-item route. */
async function pickQuiInstance(
	app: FastifyInstance,
	userId: string,
): Promise<ServiceInstance | null> {
	return app.prisma.serviceInstance.findFirst({
		where: { userId, service: "QUI", enabled: true },
		orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
	});
}

function clampBatchSize(raw: number): number {
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BATCH_SIZE;
	return Math.min(Math.floor(raw), MAX_BATCH_SIZE);
}
