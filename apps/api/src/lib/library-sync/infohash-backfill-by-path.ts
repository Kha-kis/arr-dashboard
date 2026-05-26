/**
 * Path-correlation infoHash backfill (sister of `infohash-backfill.ts`).
 *
 * The original backfill resolves `LibraryCache.infoHash` by querying
 * *arr's `/api/v3/history/{movie|series}` for the downloadId. That path
 * works for items grabbed recently enough to still have a history record
 * — but Sonarr/Radarr's "History Retention" setting prunes old grabs
 * aggressively, leaving most older items without a recoverable downloadId
 * and forever orphaned from qui correlation.
 *
 * This module bypasses *arr's history entirely. It correlates by ON-DISK
 * SHAPE instead:
 *
 *   1. Pull qui's full torrent list (`client.listAllTorrents()`).
 *   2. Build a search index keyed by (a) `contentPath` and (b) the
 *      `(name, size)` fingerprint.
 *   3. For every Radarr movie row missing an `infoHash` but with
 *      `hasFile=true`, extract the on-disk path + filename + size from
 *      its cached *arr response.
 *   4. Try the two-pass match:
 *        Pass 1 — exact `contentPath` (works when *arr + qui see
 *                 identical paths, the common case in single-host setups).
 *        Pass 2 — `(name, size)` fingerprint (catches the **hardlink case**:
 *                 *arr's download client hardlinked the torrent file into
 *                 the library folder, so qui's `contentPath` points to
 *                 `/data/torrents/movies/x.mkv` while *arr's path is
 *                 `/data/media/movies/x.mkv` — different strings, same
 *                 inode, same filename and size).
 *   5. On match, write the hash back to `library_cache.infoHash`.
 *
 * Scope notes:
 *
 * - **Movies only for v1.** Radarr stores one `movieFile` per movie row;
 *   Sonarr stores series-level rows whose `data` JSON does NOT carry
 *   per-episode file info — the episodeFile lookup is a separate *arr
 *   endpoint. Series-level path matching would force us to pick *one*
 *   episode's hash for the whole series, which is misleading. Skip
 *   series here and revisit when LibraryCache grows per-episode rows.
 *
 * - **Music / books left for later** — same reason as series.
 *
 * - **Per-user qui scope.** Each user has their own qui instances; we
 *   iterate users-with-qui and build the search index per-user.
 */

import type { QuiTorrent } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { createQuiClient } from "../qui/client-factory.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
	buildFileIdIndex,
	type FileIdIndex,
	matchLibraryByFileId,
} from "./infohash-backfill-by-inode.js";

/**
 * Stable string identifiers for the strategy that produced an infoHash.
 * Written verbatim to `LibraryCache.infoHashSource` so the UI can render
 * the right confidence chip. Two tiers:
 *   - "verified" (inode, path-exact) — the file IS what we say it is.
 *   - "heuristic" (name-size, title-year) — best-guess from observed
 *     fingerprints; could be wrong in rare cases.
 */
export type InfoHashSource = "inode" | "path-exact" | "name-size" | "title-year";

export interface PathBackfillSweepResult {
	usersScanned: number;
	rowsScanned: number;
	rowsHashed: number;
	rowsMissed: number;
	errors: number;
	durationMs: number;
}

export interface PathBackfillSweepArgs {
	app: FastifyInstance;
	log?: FastifyBaseLogger;
	/** Cap on rows touched per sweep. Same as the *arr-history backfill. */
	batchSize: number;
}

/**
 * Parsed movie-file metadata extracted from `library_cache.data`.
 * Captures everything we need for the two matching passes.
 */
interface MovieFileFingerprint {
	/** Library-side full file path: `data.path + "/" + data.movieFile.relativePath`. */
	libraryPath: string;
	/** Just the filename (`data.movieFile.relativePath`). Used in `(name, size)` fingerprint. */
	filename: string;
	/** File size in bytes (`data.movieFile.size`). */
	size: number;
	/** Movie title from *arr (`data.title`). Used as a corroborating signal
	 * alongside size for the rename+hardlink case where neither path nor
	 * filename match. */
	arrTitle: string;
	/** Release year from *arr (`data.year`). Strongest single signal for
	 * narrowing the qui search space — a year-mismatch is essentially
	 * always a different movie regardless of size coincidence. */
	arrYear: number | null;
}

/**
 * Extract a `MovieFileFingerprint` from a Radarr library-cache `data`
 * JSON blob. Returns null if any required field is missing — better
 * to silently skip a malformed row than write a guess.
 */
