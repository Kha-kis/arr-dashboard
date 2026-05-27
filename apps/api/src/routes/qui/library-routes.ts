import path from "node:path";
import { normalizeTorrentState } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
	runEpisodeBackfillSweep,
	runEpisodeFileSync,
} from "../../lib/library-sync/episode-file-backfill.js";
import {
	buildFileIdIndex,
	clearFileIdIndexCache,
	getAllHashesForFileId,
} from "../../lib/library-sync/infohash-backfill-by-inode.js";
import { runPathBackfillSweep } from "../../lib/library-sync/infohash-backfill-by-path.js";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { getDiscoveryAvailability, runDiscoveryBatch } from "../../lib/qui/cross-seed-discovery.js";
import { listQuiInstances } from "../../lib/qui/instance-helpers.js";
import { getCachedAllTorrents } from "../../lib/qui/torrent-list-cache.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";
import {
	ACTIVITY_QUERY,
	DISCOVERY_QUERY,
	extractHostnameSafe,
	safeParseJson,
} from "./qui-shared.js";

export function registerLibraryRoutes(app: FastifyInstance): void {
	// Cross-Seed Discovery (Phase 3.1) — availability probe for empty-state
	// gating on the frontend page. Cheap: zero qui calls.
	app.get("/qui/cross-seed/availability", async (request, reply) => {
		const userId = request.currentUser!.id;
		const availability = await getDiscoveryAvailability(app, userId);
		return reply.send(availability);
	});

	// Cross-Seed Discovery (Phase 3.1) — scan one batch of LibraryCache rows
	// and return any items with cross-seed siblings. Frontend stitches
	// batches via the returned `nextCursor`. See lib/qui/cross-seed-discovery.ts
	// for the scan contract.
	app.get<{
		Querystring: { cursor?: string; batchSize?: string };
	}>("/qui/cross-seed/discover", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { cursor, batchSize } = validateRequest(DISCOVERY_QUERY, request.query);
		const result = await runDiscoveryBatch({
			app,
			userId,
			cursor: cursor ?? null,
			batchSize: batchSize ?? 100,
			log: request.log,
		});
		return reply.send(result);
	});

	// ────────────────────────────────────────────────────────────────────
	// qui home page — summary KPI strip + Needs Attention feed (Phase 6).
	// Single-pane-of-glass surface. One request per panel, both designed
	// to be cheap enough to refresh at the polling-active cadence.
	// ────────────────────────────────────────────────────────────────────

	app.get("/qui/summary", async (request, reply) => {
		const userId = request.currentUser!.id;
		const instances = await listQuiInstances(app, userId);

		// Empty state — user has no qui configured. Return zeros so the
		// frontend can render an empty-state pitch without an extra
		// availability probe.
		if (instances.length === 0) {
			return reply.send({
				totalTorrents: 0,
				byState: { seeding: 0, downloading: 0, paused: 0, stalled: 0, error: 0, other: 0 },
				avgRatio: 0,
				lowRatioCount: 0,
				dlSpeed: 0,
				upSpeed: 0,
				lastSyncAt: null,
				lastSyncOk: null,
				configuredInstances: 0,
				qbitInstances: [],
			});
		}

		// Aggregate across every qui instance the user has. Multiple-qui
		// users are rare in practice but supported by the schema; merging
		// here keeps the frontend a single source of truth.
		let totalTorrents = 0;
		const byState = { seeding: 0, downloading: 0, paused: 0, stalled: 0, error: 0, other: 0 };
		let totalRatio = 0;
		let lowRatioCount = 0;
		let dlSpeed = 0;
		let upSpeed = 0;
		const LOW_RATIO_THRESHOLD = 1.0;
		const qbitInstances: Array<{
			id: number;
			name: string;
			connected: boolean;
			torrentCount: number;
		}> = [];

		const perInstanceTorrentCount = new Map<number, number>();

		for (const instance of instances) {
			let client: ReturnType<typeof createQuiClient>;
			try {
				client = createQuiClient(app, instance);
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui summary: client construction failed (likely encryption key mismatch); skipping instance",
				);
				continue;
			}

			try {
				const torrents = await getCachedAllTorrents(instance.id, client);
				totalTorrents += torrents.length;
				for (const t of torrents) {
					const normalized = normalizeTorrentState(t.state);
					// Roll the normalizer's per-direction states into the
					// summary's coarser buckets. `stalled_dl` is "trying to
					// download but no peers"; collapsing it into `stalled`
					// hides that distinction at the KPI level (operators
					// care that a torrent is stuck, not which direction).
					if (normalized === "seeding") byState.seeding++;
					else if (normalized === "downloading") byState.downloading++;
					else if (normalized === "paused") byState.paused++;
					else if (normalized === "stalled_dl") byState.stalled++;
					else if (normalized === "error") byState.error++;
					else byState.other++;
					totalRatio += t.ratio;
					if (t.ratio < LOW_RATIO_THRESHOLD) lowRatioCount++;
					if (t.instanceId !== undefined) {
						perInstanceTorrentCount.set(
							t.instanceId,
							(perInstanceTorrentCount.get(t.instanceId) ?? 0) + 1,
						);
					}
				}
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui summary: listAllTorrents failed; skipping torrents for this instance",
				);
			}

			try {
				const qbits = await client.listInstances();
				for (const q of qbits) {
					qbitInstances.push({
						id: q.id,
						name: q.name,
						connected: q.connected,
						torrentCount: perInstanceTorrentCount.get(q.id) ?? 0,
					});
					// Live throughput — one cheap call per connected qBit.
					// Non-fatal: a failure just omits this instance's slice
					// rather than failing the whole summary.
					if (q.connected) {
						try {
							const transfer = await client.getTransferInfo(q.id);
							dlSpeed += transfer.dlSpeed;
							upSpeed += transfer.upSpeed;
						} catch (transferErr) {
							request.log.warn(
								{ err: transferErr, instanceId: instance.id, qbitInstanceId: q.id },
								"qui summary: transfer-info failed; throughput excludes this qBit",
							);
						}
					}
				}
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui summary: listInstances failed; qbit-instance card will be empty",
				);
			}
		}

		// Pull the most recent `qui_sync_complete` activity row for "last
		// sync" KPI. Falls back to null when the scheduler has never
		// successfully run (e.g., fresh install).
		const lastSync = await app.prisma.quiActivityLog.findFirst({
			where: { userId, eventType: "qui_sync_complete" },
			orderBy: { createdAt: "desc" },
			select: { createdAt: true, details: true },
		});
		let lastSyncOk: boolean | null = null;
		if (lastSync) {
			try {
				const details = JSON.parse(lastSync.details ?? "{}") as { errors?: number };
				lastSyncOk = (details.errors ?? 0) === 0;
			} catch {
				lastSyncOk = null;
			}
		}

		return reply.send({
			totalTorrents,
			byState,
			avgRatio: totalTorrents > 0 ? totalRatio / totalTorrents : 0,
			lowRatioCount,
			dlSpeed,
			upSpeed,
			lastSyncAt: lastSync?.createdAt.toISOString() ?? null,
			lastSyncOk,
			configuredInstances: instances.length,
			qbitInstances,
		});
	});

	// Manual trigger for the path-correlation backfill pass — same code
	// the scheduler runs every 6h, but on demand. Useful when an operator
	// has just configured qui / re-encrypted credentials and doesn't want
	// to wait a full scheduler cycle to see correlation results.
	//
	// Synchronous-on-success: returns when the sweep completes. A 5000-row
	// cap keeps a single request bounded even on libraries the size of a
	// fully-populated *arr ecosystem (the scheduler uses 500 to stay
	// gentle; the manual button accepts the larger budget because the
	// operator initiated it explicitly).
	// Manual inode-index rebuild — admin convenience endpoint.
	//
	// Triggers a fresh rebuild for one (or all) FS-enabled qui instances
	// owned by the caller. Useful after adding a batch of new torrents
	// or noticing stale correlations — operator can force a refresh
	// without waiting for the 30-min TTL.
	//
	// Body: { instanceId?: string } — when omitted, rebuilds all FS-
	// enabled qui instances for this user.
	//
	// Returns the build result per instance (file counts, duration).
	// Honors in-flight dedup, so two concurrent rebuild requests share
	// one build pass.
	app.post<{ Body?: { instanceId?: string } }>(
		"/qui/inode-index/rebuild",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const targetId = request.body?.instanceId;

			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: "QUI",
					enabled: true,
					hasLocalFilesystemAccess: true,
					...(targetId ? { id: targetId } : {}),
				},
			});
			if (instances.length === 0) {
				return reply.code(404).send({
					error: targetId
						? "Instance not found, not FS-enabled, or not owned by this user"
						: "No FS-enabled qui instances configured",
				});
			}

			// Invalidate the in-memory cache for these instances so the next
			// `buildFileIdIndex` call rebuilds instead of returning the
			// still-fresh cached copy. Mirrors what the TTL expiry would do
			// naturally, but immediately.
			for (const instance of instances) {
				clearFileIdIndexCache(instance.id);
			}

			interface PerInstanceResult {
				instanceId: string;
				label: string;
				durationMs: number;
				filesIndexed?: number;
				error?: string;
			}
			const results: PerInstanceResult[] = await Promise.all(
				instances.map(async (instance) => {
					const start = Date.now();
					try {
						const client = createQuiClient(app, instance);
						const index = await buildFileIdIndex(client, instance, request.log, app.prisma);
						return {
							instanceId: instance.id,
							label: instance.label,
							durationMs: Date.now() - start,
							filesIndexed: index.statted,
						};
					} catch (err) {
						return {
							instanceId: instance.id,
							label: instance.label,
							durationMs: Date.now() - start,
							error: getErrorMessage(err),
						};
					}
				}),
			);

			const succeeded = results.filter((r) => !r.error).length;
			request.log.info(
				{ userId, requested: instances.length, succeeded, results },
				"qui inode-index: manual rebuild complete",
			);
			return reply.send({ instancesProcessed: instances.length, succeeded, results });
		},
	);

	// Env-gated diagnostic endpoints (CodeQL alerts #197/#198 / js/path-injection).
	//
	// The inode-probe endpoint takes an operator-supplied path and runs
	// fs.stat() against it. Two layered defenses below:
	//
	//   1. ENABLE_DEBUG_ROUTES gate — the route doesn't exist in prod by
	//      default. Ops sets the env var for a debugging session.
	//   2. Path-allowlist sanitizer — `path.resolve()` collapses `..` and
	//      then we check the result is within one of the configured roots
	//      (defaults to common media-server bind-mount points; override via
	//      DEBUG_PROBE_ROOTS=/path1:/path2). This is what CodeQL needs to
	//      see in the dataflow to clear the alert, and it's real defense in
	//      depth: even with the route enabled, traversal outside allowed
	//      roots returns 403.
	if (process.env.ENABLE_DEBUG_ROUTES === "true") {
		const DEFAULT_PROBE_ROOTS = [
			"/config",
			"/media",
			"/data",
			"/downloads",
			"/tv",
			"/movies",
			"/music",
		];
		const ALLOWED_PROBE_ROOTS = (
			process.env.DEBUG_PROBE_ROOTS
				? process.env.DEBUG_PROBE_ROOTS.split(":").filter(Boolean)
				: DEFAULT_PROBE_ROOTS
		).map((r) => path.resolve(r));

		// Inode-probe diagnostic for the local-filesystem-access strategy.
		//
		// Given a path, returns the (st_dev, st_ino, nlink) tuple that
		// arr-dashboard's process can observe — or the errno when the path
		// can't be stat'd. Operators use this BEFORE flipping the
		// `hasLocalFilesystemAccess` toggle on a qui instance to confirm:
		//
		//   1. arr-dashboard can actually see the path (no ENOENT/EACCES).
		//   2. The file is hardlinked (nlink >= 2). If nlink == 1, the file
		//      is isolated from any qui torrent and inode matching can't
		//      correlate it.
		//   3. A library path and a torrent path share `(dev, ino)`. If dev
		//      differs, the two views are on different filesystems and
		//      hardlinks can't cross — inode matching is impossible.
		app.get<{ Querystring: { path?: string } }>(
			"/qui/debug/inode-probe",
			async (request, reply) => {
				const userPath = request.query.path;
				if (!userPath || typeof userPath !== "string") {
					return reply.code(400).send({ error: "missing required query param: path" });
				}
				// Resolve to absolute + collapsed form, then require it lives
				// inside an allowed root. The `+ path.sep` on the prefix check
				// stops `/media-backup` from matching `/media`.
				const resolved = path.resolve(userPath);
				const isWithinAllowed = ALLOWED_PROBE_ROOTS.some(
					(root) => resolved === root || resolved.startsWith(root + path.sep),
				);
				if (!isWithinAllowed) {
					return reply.code(403).send({
						error: "path outside allowed probe roots",
						resolved,
						allowedRoots: ALLOWED_PROBE_ROOTS,
					});
				}
				try {
					const { stat } = await import("node:fs/promises");
					const s = await stat(resolved);
					return reply.send({
						path: resolved,
						exists: true,
						dev: Number(s.dev),
						ino: Number(s.ino),
						nlink: Number(s.nlink),
						size: Number(s.size),
						isFile: s.isFile(),
						isDirectory: s.isDirectory(),
					});
				} catch (err) {
					const errno = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
					const message = err instanceof Error ? err.message : String(err);
					return reply.send({
						path: resolved,
						exists: false,
						errno,
						message,
					});
				}
			},
		);
	}

	// Cross-seed search for a stuck library item via qui's dir-scan webhook.
	//
	// Flow: caller provides a library_cache row id. We look up the row,
	// extract its on-disk path, and ask qui to scan that specific path for
	// cross-seed matches. qui takes over from there — searches configured
	// indexers via Prowlarr/Jackett, downloads matching .torrent files, and
	// adds them to qBit pointing at the existing library file (skip-hash-
	// check or recheck depending on qui's dir-scan settings). The next
	// inode-backfill sweep picks up the new correlation automatically.
	//
	// Prerequisite: qui must have a configured dir-scan directory whose
	// path is a prefix of the library item's path (e.g., `/data/media/movies`
	// for a movie at `/data/media/movies/Foo (2024)/...`). If not, qui
	// returns 404 "No matching directory found" and we relay that.
	app.post<{
		Body: {
			arrInstanceId: string;
			arrItemId: number;
			itemType: "movie" | "series" | "artist" | "author";
			quiInstanceId?: string;
		};
	}>("/qui/dirscan/trigger", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { arrInstanceId, arrItemId, itemType, quiInstanceId } = request.body ?? {};
		if (!arrInstanceId || typeof arrInstanceId !== "string") {
			return reply.code(400).send({ error: "arrInstanceId is required" });
		}
		if (typeof arrItemId !== "number") {
			return reply.code(400).send({ error: "arrItemId is required" });
		}

		// Ownership check: scope by userId via the instance relation so
		// callers can't probe other users' library rows even by guessing.
		const row = await app.prisma.libraryCache.findFirst({
			where: {
				arrItemId,
				itemType,
				instance: { id: arrInstanceId, userId },
			},
			select: { id: true, title: true, data: true, itemType: true, infoHash: true },
		});
		if (!row) {
			return reply.code(404).send({ error: "Library item not found" });
		}

		// Extract the on-disk path from the cached *arr response.
		// Movies use `data.path + "/" + data.movieFile.relativePath`,
		// series use `data.path` (folder-level — qui's dir-scan then
		// recursively scans inside). For per-episode correlation use
		// the EpisodeFileCache.path directly; this route handles
		// LibraryCache rows only.
		let scanPath: string | null = null;
		try {
			const parsed = JSON.parse(row.data) as Record<string, unknown>;
			const rootPath = typeof parsed.path === "string" ? parsed.path : null;
			if (row.itemType === "movie") {
				const mf = parsed.movieFile as Record<string, unknown> | null | undefined;
				const rel = typeof mf?.relativePath === "string" ? mf.relativePath : null;
				if (rootPath && rel) {
					scanPath = `${rootPath.replace(/\/+$/, "")}/${rel}`;
				}
			} else if (row.itemType === "series") {
				// qui's dir-scan walks recursively from the scan root, so
				// passing the series folder triggers a search across every
				// episode file inside.
				scanPath = rootPath;
			}
		} catch {
			// fall through — scanPath stays null and we'll 422 below
		}
		if (!scanPath) {
			return reply.code(422).send({
				error: "Could not determine on-disk path from library data",
			});
		}

		// Resolve which qui instance to use. If the caller specified one,
		// validate ownership. Otherwise, pick the first enabled qui for
		// this user — matches how the rest of the qui routes behave.
		const quiInstance = quiInstanceId
			? await app.prisma.serviceInstance.findFirst({
					where: { id: quiInstanceId, userId, service: "QUI", enabled: true },
				})
			: await app.prisma.serviceInstance.findFirst({
					where: { userId, service: "QUI", enabled: true },
				});
		if (!quiInstance) {
			return reply.code(404).send({ error: "No qui instance available" });
		}

		try {
			const client = createQuiClient(app, quiInstance);
			const result = await client.triggerDirScan(scanPath);
			request.log.info(
				{
					userId,
					arrInstanceId,
					arrItemId,
					itemType,
					title: row.title,
					scanPath,
					quiInstanceId: quiInstance.id,
					runId: result.runId,
					directoryId: result.directoryId,
				},
				"qui dir-scan triggered for stuck library item",
			);
			return reply.send({ ...result, scanPath });
		} catch (err) {
			// qui's webhook endpoint returns:
			//   404 — no configured dir-scan covers the path
			//   409 — scan already in progress for this directory
			//   400 — malformed payload (shouldn't happen)
			// Surface qui's status code verbatim so the UI can show a
			// useful message ("Configure dir-scan in qui first" vs
			// "Scan already running").
			const status =
				typeof (err as { statusCode?: number }).statusCode === "number"
					? (err as { statusCode: number }).statusCode
					: 502;
			const message = err instanceof Error ? err.message : "qui dir-scan trigger failed";
			request.log.warn(
				{ err, userId, arrInstanceId, arrItemId, scanPath, quiInstanceId: quiInstance.id },
				"qui dir-scan trigger failed",
			);
			return reply.code(status).send({ error: message });
		}
	});

	// Tracker-meta registry — single source of truth for "what does this
	// tracker look and read like." Fuses qui's icon map AND display-name
	// customizations into one merged response so the frontend doesn't
	// need our own static brand registry anymore.
	//
	// Two qui endpoints combined per request:
	//   - GET /api/tracker-icons          → Record<host, dataUrl>
	//   - GET /api/tracker-customizations → Array<{displayName, domains[]}>
	//
	// We invert the customizations into Record<host, displayName> (each
	// alias domain gets its own entry) and merge with the icon map.
	// Frontend gets: Record<host, { iconUrl?, name? }> — one entry per
	// host with whatever qui knows about it.
	//
	// Caching: per-user, 1-hour TTL. Soft-fail per sub-fetch (one's
	// failure doesn't block the other's data from reaching the panel).
	const TRACKER_META_TTL_MS = 60 * 60 * 1000;
	interface TrackerMetaEntry {
		iconUrl?: string;
		name?: string;
	}
	const trackerMetaCache = new Map<
		string,
		{ meta: Record<string, TrackerMetaEntry>; builtAt: number }
	>();
	// Route name kept as /tracker-icons for now to avoid renaming the
	// deployed frontend hook. The response shape evolves: the old `icons`
	// field stays for one transition cycle (sets the iconUrl for
	// compatibility) while the new `trackers` field is the canonical
	// merged map.
	app.get("/qui/tracker-icons", async (request, reply) => {
		const userId = request.currentUser!.id;
		const cached = trackerMetaCache.get(userId);
		if (cached && Date.now() - cached.builtAt < TRACKER_META_TTL_MS) {
			return reply.send({ trackers: cached.meta });
		}

		const instance = await app.prisma.serviceInstance.findFirst({
			where: { userId, service: "QUI", enabled: true },
		});
		if (!instance) {
			// No qui — empty map. Panel falls back to auto-derived
			// abbreviations from hostnames.
			return reply.send({ trackers: {} });
		}

		const merged: Record<string, TrackerMetaEntry> = {};
		const client = createQuiClient(app, instance);
		const [iconsResult, customsResult] = await Promise.allSettled([
			client.getTrackerIcons(),
			client.getTrackerCustomizations(),
		]);
		if (iconsResult.status === "fulfilled") {
			for (const [host, iconUrl] of Object.entries(iconsResult.value)) {
				merged[host] ??= {};
				merged[host].iconUrl = iconUrl;
			}
		} else {
			request.log.warn(
				{ err: iconsResult.reason, instanceId: instance.id },
				"qui tracker-icons fetch failed; merged map will lack icons",
			);
		}
		if (customsResult.status === "fulfilled") {
			// Each customization carries N domain aliases. Splay them so
			// every alias hostname maps to the same displayName.
			for (const c of customsResult.value) {
				for (const host of c.domains) {
					merged[host] ??= {};
					merged[host].name = c.displayName;
				}
			}
		} else {
			request.log.warn(
				{ err: customsResult.reason, instanceId: instance.id },
				"qui tracker-customizations fetch failed; merged map will lack names",
			);
		}

		trackerMetaCache.set(userId, { meta: merged, builtAt: Date.now() });
		return reply.send({ trackers: merged });
	});

	// Per-library-item seeding summary — small batch endpoint that feeds
	// the library grid. Frontend sends the IDs of items currently visible
	// (or a whole page), gets back `{trackerCount, topHosts}` per item.
	//
	// Architectural note: uses the SAME pipeline as the cluster endpoint
	// (inode multi-hash lookup + qui tracker meta). Reuses the cached
	// inode index, the cached tracker-meta registry, and the existing
	// `enrichTorrentHashes` helper. No duplicate signal, no separate
	// brand registry, no schema column to maintain.
	//
	// Caching: per (user, item set) for 10 min. The set hash is
	// stable for repeat-loads of the same library page. Aggressive
	// caching is fine because the underlying tracker data already has
	// its own 1h cache, and this just aggregates over a known item set.
	//
	// Cost: the bottleneck is the per-hash `getTrackers` qui call, which
	// we batch (concurrency cap of 32). For a typical 100-item library
	// page sharing ~50-150 unique hashes (cross-seeds collapse), first
	// load is ~1-2s; subsequent loads from cache are instant.
	const LIBRARY_SUMMARY_TTL_MS = 10 * 60 * 1000;
	interface LibrarySeedingSummaryEntry {
		trackerCount: number;
		topHosts: string[];
		hashCount: number;
	}
	const librarySummaryCache = new Map<
		string,
		{ summaries: Record<string, LibrarySeedingSummaryEntry>; builtAt: number }
	>();
	const LIBRARY_SUMMARY_BODY = z.object({
		// Each item carries its own arr instance ID so a single batch can
		// span multiple Sonarr/Radarr instances (the library page
		// renders items from all enabled instances when no filter is
		// applied). The arrInstanceId disambiguates `arrItemId` which
		// is only unique within an instance.
		items: z
			.array(
				z.object({
					arrInstanceId: z.string().min(1),
					itemId: z.number().int().positive(),
					itemType: z.enum(["movie", "series"]),
				}),
			)
			.min(1)
			.max(500),
	});
	app.post("/qui/library-seeding-summary", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(LIBRARY_SUMMARY_BODY, request.body);
		// Cache key is deterministic on the sorted item set including
		// instance IDs — different arr instances with the same arrItemId
		// don't collide. Two calls for the same page produce the same
		// key → cache hit.
		const sortedKey = body.items
			.map((i) => `${i.arrInstanceId}|${i.itemType}:${i.itemId}`)
			.sort()
			.join(",");
		const cacheKey = `${userId}|${sortedKey}`;
		const cached = librarySummaryCache.get(cacheKey);
		if (cached && Date.now() - cached.builtAt < LIBRARY_SUMMARY_TTL_MS) {
			return reply.send({ summaries: cached.summaries });
		}

		// FS-enabled qui instance is the only thing we strictly need —
		// per-item arr-instance scoping happens inline below via the
		// `instance.userId` join. No qui or no FS access → empty
		// summaries, cards render without the tracker strip.
		const quiInstance = await app.prisma.serviceInstance.findFirst({
			where: { userId, service: "QUI", enabled: true, hasLocalFilesystemAccess: true },
		});
		if (!quiInstance) {
			return reply.send({ summaries: {} });
		}

		// Reuse the cached inode index (built once per qui instance,
		// 30-min TTL, persisted across restarts). If the index isn't
		// warm, bail with empty rather than block the library page.
		const indexClient = createQuiClient(app, quiInstance);
		const inodeIndex = await Promise.race([
			buildFileIdIndex(indexClient, quiInstance, request.log, app.prisma).catch((err) => {
				// Mirror panel-routes which logs the same failure (used to be
				// silent here — a regression that breaks seeding badges would
				// only surface via user reports, not log signal).
				request.log.warn(
					{ err, quiInstanceId: quiInstance.id },
					"qui library-seeding-summary: inode index build failed; returning empty summary",
				);
				return null;
			}),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
		]);
		if (!inodeIndex) {
			return reply.send({ summaries: {} });
		}

		// Resolve each item's file paths. Movies → LibraryCache.data.path
		// + movieFile.relativePath. Series → all EpisodeFileCache rows.
		// Both done in parallel.
		interface ItemPaths {
			key: string; // "type:id"
			paths: string[];
		}
		const itemPaths: ItemPaths[] = await Promise.all(
			body.items.map(async ({ arrInstanceId, itemId, itemType }) => {
				// Key includes the *arr instance ID so two instances with
				// overlapping arrItemIds don't collide in the summary map.
				const key = `${arrInstanceId}|${itemType}:${itemId}`;
				if (itemType === "movie") {
					const row = await app.prisma.libraryCache.findFirst({
						where: {
							instanceId: arrInstanceId,
							arrItemId: itemId,
							itemType: "movie",
							instance: { userId },
						},
						select: { data: true },
					});
					if (!row) return { key, paths: [] };
					try {
						const parsed = JSON.parse(row.data) as Record<string, unknown>;
						const path = typeof parsed.path === "string" ? parsed.path : null;
						const movieFile = parsed.movieFile as Record<string, unknown> | null | undefined;
						const relativePath =
							movieFile &&
							typeof movieFile === "object" &&
							typeof movieFile.relativePath === "string"
								? movieFile.relativePath
								: null;
						if (path && relativePath) {
							return { key, paths: [`${path.replace(/\/+$/, "")}/${relativePath}`] };
						}
					} catch {
						/* fall through */
					}
					return { key, paths: [] };
				}
				// series: gather all episode files
				const episodes = await app.prisma.episodeFileCache.findMany({
					where: {
						instanceId: arrInstanceId,
						arrSeriesId: itemId,
						instance: { userId },
					},
					select: { path: true },
				});
				return { key, paths: episodes.map((e) => e.path).filter(Boolean) };
			}),
		);

		// stat() every path → inode → hash set. All in-memory after
		// inode index is warm; just a few hundred syscalls.
		const itemHashes = new Map<string, Set<string>>();
		const allHashes = new Set<string>();
		for (const { key, paths } of itemPaths) {
			const hashes = new Set<string>();
			await Promise.all(
				paths.map(async (p) => {
					const found = await getAllHashesForFileId(p, inodeIndex);
					for (const h of found) hashes.add(h);
				}),
			);
			itemHashes.set(key, hashes);
			for (const h of hashes) allHashes.add(h);
		}

		// Resolve per-hash tracker hostnames. Originally this loop made TWO
		// qui round-trips per hash: `getTorrentByHash` purely to look up
		// which qBit instance hosts that hash (so `getTrackers` knows which
		// instance to query), then `getTrackers` itself. With the SWR cache
		// in place, the first lookup becomes a Map.get() — we already have
		// every torrent in memory after a successful `listAllTorrents`. Cuts
		// the round-trip count from 2N to N (e.g., 300 → 150 on a 150-hash
		// page). The cached `QuiTorrent` doesn't carry trackers itself, so
		// the second call is unavoidable without a wider cache redesign.
		//
		// Cache miss → fall through to `getTorrentByHash` so behavior is
		// identical to the pre-cache path. Happens during a cold SWR window
		// or for hashes added since the cache was last refreshed.
		const client = createQuiClient(app, quiInstance);
		let hashToInstance: Map<string, number>;
		try {
			const cachedTorrents = await getCachedAllTorrents(quiInstance.id, client);
			hashToInstance = new Map(
				cachedTorrents
					.filter((t): t is typeof t & { instanceId: number } => typeof t.instanceId === "number")
					.map((t) => [t.hash.toLowerCase(), t.instanceId]),
			);
		} catch (err) {
			// If the cache fetch fails entirely (qui unreachable), every
			// per-hash request below would fail the same way. Continue with
			// an empty map; the per-hash try/catch logs zero hosts and the
			// summary degrades gracefully rather than 500-ing the whole route.
			// Logged so an operator notices a sustained outage rather than
			// just seeing a quietly-degraded library page.
			request.log.warn(
				{ err, quiInstanceId: quiInstance.id },
				"qui library-seeding-summary: torrent-list cache fetch failed; falling back to per-hash lookups",
			);
			hashToInstance = new Map();
		}

		const hashToHosts = new Map<string, string[]>();
		const hashArr = Array.from(allHashes);
		// Concurrency cap: qui can typically handle ~50 parallel requests
		// but we stay conservative at 32 to leave headroom for the
		// existing cluster endpoint that's running for any open panel.
		const CONCURRENCY = 32;
		for (let i = 0; i < hashArr.length; i += CONCURRENCY) {
			const batch = hashArr.slice(i, i + CONCURRENCY);
			await Promise.all(
				batch.map(async (hash) => {
					try {
						// Look up which qBit instance hosts this hash. The cache
						// covers the common case in zero round-trips; cache miss
						// falls back to the original cross-instance search.
						let instanceId = hashToInstance.get(hash.toLowerCase());
						if (instanceId === undefined) {
							const torrent = await client.getTorrentByHash(hash);
							if (!torrent || typeof torrent.instanceId !== "number") {
								hashToHosts.set(hash, []);
								return;
							}
							instanceId = torrent.instanceId;
						}
						const trackers = await client.getTrackers(instanceId, hash);
						const hosts = trackers
							.filter((t) => !t.url.startsWith("** "))
							.map((t) => extractHostnameSafe(t.url))
							.filter((h) => h.length > 0);
						hashToHosts.set(hash, hosts);
					} catch (err) {
						// One hash failing is fine (qui returns ENOENT for
						// torrents removed between cache refresh and now).
						// `debug` rather than `warn` because this can fire
						// dozens of times per page; the aggregate "all hashes
						// failed" case would still be visible via the empty
						// `hashToInstance` warn above.
						request.log.debug(
							{ err, hash },
							"qui library-seeding-summary: tracker fetch failed for hash",
						);
						hashToHosts.set(hash, []);
					}
				}),
			);
		}

		// Aggregate per item: union of all hosts across all hashes
		// covering it. trackerCount = distinct hosts. topHosts = up to
		// 4, preserving discovery order (qui's enumeration order for
		// the inode index, which roughly mirrors insertion time).
		const summaries: Record<string, LibrarySeedingSummaryEntry> = {};
		for (const [key, hashes] of itemHashes) {
			const hosts = new Set<string>();
			for (const h of hashes) {
				const hostsForHash = hashToHosts.get(h) ?? [];
				for (const host of hostsForHash) hosts.add(host);
			}
			summaries[key] = {
				trackerCount: hosts.size,
				topHosts: Array.from(hosts).slice(0, 4),
				hashCount: hashes.size,
			};
		}

		librarySummaryCache.set(cacheKey, { summaries, builtAt: Date.now() });
		return reply.send({ summaries });
	});

	app.post("/qui/backfill/run-now", async (request, reply) => {
		const userId = request.currentUser!.id;
		// Three-phase backfill pipeline:
		//   1. Movie sweep — Radarr library_cache rows missing infoHash.
		//      Inode lookup for FS-enabled qui instances + heuristic
		//      ladder for FS-disabled.
		//   2. Episode-file sync — pull /api/v3/episodefile?seriesId=X
		//      per Sonarr series with hasFile=true; upsert into the
		//      EpisodeFileCache table. Necessary because LibraryCache
		//      stores series-level rows without per-episode metadata.
		//   3. Episode sweep — inode lookup on the freshly-synced
		//      episode-file paths. Inode-only (no heuristic ladder for
		//      episodes in v1 — see episode-file-backfill module doc).
		//
		// All three run synchronously and return aggregate stats. The
		// frontend's "Run correlation now" button drives this endpoint.
		request.log.info(
			{ userId },
			"correlation backfill: manual trigger requested (movies + episodes)",
		);
		const movieSweep = await runPathBackfillSweep({
			app,
			log: request.log,
			batchSize: 5000,
		});
		const episodeSync = await runEpisodeFileSync({
			app,
			log: request.log,
			seriesCap: 1000,
		});
		const episodeSweep = await runEpisodeBackfillSweep({
			app,
			log: request.log,
			batchSize: 10000,
		});
		// Flatten the three-phase result into the aggregate the client
		// expects (`QuiBackfillNowResult`). Previously the route returned
		// `{ movieSweep, episodeSync, episodeSweep }` while the client
		// type declared a flat `{ rowsScanned, rowsHashed, ... }`,
		// causing `data.rowsHashed.toLocaleString()` to TypeError and the
		// frontend to show a false "Backfill failed" toast even though
		// the work succeeded. `episodeSync` doesn't contribute row counts
		// (it does an *arr API fetch + DB upsert, no hashing), so its
		// fields are folded into the aggregate only via `errors` +
		// `durationMs`. `usersScanned` takes the max — the three sweeps
		// scan the same set of qui-enabled users, so summing would
		// overcount.
		return reply.send({
			usersScanned: Math.max(
				movieSweep.usersScanned,
				episodeSync.usersScanned,
				episodeSweep.usersScanned,
			),
			rowsScanned: movieSweep.rowsScanned + episodeSweep.rowsScanned,
			rowsHashed: movieSweep.rowsHashed + episodeSweep.rowsHashed,
			rowsMissed: movieSweep.rowsMissed + episodeSweep.rowsMissed,
			errors: movieSweep.errors + episodeSync.errors + episodeSweep.errors,
			durationMs: movieSweep.durationMs + episodeSync.durationMs + episodeSweep.durationMs,
		});
	});

	app.get<{ Querystring: { limit?: string } }>("/qui/attention", async (request, reply) => {
		const userId = request.currentUser!.id;
		// Cap the response to avoid blowing up on libraries with thousands
		// of stalled torrents. Frontend can paginate / "show all" later.
		const limitRaw = Number.parseInt(request.query?.limit ?? "20", 10);
		const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20));

		const instances = await listQuiInstances(app, userId);
		if (instances.length === 0) {
			return reply.send({ items: [], totalCount: 0 });
		}

		// Collect attention-worthy torrents from every qui instance. The
		// "is this attention-worthy" rule lives here, not in qui — qui
		// reports raw state, we decide which states are operator-actionable.
		// Attention vocabulary uses the normalizer's actual outputs.
		// `stalled_dl` is a download stuck on no peers — almost always
		// the most actionable "something is wrong" state in qBit.
		//
		// IMPORTANT: low-ratio is NOT flagged as attention-worthy. On a
		// large seeding library most torrents have ratio < 1.0× simply
		// because they're newly added or because the user seeds to
		// many trackers; flagging them all drowns the feed. Low-ratio
		// stays visible as a KPI count ("N below 1.00×") instead.
		const attentionStates = new Set(["error", "paused", "stalled_dl"]);

		type AttentionTorrent = {
			hash: string;
			name: string;
			state: ReturnType<typeof normalizeTorrentState>;
			rawState: string;
			ratio: number;
			size: number;
			qbitInstanceId: number | null;
			qbitInstanceName: string | null;
			severity: "critical" | "warning";
			reason: string;
		};
		const collected: AttentionTorrent[] = [];

		for (const instance of instances) {
			let client: ReturnType<typeof createQuiClient>;
			try {
				client = createQuiClient(app, instance);
			} catch (err) {
				// Mirror /qui/summary's logging — was silent here, so an
				// encryption-key mismatch or similar config issue would
				// silently shrink the attention feed with no signal.
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui attention: client construction failed (likely encryption key mismatch); skipping instance",
				);
				continue;
			}
			let torrents: Awaited<ReturnType<typeof getCachedAllTorrents>>;
			try {
				torrents = await getCachedAllTorrents(instance.id, client);
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui attention: listAllTorrents failed; skipping instance",
				);
				continue;
			}
			// qui's reannounce monitor flags torrents stuck failing to reach
			// their tracker — a precise root cause a generic "stalled" state
			// can't express. Fetch per qBit instance present in this qui's
			// torrent list; a disabled reannounce service just returns [].
			const trackerProblemHashes = new Set<string>();
			const qbitIds = new Set<number>();
			for (const t of torrents) {
				if (typeof t.instanceId === "number") qbitIds.add(t.instanceId);
			}
			for (const qbitId of qbitIds) {
				try {
					const candidates = await client.getReannounceCandidates(qbitId);
					for (const c of candidates) {
						if (c.hasTrackerProblem) trackerProblemHashes.add(c.hash.toLowerCase());
					}
				} catch (err) {
					request.log.debug(
						{ err, instanceId: instance.id, qbitInstanceId: qbitId },
						"qui attention: reannounce-candidates fetch failed; skipping tracker signal",
					);
				}
			}
			for (const t of torrents) {
				const normalized = normalizeTorrentState(t.state);
				const hasTrackerProblem = trackerProblemHashes.has(t.hash.toLowerCase());
				if (!attentionStates.has(normalized) && !hasTrackerProblem) continue;
				// Severity heuristic: error → critical, paused/stalled/tracker → warning.
				const severity: "critical" | "warning" = normalized === "error" ? "critical" : "warning";
				const reasons: string[] = [];
				if (normalized === "error") reasons.push("Errored");
				if (normalized === "stalled_dl") reasons.push("Stalled (no peers)");
				if (normalized === "paused") reasons.push("Paused");
				if (hasTrackerProblem) reasons.push("Tracker failing");
				collected.push({
					hash: t.hash.toLowerCase(),
					name: t.name,
					state: normalized,
					rawState: t.state,
					ratio: t.ratio,
					size: t.size,
					qbitInstanceId: t.instanceId ?? null,
					qbitInstanceName: t.instanceName ?? null,
					severity,
					reason: reasons.join(" · ") || normalized,
				});
			}
		}

		// Sort: critical first, then by ratio ascending (worst-ratio bubbles up).
		collected.sort((a, b) => {
			if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
			return a.ratio - b.ratio;
		});
		const totalCount = collected.length;
		const sliced = collected.slice(0, limit);

		// Join with library_cache for *arr context where the infoHash
		// matches. Items qui has that no *arr instance tracks (orphans,
		// manually-added downloads) keep `libraryContext: null` and
		// render as "Unmapped" in the UI.
		const hashes = sliced.map((t) => t.hash);
		const cacheRows =
			hashes.length === 0
				? []
				: await app.prisma.libraryCache.findMany({
						where: {
							infoHash: { in: hashes },
							instance: { userId },
						},
						select: {
							id: true,
							infoHash: true,
							instanceId: true,
							arrItemId: true,
							itemType: true,
							title: true,
							year: true,
							instance: { select: { label: true, service: true } },
						},
					});

		const cacheByHash = new Map<string, (typeof cacheRows)[number]>();
		for (const row of cacheRows) {
			if (row.infoHash) cacheByHash.set(row.infoHash.toLowerCase(), row);
		}

		const arrServiceMap: Record<string, "sonarr" | "radarr" | "lidarr" | "readarr" | null> = {
			SONARR: "sonarr",
			RADARR: "radarr",
			LIDARR: "lidarr",
			READARR: "readarr",
		};

		const items = sliced.map((t) => {
			const ctx = cacheByHash.get(t.hash);
			const arrService = ctx ? arrServiceMap[ctx.instance.service] : null;
			return {
				hash: t.hash,
				name: t.name,
				state: t.state,
				ratio: t.ratio,
				size: t.size,
				qbitInstanceId: t.qbitInstanceId,
				qbitInstanceName: t.qbitInstanceName,
				severity: t.severity,
				reason: t.reason,
				libraryContext:
					ctx && arrService
						? {
								arrInstanceId: ctx.instanceId,
								arrInstanceLabel: ctx.instance.label,
								arrService,
								libraryCacheId: ctx.id,
								arrItemId: ctx.arrItemId,
								itemType: ctx.itemType as "movie" | "series" | "artist" | "author",
								title: ctx.title,
								year: ctx.year,
							}
						: null,
			};
		});

		return reply.send({ items, totalCount });
	});

	// qui Activity feed (Phase 3.2) — paginated chronological view of every
	// qui-related event arr-dashboard has emitted for this user. Eventually
	// joined by mutation events (Phase 4) and webhook events (Phase 5).
	app.get<{
		Querystring: { cursor?: string; limit?: string; eventType?: string };
	}>("/qui/activity", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { cursor, limit, eventType } = validateRequest(ACTIVITY_QUERY, request.query);
		const take = limit ?? 50;

		// Cursor convention: pass the id of the LAST event in the previous
		// page; the next page returns the next N events older than that row.
		// Empty/null cursor = fetch most-recent N.
		let cursorCreatedAt: Date | null = null;
		if (cursor) {
			const anchor = await app.prisma.quiActivityLog.findUnique({
				where: { id: cursor },
				select: { createdAt: true, userId: true },
			});
			// SECURITY: refuse cursor lookups that belong to another user, so
			// the cursor cannot be used to enumerate cross-user event ids.
			if (anchor && anchor.userId === userId) {
				cursorCreatedAt = anchor.createdAt;
			}
		}

		const events = await app.prisma.quiActivityLog.findMany({
			where: {
				userId,
				...(eventType ? { eventType } : {}),
				...(cursorCreatedAt ? { createdAt: { lt: cursorCreatedAt } } : {}),
			},
			orderBy: { createdAt: "desc" },
			take: take + 1, // fetch one extra to detect "has next page"
		});

		const hasMore = events.length > take;
		const trimmed = hasMore ? events.slice(0, take) : events;
		const nextCursor = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;

		return reply.send({
			events: trimmed.map((e) => {
				const createdAtIso = e.createdAt.toISOString();
				return {
					id: e.id,
					eventType: e.eventType,
					// `severity` is the canonical field; `status` aliased for one
					// release window. See the schema notes on
					// `quiActivityEventSchema` for the rename rationale.
					severity: e.severity,
					status: e.severity,
					createdAt: createdAtIso,
					// `timestamp` is the canonical wire alias — every paginated
					// qui feed exposes it identically so the frontend's cursor
					// logic doesn't need to remember per-feed field names.
					timestamp: createdAtIso,
					details: safeParseJson(e.details),
				};
			}),
			nextCursor,
		});
	});
}
