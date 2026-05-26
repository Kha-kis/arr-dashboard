import type { FastifyInstance } from "fastify";
import {
	buildFileIdIndex,
	getAllHashesForFileId,
} from "../../lib/library-sync/infohash-backfill-by-inode.js";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { enrichTorrentHashes } from "./qui-shared.js";

export function registerPanelRoutes(app: FastifyInstance): void {
	// Series-level torrent / cross-seed overview.
	//
	// Renders the per-series rich panel in the library detail modal. The
	// shape is **content clusters** — each cluster is one set of episodes
	// covered by 1..N torrent copies (tracker mirrors via qui's hardlink
	// automation). A 4-tracker S02 pack → 1 cluster with 4 copies, not 4
	// duplicated rows with a redundant siblings sub-list.
	//
	// Three trust-correctness fixes happen here:
	//   1. **Stale cache healing** — when an episode's cached infoHash
	//      points at a torrent qui no longer has but a fresh inode lookup
	//      finds replacement hashes, rewrite the cache canonical so it
	//      stops appearing as a phantom row.
	//   2. **Phantom suppression** — cached hashes that aren't in any
	//      live qui index AND have replacement hashes from the inode set
	//      are dropped from the response.
	//   3. **Action items** — surface actionable things (stuck episodes,
	//      unhealthy trackers, dormant content) at the top instead of
	//      making the user infer them from the row list.
	//
	// Scope-bound to one user via the instance.userId relation, same
	// ownership pattern as the rest of qui.ts.
	app.get<{ Params: { arrInstanceId: string; arrItemId: string } }>(
		"/qui/series/:arrInstanceId/:arrItemId/torrents",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { arrInstanceId } = request.params;
			const arrItemId = Number.parseInt(request.params.arrItemId, 10);
			if (!Number.isFinite(arrItemId)) {
				return reply.code(400).send({ error: "arrItemId must be a number" });
			}

			// Ownership: confirm the user owns the (instance, series) before
			// pulling its episode-file cache rows. Without this scoping a
			// caller could enumerate any user's library by guessing pair ids.
			const seriesRow = await app.prisma.libraryCache.findFirst({
				where: {
					instanceId: arrInstanceId,
					arrItemId,
					itemType: "series",
					instance: { userId },
				},
				select: { id: true, title: true },
			});
			if (!seriesRow) {
				return reply.code(404).send({ error: "Series not found" });
			}

			// Pull all episode files for this series in one query. Each row
			// is one EpisodeFile (multi-ep files like `S01E01-E02.mkv` are
			// ONE EpisodeFile covering two Episode entities) — see the
			// EpisodeFileCache schema comment.
			const episodes = await app.prisma.episodeFileCache.findMany({
				where: { instanceId: arrInstanceId, arrSeriesId: arrItemId },
				select: {
					id: true,
					arrEpisodeFileId: true,
					seasonNumber: true,
					relativePath: true,
					path: true,
					size: true,
					qualityName: true,
					releaseGroup: true,
					infoHash: true,
					infoHashSource: true,
				},
				orderBy: [{ seasonNumber: "asc" }, { relativePath: "asc" }],
			});

			const totalEpisodes = episodes.length;
			const viaInodeEpisodes = episodes.filter((e) => e.infoHashSource === "inode").length;

			// Look up a single qui instance for index building. FS-enabled
			// instance preferred (only those have a meaningful inode index).
			const fsInstance = await app.prisma.serviceInstance.findFirst({
				where: { userId, service: "QUI", enabled: true, hasLocalFilesystemAccess: true },
			});

			// Race the inode index build against a 22-second timeout. A cold
			// build over a large qui library (~12k torrents → ~50k stat ops)
			// can exceed Next.js's 30s proxy timeout. Rather than letting
			// the request 504, we return what we have (cached infoHashes
			// only) and let the build continue in the background — the next
			// request after it completes gets full multi-hash coverage.
			//
			// In-flight dedup inside `buildFileIdIndex` ensures the
			// background promise isn't restarted by subsequent requests.
			let inodeIndex: Awaited<ReturnType<typeof buildFileIdIndex>> | null = null;
			if (fsInstance) {
				const indexClient = createQuiClient(app, fsInstance);
				// Pass `app.prisma` so successful builds are persisted to the
				// `InodeIndexCache` table. Next startup hydrates from this row
				// and the panel loads cold-cache-free.
				const buildPromise = buildFileIdIndex(
					indexClient,
					fsInstance,
					request.log,
					app.prisma,
				).catch((err) => {
					request.log.warn(
						{ err, quiInstanceId: fsInstance.id },
						"qui series-torrents: inode index build failed; using cached-hash fallback",
					);
					return null;
				});
				// Clearable timeout — when the build wins the race we don't want
				// a stray 22s timer sitting in Node's wheel. clearTimeout in
				// finally fires whether the build won or lost, so no stale handle.
				let timeoutHandle: NodeJS.Timeout | undefined;
				const timeoutPromise = new Promise<null>((resolve) => {
					timeoutHandle = setTimeout(() => resolve(null), 22000);
				});
				try {
					inodeIndex = await Promise.race([buildPromise, timeoutPromise]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
				if (inodeIndex === null) {
					request.log.info(
						{ quiInstanceId: fsInstance.id, arrSeriesId: arrItemId },
						"qui series-torrents: inode index not ready yet (cold build); returning cached-hash response. Reload after build completes for full multi-hash coverage.",
					);
				}
			}

			// Per-episode hash collection. For each episode we record:
			//   - inodeHashes: hashes the live qui inode index knows about
			//     for this specific file (cross-seeds the user actually has)
			//   - cachedHash: the canonical written by backfill (may be stale)
			//
			// Stale-detection rule: cached hash exists, inode lookup returned
			// at least one hash, but cached hash isn't in that inode set →
			// the cached canonical points at a torrent qui no longer has.
			// We heal those by rewriting cache to inodeHashes[0] AND drop
			// the stale cached hash from the response.
			const perEpisode = await Promise.all(
				episodes.map(async (ep) => {
					const inodeHashes =
						inodeIndex && ep.path ? await getAllHashesForFileId(ep.path, inodeIndex) : [];
					const cachedStale =
						ep.infoHash !== null &&
						inodeHashes.length > 0 &&
						!inodeHashes.some((h) => h.toLowerCase() === ep.infoHash!.toLowerCase());
					return { ep, inodeHashes, cachedStale };
				}),
			);

			// Apply healing: for stale episodes, write the canonical inode
			// hash back so the next page load (and the backfill sweep) see
			// fresh data. Use individual updates rather than chunked updateMany
			// because each row gets a different target hash.
			const healCandidates = perEpisode.filter(
				(p): p is typeof p & { inodeHashes: [string, ...string[]] } =>
					p.cachedStale && p.inodeHashes.length > 0,
			);
			let healedEpisodes = 0;
			if (healCandidates.length > 0) {
				await Promise.all(
					healCandidates.map(({ ep, inodeHashes }) =>
						app.prisma.episodeFileCache.update({
							where: { id: ep.id },
							data: { infoHash: inodeHashes[0], infoHashSource: "inode" },
						}),
					),
				);
				healedEpisodes = healCandidates.length;
				request.log.info(
					{ userId, arrInstanceId, arrSeriesId: arrItemId, healed: healedEpisodes },
					"qui series-torrents: healed stale cached infoHashes",
				);
			}

			// Effective per-episode hash list — for each episode, prefer
			// inode hashes when available (they're live); fall back to cached
			// when no inode data exists (FS-disabled instance). Cached hashes
			// that are stale and have replacements are excluded.
			interface EpisodeContext {
				ep: (typeof episodes)[number];
				/** Hashes that map to this episode in the response. */
				effectiveHashes: string[];
				/** True when at least one hash came from a live inode lookup. */
				inodeVerified: boolean;
			}
			const episodeContexts: EpisodeContext[] = perEpisode.map(
				({ ep, inodeHashes, cachedStale }) => {
					const hashes = new Set<string>();
					for (const h of inodeHashes) hashes.add(h);
					// Cached hash: include only when not stale. If cachedStale is true
					// but we have replacements, the cached hash is dropped — that's
					// what removes the phantom rows.
					if (ep.infoHash && !cachedStale) hashes.add(ep.infoHash);
					return {
						ep,
						effectiveHashes: Array.from(hashes),
						inodeVerified: inodeHashes.length > 0 || ep.infoHashSource === "inode",
					};
				},
			);

			// "Stuck" now = episode with zero effective hashes. A previously-
			// correlated episode whose cache we just healed isn't stuck; an
			// episode whose only cached hash was stale-with-no-replacement
			// IS stuck (we couldn't find anything live).
			const stuckEpisodes = episodeContexts.filter((c) => c.effectiveHashes.length === 0).length;
			const correlatedEpisodes = totalEpisodes - stuckEpisodes;

			// Per-torrent coverage map — invert the per-episode lookup to
			// produce one entry per unique torrent hash, recording exactly
			// which episode files in THIS series the torrent covers.
			//
			// The previous primitive (per-episode hash union → cluster by
			// hash set) double-counted torrents in mixed-coverage scenarios:
			// a season pack hash would appear in N clusters when N episodes
			// had per-episode REPACK siblings. Inverting to per-torrent
			// coverage gives each unique torrent exactly one membership.
			//
			// Built from the same `episodeContexts` data — every hash that
			// covers any episode picks up that episode's id. A torrent NOT
			// hardlinked to any *arr-managed file in this series never
			// appears here at all (correct — it doesn't cover the series).
			interface PerHashCoverage {
				episodeFileIds: Set<number>;
				seasons: Set<number>;
				totalSize: bigint;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
			}
			const hashCoverage = new Map<string, PerHashCoverage>();
			for (const ctx of episodeContexts) {
				if (ctx.effectiveHashes.length === 0) continue; // stuck
				for (const hash of ctx.effectiveHashes) {
					let acc = hashCoverage.get(hash);
					if (!acc) {
						acc = {
							episodeFileIds: new Set(),
							seasons: new Set(),
							totalSize: 0n,
							qualityName: ctx.ep.qualityName,
							releaseGroup: ctx.ep.releaseGroup,
							inodeVerified: ctx.inodeVerified,
						};
						hashCoverage.set(hash, acc);
					}
					acc.episodeFileIds.add(ctx.ep.arrEpisodeFileId);
					acc.seasons.add(ctx.ep.seasonNumber);
					acc.totalSize += ctx.ep.size;
					if (ctx.inodeVerified) acc.inodeVerified = true;
				}
			}

			// Cluster torrents by **identical coverage** — same set of
			// episode files = different tracker copies of the same release.
			// All hashes with the same coverage share the cluster's size /
			// quality / release-group fields (provably consistent because
			// they all hardlink to the same files).
			interface ClusterAccumulator {
				episodeFileIds: number[];
				seasons: Set<number>;
				totalSize: bigint;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
				hashes: Set<string>;
			}
			const clusterMap = new Map<string, ClusterAccumulator>();
			for (const [hash, cov] of hashCoverage) {
				const episodeIds = Array.from(cov.episodeFileIds).sort((a, b) => a - b);
				const signature = episodeIds.join("|");
				let cluster = clusterMap.get(signature);
				if (!cluster) {
					cluster = {
						episodeFileIds: episodeIds,
						seasons: new Set(cov.seasons),
						totalSize: cov.totalSize,
						qualityName: cov.qualityName,
						releaseGroup: cov.releaseGroup,
						inodeVerified: cov.inodeVerified,
						hashes: new Set(),
					};
					clusterMap.set(signature, cluster);
				}
				cluster.hashes.add(hash);
				if (cov.inodeVerified) cluster.inodeVerified = true;
			}

			// Resolve the qui instance once for enrichment. We need one
			// instance per torrent fetch — fsInstance preferred (it has FS
			// access for path matching), else any enabled qui.
			let quiInstance: Awaited<ReturnType<typeof app.prisma.serviceInstance.findFirst>> =
				fsInstance;
			if (!quiInstance && clusterMap.size > 0) {
				quiInstance = await app.prisma.serviceInstance.findFirst({
					where: { userId, service: "QUI", enabled: true },
				});
			}

			// Collect all unique hashes across clusters (one shared fetch
			// per hash; multi-cluster sharing is rare but happens for
			// multi-season packs split into per-season clusters).
			const allHashes = new Set<string>();
			for (const acc of clusterMap.values()) for (const h of acc.hashes) allHashes.add(h);

			// Enrich via the shared module-scope helper. Same code path
			// the /qui/movie/.../torrents route uses — guarantees both
			// routes stay in lockstep on trust signals.
			const enrichedCopies = await enrichTorrentHashes({
				app,
				quiInstance,
				hashes: allHashes,
				log: request.log,
			});

			// Build cluster objects. Sort copies within a cluster: library-role
			// first (Sonarr/Radarr-managed), then by tracker name for stable
			// rendering. Drop quiUnreachable copies from the cluster when at
			// least one reachable copy exists — the cluster already proves
			// coverage; orphan-hash rows are noise.
			interface SeriesTorrentCluster {
				key: string;
				episodeFileIds: number[];
				episodeCount: number;
				seasons: number[];
				/** "S02 · 8 episodes" / "S03E04 · 1 episode" — for the header. */
				coverageLabel: string;
				totalSizeBytes: string;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
				copies: import("./qui-shared.js").ClusterCopy[];
				/** True when every copy has 0 peers — actionable signal. */
				isDormant: boolean;
				/** Aggregate state for the cluster header. */
				primaryState: string | null;
				/**
				 * Cross-reference: this cluster's episodes are a STRICT subset of
				 * another cluster's coverage (i.e., a pack covers a superset of
				 * episodes). Surfaces redundancy without hiding it — user sees
				 * "S04E07 REPACK ↳ also covered by S04 pack". Null when this
				 * cluster's coverage isn't a subset of any other cluster.
				 *
				 * Inode-correctness: since clusters are built from per-torrent
				 * coverage of *arr files (via inode lookups), a cluster only
				 * appears here if its torrents share an inode with the pack's
				 * files for those episodes. A "separate single-episode release"
				 * with its own inode never lands in any cluster's coverage in
				 * the first place — the cross-ref claim is provably accurate.
				 */
				coveredBy: {
					clusterKey: string;
					coverageLabel: string;
					copyCount: number;
				} | null;
			}

			const formatCoverageLabel = (seasons: number[], episodeIds: number[]): string => {
				if (episodeIds.length === 0) return "—";
				if (seasons.length === 1) {
					if (episodeIds.length === 1) {
						// Pull the single episode's "S0xE0y" from the cached path.
						const ep = episodes.find((e) => e.arrEpisodeFileId === episodeIds[0]);
						const match = ep?.relativePath.match(/S\d{1,2}E\d{1,3}/i);
						if (match) return `${match[0]} · 1 episode`;
						return `S${String(seasons[0]).padStart(2, "0")} · 1 episode`;
					}
					return `S${String(seasons[0]).padStart(2, "0")} · ${episodeIds.length} episodes`;
				}
				const labels = seasons.map((s) => `S${String(s).padStart(2, "0")}`).join(", ");
				return `${labels} · ${episodeIds.length} episodes`;
			};

			const clusters: SeriesTorrentCluster[] = Array.from(clusterMap.entries())
				.map(([signature, acc]) => {
					const seasonsArr = Array.from(acc.seasons).sort((a, b) => a - b);
					const allCopies = Array.from(acc.hashes).map((h) => enrichedCopies.get(h)!);
					const reachable = allCopies.filter((c) => !c.quiUnreachable);
					// Keep reachable when any exist; otherwise keep unreachable (so
					// FS-disabled-instance setups still see something useful).
					const copies = reachable.length > 0 ? reachable : allCopies;
					copies.sort((a, b) => {
						if (a.role !== b.role) return a.role === "library" ? -1 : 1;
						return (a.tracker ?? "").localeCompare(b.tracker ?? "");
					});

					// Dormant: all copies report 0 seeds AND 0 leeches AND ratio<1.
					// Ratio<1 keeps us from flagging well-seeded torrents that just
					// happen to have a momentary 0-peer reading.
					const isDormant =
						copies.length > 0 &&
						copies.every(
							(c) => (c.numSeeds ?? 0) === 0 && (c.numLeechs ?? 0) === 0 && (c.ratio ?? 1) < 1,
						);

					const primaryState = copies.find((c) => c.state !== null)?.state ?? null;

					return {
						key: signature,
						episodeFileIds: acc.episodeFileIds.sort((a, b) => a - b),
						episodeCount: acc.episodeFileIds.length,
						seasons: seasonsArr,
						coverageLabel: formatCoverageLabel(seasonsArr, acc.episodeFileIds),
						totalSizeBytes: acc.totalSize.toString(),
						qualityName: acc.qualityName,
						releaseGroup: acc.releaseGroup,
						inodeVerified: acc.inodeVerified,
						copies,
						isDormant,
						primaryState,
						coveredBy: null, // resolved after sort, see subset pass below
					};
				})
				// Sort: biggest packs first, then by season number ascending.
				.sort((a, b) => {
					if (a.episodeCount !== b.episodeCount) return b.episodeCount - a.episodeCount;
					return (a.seasons[0] ?? 0) - (b.seasons[0] ?? 0);
				});

			// Subset cross-reference pass: for each cluster, find the smallest
			// STRICT-superset cluster (covers all of its episodes plus more).
			// "Smallest" is intentional — if both S04 pack and a complete-series
			// pack cover S04E07-REPACK, we want to surface "covered by S04 pack"
			// (the closest container) rather than "covered by series pack".
			//
			// O(N²) over cluster count. N is typically 1-10 for a series, so
			// this is trivial. If a series had hundreds of clusters we'd switch
			// to coverage-set bitmap intersections.
			//
			// Precompute each cluster's coverage-set ONCE outside the inner
			// loop. Without this we'd allocate a fresh Set per (cluster, other,
			// episode) iteration — bounded but unnecessary GC pressure.
			const clusterEpSets = new Map<string, Set<number>>();
			for (const cluster of clusters) {
				clusterEpSets.set(cluster.key, new Set(cluster.episodeFileIds));
			}
			for (const cluster of clusters) {
				if (cluster.episodeCount === 0) continue;
				let bestSuperset: (typeof clusters)[number] | null = null;
				for (const other of clusters) {
					if (other === cluster) continue;
					if (other.episodeCount <= cluster.episodeCount) continue;
					const otherSet = clusterEpSets.get(other.key)!;
					// Strict superset check: every episode in `cluster` must be in `other`.
					let isSuperset = true;
					for (const id of cluster.episodeFileIds) {
						if (!otherSet.has(id)) {
							isSuperset = false;
							break;
						}
					}
					if (!isSuperset) continue;
					if (!bestSuperset || other.episodeCount < bestSuperset.episodeCount) {
						bestSuperset = other;
					}
				}
				if (bestSuperset) {
					cluster.coveredBy = {
						clusterKey: bestSuperset.key,
						coverageLabel: bestSuperset.coverageLabel,
						copyCount: bestSuperset.copies.length,
					};
				}
			}

			// Action items: surface what the user can do, not just what exists.
			interface SeriesActionItem {
				kind: "stuck_episodes" | "stale_cache_healed" | "dormant_content" | "fs_unavailable";
				severity: "warning" | "info";
				title: string;
				detail: string;
				count?: number;
			}
			const actionItems: SeriesActionItem[] = [];
			if (stuckEpisodes > 0) {
				actionItems.push({
					kind: "stuck_episodes",
					severity: "warning",
					title: `${stuckEpisodes} episode${stuckEpisodes === 1 ? "" : "s"} not seeding`,
					detail: "Files have no live torrent. Use cross-seed search above or re-grab via Sonarr.",
					count: stuckEpisodes,
				});
			}
			if (healedEpisodes > 0) {
				actionItems.push({
					kind: "stale_cache_healed",
					severity: "info",
					title: `${healedEpisodes} stale cache ${healedEpisodes === 1 ? "entry" : "entries"} healed`,
					detail:
						"Old infoHash references were replaced with the current live torrents. Future loads will be accurate.",
					count: healedEpisodes,
				});
			}
			const dormantClusterCount = clusters.filter((c) => c.isDormant).length;
			if (dormantClusterCount > 0) {
				actionItems.push({
					kind: "dormant_content",
					severity: "warning",
					title: `${dormantClusterCount} torrent${dormantClusterCount === 1 ? "" : "s"} with no peers`,
					detail:
						"Ratio is below 1.0 and no seeders/leechers are connected. Consider re-seeding or removing.",
					count: dormantClusterCount,
				});
			}
			if (!fsInstance) {
				actionItems.push({
					kind: "fs_unavailable",
					severity: "info",
					title: "No FS-enabled qui instance",
					detail:
						"Cross-seed coverage relies on cached hashes only. Enable filesystem access on a qui instance for live inode matching.",
				});
			}

			// Season groups — the top-level navigational structure for the UI.
			// One group per season number that has episodes in this series.
			// Each group lists its clusters (by key) so the frontend can
			// render seasons-first without re-deriving from cluster.seasons.
			//
			// Multi-season packs (rare — a torrent spanning S01-S05) appear
			// in each season group they cover, with a `spansMultipleSeasons:
			// true` flag on the cluster itself for the UI to badge it.
			//
			// Stuck episodes (no live torrent) get a compact per-file list
			// inside the season group — so a fully-stuck season can render
			// the "Cross-seed search / Re-grab via Sonarr" CTA strip with
			// the affected episodes inline.
			interface SeasonGroup {
				seasonNumber: number;
				totalEpisodes: number;
				correlatedEpisodes: number;
				stuckEpisodes: number;
				/** Cluster keys belonging to this season, sorted by coverage desc. */
				clusterKeys: string[];
				/** Stuck episode files — for inline "missing release" display. */
				stuckEpisodeFiles: Array<{
					arrEpisodeFileId: number;
					relativePath: string;
				}>;
			}

			const seasonGroupMap = new Map<number, SeasonGroup>();
			// Walk every episode (correlated or stuck) so each season's totals
			// reflect the actual library, not just the correlated subset.
			for (const ep of episodes) {
				let group = seasonGroupMap.get(ep.seasonNumber);
				if (!group) {
					group = {
						seasonNumber: ep.seasonNumber,
						totalEpisodes: 0,
						correlatedEpisodes: 0,
						stuckEpisodes: 0,
						clusterKeys: [],
						stuckEpisodeFiles: [],
					};
					seasonGroupMap.set(ep.seasonNumber, group);
				}
				group.totalEpisodes++;
			}
			// Pull correlation from episodeContexts (post-heal, includes inode hits).
			for (const ctx of episodeContexts) {
				const group = seasonGroupMap.get(ctx.ep.seasonNumber)!;
				if (ctx.effectiveHashes.length > 0) {
					group.correlatedEpisodes++;
				} else {
					group.stuckEpisodes++;
					group.stuckEpisodeFiles.push({
						arrEpisodeFileId: ctx.ep.arrEpisodeFileId,
						relativePath: ctx.ep.relativePath,
					});
				}
			}
			// Wire clusters into their season group(s). A cluster's seasons
			// array can have more than one entry for multi-season packs;
			// each gets a reference. The frontend de-dupes by clusterKey
			// when a cluster is referenced from multiple groups.
			for (const cluster of clusters) {
				for (const seasonNum of cluster.seasons) {
					const group = seasonGroupMap.get(seasonNum);
					if (group) group.clusterKeys.push(cluster.key);
				}
			}
			const seasonGroups: SeasonGroup[] = Array.from(seasonGroupMap.values()).sort(
				(a, b) => a.seasonNumber - b.seasonNumber,
			);

			// Diagnostic: emit cluster summary at info level so operators can
			// confirm clustering behavior without enabling debug logs. Compact
			// shape — one line per cluster with coverage + copy count + first
			// 8 chars of each hash.
			request.log.info(
				{
					userId,
					arrSeriesId: arrItemId,
					totalEpisodes,
					stuckEpisodes,
					clusterCount: clusters.length,
					clusters: clusters.map((c) => ({
						coverage: c.coverageLabel,
						episodes: c.episodeCount,
						copies: c.copies.length,
						hashes: c.copies.map((cp) => cp.infoHash.slice(0, 8)),
					})),
				},
				"qui series-torrents: cluster summary",
			);

			return reply.send({
				seriesTitle: seriesRow.title,
				totalEpisodes,
				correlatedEpisodes,
				viaInodeEpisodes,
				stuckEpisodes,
				healedEpisodes,
				actionItems,
				clusters,
				seasonGroups,
			});
		},
	);

	// Movie-level torrent overview.
	//
	// Same response shape as the series-torrents route, but for a single
	// movie file. There's only ever ONE cluster (the movie file itself,
	// covered by N tracker copies via qui's cross-seed automation), and
	// `seasonGroups` is always empty — the frontend uses that as the
	// signal to render clusters flat instead of season-grouped.
	//
	// Same trust-correctness pipeline as series:
	//   - Inode multi-hash lookup against the *arr-managed file
	//   - Stale cache healing
	//   - Per-tracker enrichment via getTrackers (authoritative)
	//   - DHT/PeX/LSD detection respecting qBit's `health` field
	//   - Action items (stuck, dormant, fs_unavailable, healed)
	app.get<{ Params: { arrInstanceId: string; arrItemId: string } }>(
		"/qui/movie/:arrInstanceId/:arrItemId/torrents",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { arrInstanceId } = request.params;
			const arrItemId = Number.parseInt(request.params.arrItemId, 10);
			if (!Number.isFinite(arrItemId)) {
				return reply.code(400).send({ error: "arrItemId must be a number" });
			}

			// Ownership: confirm the user owns the (instance, movie) pair
			// before pulling its torrent data. The unique constraint
			// `(instanceId, arrItemId, itemType)` guarantees one row max.
			const movieRow = await app.prisma.libraryCache.findFirst({
				where: {
					instanceId: arrInstanceId,
					arrItemId,
					itemType: "movie",
					instance: { userId },
				},
				select: {
					id: true,
					title: true,
					year: true,
					infoHash: true,
					infoHashSource: true,
					sizeOnDisk: true,
					qualityProfileName: true,
					data: true,
				},
			});
			if (!movieRow) {
				return reply.code(404).send({ error: "Movie not found" });
			}

			// Extract the on-disk file path AND the file's quality tier from
			// the data blob. Quality tier ≠ user's quality profile:
			//   - `qualityProfileName` is the user's policy ("Anime Dual Audio")
			//   - `movieFile.quality.quality.name` is the file's actual
			//     classification from Radarr's release parser ("WEBDL-1080p")
			// The panel wants the file's tier — answers "what is this?"
			// instead of "what did I ask for?"
			let libraryPath: string | null = null;
			let releaseGroup: string | null = null;
			let qualityTier: string | null = null;
			try {
				const parsed = JSON.parse(movieRow.data) as Record<string, unknown>;
				const path = typeof parsed.path === "string" ? parsed.path : null;
				const movieFile = parsed.movieFile as Record<string, unknown> | null | undefined;
				const relativePath =
					movieFile && typeof movieFile === "object" && typeof movieFile.relativePath === "string"
						? movieFile.relativePath
						: null;
				if (path && relativePath) {
					libraryPath = `${path.replace(/\/+$/, "")}/${relativePath}`;
				}
				if (movieFile && typeof movieFile === "object") {
					const rg = movieFile.releaseGroup;
					if (typeof rg === "string") releaseGroup = rg;
					// Quality is nested as `movieFile.quality.quality.name`
					// (Radarr's wire shape — outer `quality` is the version
					// wrapper, inner `quality` is the tier).
					const qWrap = movieFile.quality as Record<string, unknown> | null | undefined;
					const qInner = qWrap?.quality as Record<string, unknown> | null | undefined;
					if (qInner && typeof qInner.name === "string") {
						qualityTier = qInner.name;
					}
				}
			} catch (err) {
				request.log.debug(
					{ err, movieId: movieRow.id },
					"qui movie-torrents: data blob parse failed; treating movie as having no file",
				);
			}

			// Locate the FS-enabled qui instance (preferred for inode lookups)
			// or fall back to any enabled qui for cached-only mode.
			const fsInstance = await app.prisma.serviceInstance.findFirst({
				where: { userId, service: "QUI", enabled: true, hasLocalFilesystemAccess: true },
			});

			// Build the inode index — same timeout race the series route uses
			// to avoid blocking on cold cache builds beyond the proxy limit.
			let inodeIndex: Awaited<ReturnType<typeof buildFileIdIndex>> | null = null;
			if (fsInstance) {
				const indexClient = createQuiClient(app, fsInstance);
				const buildPromise = buildFileIdIndex(
					indexClient,
					fsInstance,
					request.log,
					app.prisma,
				).catch((err) => {
					request.log.warn(
						{ err, quiInstanceId: fsInstance.id },
						"qui movie-torrents: inode index build failed; using cached-hash fallback",
					);
					return null;
				});
				let timeoutHandle: NodeJS.Timeout | undefined;
				const timeoutPromise = new Promise<null>((resolve) => {
					timeoutHandle = setTimeout(() => resolve(null), 22000);
				});
				try {
					inodeIndex = await Promise.race([buildPromise, timeoutPromise]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
			}

			// Multi-hash lookup for the movie file. When the inode index
			// found multiple hashes (cross-seeded content), all show up in
			// the cluster. When the cached hash is stale (in DB but not in
			// the live index), heal it to the canonical inode hash.
			let inodeHashes: string[] = [];
			if (inodeIndex && libraryPath) {
				inodeHashes = await getAllHashesForFileId(libraryPath, inodeIndex);
			}

			const cachedHashIsStale =
				movieRow.infoHash !== null &&
				inodeHashes.length > 0 &&
				!inodeHashes.some((h) => h.toLowerCase() === movieRow.infoHash!.toLowerCase());

			let healedEpisodes = 0;
			if (cachedHashIsStale && inodeHashes.length > 0) {
				await app.prisma.libraryCache.update({
					where: { id: movieRow.id },
					data: { infoHash: inodeHashes[0], infoHashSource: "inode" },
				});
				healedEpisodes = 1;
				request.log.info(
					{ userId, arrInstanceId, arrMovieId: arrItemId },
					"qui movie-torrents: healed stale cached infoHash",
				);
			}

			// Effective hashes for the movie file:
			//   - Inode hashes when available (preferred — live)
			//   - Else the cached hash (when not stale)
			//   - Empty when stuck (no torrent at all)
			const effectiveHashes = new Set<string>();
			for (const h of inodeHashes) effectiveHashes.add(h);
			if (movieRow.infoHash && !cachedHashIsStale) effectiveHashes.add(movieRow.infoHash);

			// Resolve quiInstance for enrichment (fsInstance preferred for path-
			// based matching; fall back to any enabled qui).
			let quiInstance: Awaited<ReturnType<typeof app.prisma.serviceInstance.findFirst>> =
				fsInstance;
			if (!quiInstance && effectiveHashes.size > 0) {
				quiInstance = await app.prisma.serviceInstance.findFirst({
					where: { userId, service: "QUI", enabled: true },
				});
			}

			// Enrich via the shared helper. Same trust pipeline as series.
			const enrichedCopies = await enrichTorrentHashes({
				app,
				quiInstance,
				hashes: effectiveHashes,
				log: request.log,
			});

			// Build the single cluster covering this movie file (when correlated).
			// No subset detection needed — movies have exactly zero or one cluster.
			interface MovieCluster {
				key: string;
				episodeFileIds: number[];
				episodeCount: number;
				seasons: number[];
				coverageLabel: string;
				totalSizeBytes: string;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
				copies: import("./qui-shared.js").ClusterCopy[];
				isDormant: boolean;
				primaryState: string | null;
				coveredBy: null;
			}
			const clusters: MovieCluster[] = [];
			if (effectiveHashes.size > 0) {
				const allCopies = Array.from(effectiveHashes).map((h) => enrichedCopies.get(h)!);
				const reachable = allCopies.filter((c) => !c.quiUnreachable);
				const copies = reachable.length > 0 ? reachable : allCopies;
				copies.sort((a, b) => {
					if (a.role !== b.role) return a.role === "library" ? -1 : 1;
					return (a.tracker ?? "").localeCompare(b.tracker ?? "");
				});
				const isDormant =
					copies.length > 0 &&
					copies.every(
						(c) => (c.numSeeds ?? 0) === 0 && (c.numLeechs ?? 0) === 0 && (c.ratio ?? 1) < 1,
					);
				const primaryState = copies.find((c) => c.state !== null)?.state ?? null;
				const movieTitle = movieRow.year ? `${movieRow.title} (${movieRow.year})` : movieRow.title;
				clusters.push({
					key: Array.from(effectiveHashes).sort().join("|"),
					// Movies have no episode_file_id concept — empty array signals
					// "this cluster has no episode-file granularity." Subset detection
					// (which keys on episodeFileIds) never picks this up, which is
					// correct: a movie cluster has no "parent" pack to defer to.
					episodeFileIds: [],
					episodeCount: 1,
					seasons: [],
					coverageLabel: movieTitle,
					totalSizeBytes: movieRow.sizeOnDisk.toString(),
					qualityName: qualityTier, // tier ("WEBDL-1080p"), not profile name
					releaseGroup,
					inodeVerified: inodeHashes.length > 0 || movieRow.infoHashSource === "inode",
					copies,
					isDormant,
					primaryState,
					coveredBy: null,
				});
			}

			const stuckEpisodes = effectiveHashes.size === 0 ? 1 : 0;
			const correlatedEpisodes = 1 - stuckEpisodes;
			const viaInodeEpisodes = inodeHashes.length > 0 ? 1 : 0;

			// Action items — same vocabulary as the series route so the
			// frontend renders them identically.
			interface SeriesActionItem {
				kind: "stuck_episodes" | "stale_cache_healed" | "dormant_content" | "fs_unavailable";
				severity: "warning" | "info";
				title: string;
				detail: string;
				count?: number;
			}
			const actionItems: SeriesActionItem[] = [];
			if (stuckEpisodes > 0) {
				actionItems.push({
					kind: "stuck_episodes",
					severity: "warning",
					title: "Movie file not seeding",
					detail:
						"This movie has no live torrent. Use cross-seed search above or re-grab via Radarr.",
					count: 1,
				});
			}
			if (healedEpisodes > 0) {
				actionItems.push({
					kind: "stale_cache_healed",
					severity: "info",
					title: "Stale cache entry healed",
					detail:
						"The old infoHash reference was replaced with the current live torrent. Future loads will be accurate.",
					count: 1,
				});
			}
			if (clusters[0]?.isDormant) {
				actionItems.push({
					kind: "dormant_content",
					severity: "warning",
					title: "All copies have no peers",
					detail:
						"Ratio is below 1.0 and no seeders/leechers are connected. Consider re-seeding or removing.",
					count: 1,
				});
			}
			if (!fsInstance) {
				actionItems.push({
					kind: "fs_unavailable",
					severity: "info",
					title: "No FS-enabled qui instance",
					detail:
						"Cross-seed coverage relies on cached hashes only. Enable filesystem access on a qui instance for live inode matching.",
				});
			}

			request.log.info(
				{
					userId,
					arrMovieId: arrItemId,
					stuckEpisodes,
					clusterCount: clusters.length,
					copies: clusters[0]?.copies.length ?? 0,
				},
				"qui movie-torrents: response summary",
			);

			return reply.send({
				seriesTitle: movieRow.title, // shape parity — frontend reuses the same field name
				totalEpisodes: 1,
				correlatedEpisodes,
				viaInodeEpisodes,
				stuckEpisodes,
				healedEpisodes,
				actionItems,
				clusters,
				seasonGroups: [], // movies never have season grouping
			});
		},
	);
}