function extractMovieFingerprint(rawData: string): MovieFileFingerprint | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawData);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const d = parsed as Record<string, unknown>;
	const path = typeof d.path === "string" ? d.path : null;
	const mf = d.movieFile as Record<string, unknown> | null | undefined;
	if (!path || !mf || typeof mf !== "object") return null;
	const relativePath = typeof mf.relativePath === "string" ? mf.relativePath : null;
	const size = typeof mf.size === "number" ? mf.size : null;
	if (!relativePath || size === null) return null;
	const trimmedPath = path.replace(/\/+$/, "");
	const arrTitle = typeof d.title === "string" ? d.title : "";
	const arrYear = typeof d.year === "number" ? d.year : null;
	return {
		libraryPath: `${trimmedPath}/${relativePath}`,
		filename: relativePath,
		size,
		arrTitle,
		arrYear,
	};
}

/**
 * Stopwords that are too common to disambiguate a torrent match. If we
 * required ALL title tokens to appear in the qui torrent name and the
 * title was "A Star Is Born", "a" and "is" would match thousands of
 * torrents. Filter these out so the title-match check stays meaningful.
 */
const TITLE_STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"of",
	"is",
	"to",
	"and",
	"or",
	"in",
	"on",
	"at",
	"for",
]);

/**
 * Tokenize a movie title or torrent name for fuzzy comparison. Lower-
 * cases, splits on common torrent-name delimiters (dots, dashes, spaces,
 * brackets, underscores), and strips short tokens (single characters
 * are too low-signal). Stopwords filtered separately at the comparison
 * site so the function stays reusable.
 */
function tokenizeForTitleMatch(s: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of s.toLowerCase().split(/[\s.\-_[\](){}+,!:]+/)) {
		if (raw.length < 2) continue;
		tokens.add(raw);
	}
	return tokens;
}

/**
 * Check whether qui's torrent name plausibly refers to the same movie
 * as *arr's title + year. Conservative on purpose: all non-stopword
 * title tokens must appear in the qui name, AND if *arr has a year,
 * the year must appear in the qui name too. Catches the rename case
 * (e.g., qui torrent name `After.Life.2009.Repack...`) while rejecting
 * unrelated movies (e.g., `Spider.Man.2009.RemuxBalanced...` for the
 * library item `Spider-Man 2`).
 */
function titleAndYearMatch(fp: MovieFileFingerprint, quiName: string): boolean {
	const arrTokens = tokenizeForTitleMatch(fp.arrTitle);
	const significant = Array.from(arrTokens).filter((t) => !TITLE_STOPWORDS.has(t));
	if (significant.length === 0) return false; // Title was all stopwords or empty.
	const quiTokens = tokenizeForTitleMatch(quiName);
	for (const token of significant) {
		if (!quiTokens.has(token)) return false;
	}
	// Year check: if *arr has a year, qui's name must contain it. A
	// year-mismatch is essentially always a different movie (e.g.,
	// remakes), even when title tokens overlap.
	if (fp.arrYear !== null) {
		if (!quiTokens.has(String(fp.arrYear))) return false;
	}
	return true;
}

/**
 * Search index over a single user's qui torrents. Built once per sweep,
 * O(N) where N is the number of torrents. All three lookups are O(1).
 */
interface QuiSearchIndex {
	/** `torrent.contentPath` → hash. May omit empties. */
	byContentPath: Map<string, string>;
	/** `${name}:${size}` fingerprint → hash. Catches hardlinked items
	 * where qui's name still equals the original on-disk filename. */
	byNameAndSize: Map<string, string>;
	/**
	 * `size` → list of (hash, name) tuples. The third matching pass
	 * narrows candidates by SIZE (same inode → same byte count), then
	 * verifies via TITLE+YEAR token match against the qui torrent name.
	 * Two unrelated files at the same byte count is possible (~0.1% in
	 * a 10k library, not "essentially zero" as an earlier comment
	 * claimed), so we need the title+year corroboration to avoid
	 * writing wrong hashes.
	 */
	bySize: Map<number, Array<{ hash: string; name: string }>>;
}

function buildSearchIndex(torrents: QuiTorrent[]): QuiSearchIndex {
	const byContentPath = new Map<string, string>();
	const byNameAndSize = new Map<string, string>();
	const bySize = new Map<number, Array<{ hash: string; name: string }>>();
	for (const t of torrents) {
		// qBittorrent convention: `savePath` is the parent directory the
		// torrent content lives in. For a single-file torrent the full
		// path is `savePath + "/" + name`. For multi-file torrents the
		// full path is just `savePath` (qBit puts everything inside the
		// torrent's folder, which is named `name`). We index both forms
		// to cover both cases without callers having to know which is which.
		const trimmedSave = t.savePath ? t.savePath.replace(/\/+$/, "") : "";
		if (trimmedSave) {
			byContentPath.set(`${trimmedSave}/${t.name}`, t.hash);
			byContentPath.set(trimmedSave, t.hash);
		}
		byNameAndSize.set(`${t.name}:${t.size}`, t.hash);
		// Size index: store ALL torrents at each size. The third pass
		// resolves ambiguity by filtering candidates via title+year token
		// match against qui's torrent name.
		const bucket = bySize.get(t.size);
		if (bucket) {
			bucket.push({ hash: t.hash, name: t.name });
		} else {
			bySize.set(t.size, [{ hash: t.hash, name: t.name }]);
		}
	}
	return { byContentPath, byNameAndSize, bySize };
}

/**
 * The successful-match return shape used by every strategy. The `source`
 * label is written to `LibraryCache.infoHashSource` and surfaces as a
 * confidence chip in the UI. Two tiers:
 *   - "verified" (inode, path-exact)
 *   - "heuristic" (name-size, title-year)
 */
export interface HeuristicMatchResult {
	hash: string;
	source: Exclude<InfoHashSource, "inode">;
}

/**
 * Match a movie's on-disk fingerprint to a qui torrent. Returns
 * `{ hash, source }` on success, null on miss. Three strategies in order
 * of strictness — strict first so false-positive risk is bounded:
 *   1. `contentPath` exact (source `"path-exact"`)
 *   2. `(name, size)` fingerprint (source `"name-size"`)
 *   3. size + title-and-year token match (source `"title-year"`)
 *
 * Strategy 3 catches the *arr-rename case where neither path nor filename
 * match because *arr renamed the file during import. Requires the qui
 * torrent name to contain every non-stopword token from *arr's title AND
 * the year (if any). If multiple qui torrents at the same size pass this
 * filter, we abstain (returns null) rather than risk writing a wrong hash.
 *
 * Callers reach here only for qui instances with `hasLocalFilesystemAccess
 * === false`. FS-enabled instances use the inode strategy exclusively
 * (see `runPathBackfillSweep` for the per-instance gating).
 */
function findMatch(fp: MovieFileFingerprint, index: QuiSearchIndex): HeuristicMatchResult | null {
	// Pass 1: identical contentPath — zero false-positive risk.
	const exact = index.byContentPath.get(fp.libraryPath);
	if (exact) return { hash: exact, source: "path-exact" };
	// Pass 2: (filename, size) fingerprint — works when *arr DIDN'T
	// rename the file on import.
	const fingerprint = index.byNameAndSize.get(`${fp.filename}:${fp.size}`);
	if (fingerprint) return { hash: fingerprint, source: "name-size" };
	// Pass 3: size + title+year token check. Same byte count is the
	// strongest single signal (hardlinks preserve content), but size
	// alone CAN collide for unrelated content — so we require the qui
	// torrent's name to plausibly refer to the same movie via the
	// title-token check before correlating. Two qui torrents at the
	// same size that BOTH pass the title check (rare edge case) →
	// ambiguous, abstain.
	const sizeBucket = index.bySize.get(fp.size);
	if (!sizeBucket || sizeBucket.length === 0) return null;
	const candidates = sizeBucket.filter((t) => titleAndYearMatch(fp, t.name));
	if (candidates.length === 1) return { hash: candidates[0]!.hash, source: "title-year" };
	return null;
}

/**
 * Pure helper extracted so callers can unit-test the matching logic
 * without needing a Prisma DB. Public for that reason.
 */
export const __testOnly = {
	extractMovieFingerprint,
	buildSearchIndex,
	findMatch,
	titleAndYearMatch,
	tokenizeForTitleMatch,
};

/**
 * Run one path-correlation backfill sweep. Designed to run AFTER the
 * *arr-history backfill in the same scheduler tick — anything that pass
 * couldn't resolve (history pruned) gets a second chance via path/inode.
 *
 * Caps work at `batchSize` rows total across all users. Same shape as
 * `runInfoHashBackfillSweep` so the scheduler can call them in series
 * with predictable budgets.
 */
export async function runPathBackfillSweep({
	app,
	log,
	batchSize,
}: PathBackfillSweepArgs): Promise<PathBackfillSweepResult> {
	const startedAt = Date.now();
	const result: PathBackfillSweepResult = {
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

		// Fetch this user's qui instances and partition by FS-access mode.
		// Strict per-instance scoping (mirrors qui's HasLocalFilesystemAccess):
		//   - FS-enabled instances → inode index only. No heuristic fallback.
		//   - FS-disabled instances → torrents unioned into a heuristic index.
		// A row gets the verified strategy first; if no FS-enabled instance
		// holds an inode match, we fall through to heuristics on the union.
		const quiInstances = await app.prisma.serviceInstance.findMany({
			where: { service: "QUI", userId, enabled: true },
		});
		if (quiInstances.length === 0) continue;

		const fsEnabledInstances = quiInstances.filter((qi) => qi.hasLocalFilesystemAccess === true);
		const fsDisabledInstances = quiInstances.filter((qi) => qi.hasLocalFilesystemAccess !== true);

		// Build inode indices for each FS-enabled instance. We keep them
		// separate (not unioned) so we can log per-instance diagnostics on
		// stat failures. Either index can be partial; that's fine — a partial
		// inode match is still verified truth.
		const inodeIndices: Array<{ instanceId: string; index: FileIdIndex }> = [];
		for (const qi of fsEnabledInstances) {
			try {
				const client = createQuiClient(app, qi);
				const index = await buildFileIdIndex(client, qi, log);
				inodeIndices.push({ instanceId: qi.id, index });
			} catch (err) {
				result.errors++;
				log?.warn(
					{ err, userId, quiInstanceId: qi.id, quiInstanceLabel: qi.label },
					"path-backfill: failed to build inode index for FS-enabled qui instance; skipping",
				);
			}
		}

		// Build the heuristic union from FS-disabled instances only.
		const heuristicTorrents: QuiTorrent[] = [];
		let heuristicAllErrored = fsDisabledInstances.length > 0;
		for (const qi of fsDisabledInstances) {
			try {
				const client = createQuiClient(app, qi);
				const torrents = await client.listAllTorrents();
				heuristicTorrents.push(...torrents);
				heuristicAllErrored = false;
			} catch (err) {
				result.errors++;
				log?.warn(
					{ err, userId, quiInstanceId: qi.id, quiInstanceLabel: qi.label },
					"path-backfill: qui instance unreachable; skipping its torrents",
				);
			}
		}
		const heuristicIndex =
			heuristicTorrents.length > 0 ? buildSearchIndex(heuristicTorrents) : null;

		// If every qui source for this user failed to produce a usable
		// index, skip the user entirely. Next sweep retries.
		if (inodeIndices.length === 0 && !heuristicIndex && heuristicAllErrored) {
			continue;
		}

		const remaining = batchSize - result.rowsScanned;
		// Path-correlation is movies-only for v1 (see module-level doc).
		// Restrict by Radarr service AND no infoHash AND has a file.
		const rows = await app.prisma.libraryCache.findMany({
			where: {
				infoHash: null,
				itemType: "movie",
				hasFile: true,
				instance: { userId, service: "RADARR" },
			},
			orderBy: { cachedAt: "asc" },
			take: remaining,
			select: { id: true, data: true, title: true },
		});

		for (const row of rows) {
			result.rowsScanned++;
			const fp = extractMovieFingerprint(row.data);
			if (!fp) {
				result.rowsMissed++;
				continue;
			}

			let match: { hash: string; source: InfoHashSource } | null = null;

			// Verified pass: try each FS-enabled instance's inode index.
			// First hit wins (the same inode shouldn't legitimately be in
			// multiple instances unless they share storage, in which case
			// either answer is correct).
			for (const { index } of inodeIndices) {
				const inodeHit = await matchLibraryByFileId(fp.libraryPath, index);
				if (inodeHit) {
					match = inodeHit;
					break;
				}
			}

			// Heuristic pass (only if no inode match AND heuristics enabled
			// for at least one instance).
			if (!match && heuristicIndex) {
				match = findMatch(fp, heuristicIndex);
			}

			if (!match) {
				result.rowsMissed++;
				continue;
			}

			try {
				await app.prisma.libraryCache.update({
					where: { id: row.id },
					data: { infoHash: match.hash, infoHashSource: match.source },
				});
				result.rowsHashed++;
				log?.debug(
					{
						userId,
						cacheRowId: row.id,
						title: row.title,
						hash: match.hash,
						source: match.source,
					},
					"path-backfill: matched library item to qui torrent",
				);
			} catch (err) {
				result.errors++;
				log?.warn(
					{ err: getErrorMessage(err), userId, cacheRowId: row.id },
					"path-backfill: persist failed",
				);
			}
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
		"path-correlation infoHash backfill sweep completed",
	);
	return result;
}
