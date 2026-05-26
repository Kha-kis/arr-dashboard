/**
 * Heap Monitor Plugin
 *
 * Periodically logs `process.memoryUsage()` so operators can spot rising
 * heap baselines BEFORE the container hits its `--max-old-space-size` cap
 * and OOMs. Each sample includes deltas vs. the previous sample so a slow
 * leak shows up as monotonic growth even when individual samples look
 * reasonable.
 *
 * Added in v2.18.5 as the verification half of the issue #427 fix series:
 * the static-analysis sweep capped most known transient peaks, but the
 * 766 MB *live* heap reported in the most recent OOM trace pointed at
 * possible persistent retention that's hard to pin without runtime data.
 * This plugin is that runtime data.
 *
 * What gets logged:
 *   - heapUsedMB / heapTotalMB / heapPct       — V8 heap pressure
 *   - rssMB                                     — total RSS the kernel sees
 *   - externalMB / arrayBuffersMB              — Buffer / native allocations
 *   - heapDeltaMB / rssDeltaMB                 — change since last sample
 *   - secondsSinceLast / uptimeSec             — temporal context
 *
 * Severity:
 *   - heapPct > 0.9 → `warn` (visible in default log levels — operator alert)
 *   - heapPct > 0.8 → `info`
 *   - else          → `debug`
 *
 * Auto-snapshot behavior (added 2026-05-12):
 *   When a sample crosses WARN_HEAP_PCT, the plugin streams a heap snapshot
 *   to /config/heap-snapshots/ automatically. Rate-limited to one snapshot
 *   per AUTO_SNAPSHOT_MIN_INTERVAL_MS, with rotation that keeps the most
 *   recent AUTO_SNAPSHOT_MAX_RETAINED files. This removes the timing
 *   problem with the manual `dump-heap` helper (V8 takes 10-30s to write a
 *   half-gig snapshot; operators were ls-ing before the file landed).
 *
 *   Opt out via HEAP_AUTO_SNAPSHOT_AT_WARN=0 if you don't want unsolicited
 *   files in /config (e.g., low-disk hosts).
 *
 *   Setting HEAP_AUTO_SNAPSHOT=0 (the broader opt-in/opt-out var also read by
 *   start-combined.sh) ALSO disables warn-time snapshots — operators who set
 *   either var to 0 expect "no surprise snapshots," and the prior split where
 *   `HEAP_AUTO_SNAPSHOT=0` left warn-time captures running was a footgun
 *   (issue #471).
 *
 * Companion runtime knobs:
 *   - `--heapsnapshot-signal=SIGUSR2`  Always on (set in Dockerfile
 *     NODE_OPTIONS). An operator can also capture a snapshot on demand via:
 *       docker exec <container> dump-heap
 *     The helper walks /proc to find the API process (no pgrep/procps
 *     required), sends SIGUSR2, and waits for the snapshot to appear.
 *
 *   - `HEAP_AUTO_SNAPSHOT=1` env var  OPT-IN. When set, start-combined.sh
 *     appends --heapsnapshot-near-heap-limit=1 so V8 auto-captures a
 *     snapshot just before OOM. Off by default because each snapshot is ~3x
 *     the heap (~2.3 GB at the 768 MB cap) — a lot for small /config volumes.
 *     Setting it to "0" is treated as a global kill switch (see above).
 */

import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { getHeapSnapshot } from "node:v8";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";

import { getErrorMessage } from "../lib/utils/error-message.js";

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — enough resolution to spot leaks, light on log volume.
const WARN_HEAP_PCT = 0.9;
const INFO_HEAP_PCT = 0.8;

// RSS-bloat detection (issue #427 / #471 follow-up).
//
// A healthy Node process sits at ~1.3–1.6x heap (libuv, V8 metadata, native
// deps, TLS buffers). Anything ≥ 2x means non-V8 allocations exceed the V8
// heap itself — classic external/native memory pressure or glibc arena
// fragmentation. The V8 heap can look healthy while RSS bloats past the
// container limit, which is exactly what was observed in #471 (heapTotal
// 347MB / RSS 1227MB → 3.5x).
//
// Skip the first hour to avoid startup-spike false positives, and rate-limit
// the warning so a sustained-bloat process doesn't spam logs every 5 minutes.
const RSS_BLOAT_RATIO = 2.0;
const RSS_BLOAT_MIN_UPTIME_SEC = 60 * 60; // 1 hour warmup window
const RSS_BLOAT_LOG_INTERVAL_MS = 60 * 60 * 1000; // at most once per hour

/**
 * Resolve the heap-snapshot directory. The /config/* path is the Docker
 * production convention (matches logger.ts and config-dev path layout).
 * In dev mode we fall back to ./config-dev/heap-snapshots so the scheduler
 * doesn't EACCES every 5 min trying to write to the root-owned /config dir.
 * Matches the same dev/Docker auto-detection pattern as `lib/logger.ts`.
 */
function resolveSnapshotDir(): string {
	if (process.env.HEAP_SNAPSHOT_DIR) return process.env.HEAP_SNAPSHOT_DIR;
	const isDev = process.env.NODE_ENV !== "production";
	const isDocker = !isDev || process.cwd().startsWith("/app");
	return isDocker ? "/config/heap-snapshots" : "./config-dev/heap-snapshots";
}
const SNAPSHOT_DIR = resolveSnapshotDir();
// Warn-time auto snapshots are on by default; disabled if EITHER the precise
// opt-out (HEAP_AUTO_SNAPSHOT_AT_WARN=0) or the broader kill switch
// (HEAP_AUTO_SNAPSHOT=0) is set. The broader var matches operator expectations
// — see issue #471. Note that an unset HEAP_AUTO_SNAPSHOT does NOT disable
// warn-time captures; only the explicit string "0" does.
const AUTO_SNAPSHOT_AT_WARN =
	process.env.HEAP_AUTO_SNAPSHOT_AT_WARN !== "0" && process.env.HEAP_AUTO_SNAPSHOT !== "0";
const AUTO_SNAPSHOT_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes between captures
const AUTO_SNAPSHOT_MAX_RETAINED = 3; // rotate aggressively — files are ~heap-size MB

interface MemorySample {
	heapUsedMB: number;
	heapTotalMB: number;
	rssMB: number;
	externalMB: number;
	arrayBuffersMB: number;
	heapPct: number;
	timestamp: number;
}

let lastSnapshotAt: number | null = null;
let snapshotInFlight = false;
// Module-level mutable state for the once-per-hour bloat throttle.
// Held as an object property so the binding itself is `const` (biome) while
// the field is freely reassigned by the sampler.
const rssBloatState: { lastLogAt: number | null } = { lastLogAt: null };

/**
 * Stream a heap snapshot to disk. Returns true if a file was written.
 *
 * Uses `getHeapSnapshot()` (returns Readable) rather than `writeHeapSnapshot()`
 * (sync to filename) so the file write doesn't block the event loop beyond the
 * unavoidable V8 stop-the-world walk. The walk itself still pauses execution
 * (~2-5s on a 500 MB heap) but that's intrinsic to capturing a consistent
 * snapshot.
 */
async function captureHeapSnapshot(log: FastifyBaseLogger, heapUsedMB: number): Promise<boolean> {
	const now = Date.now();
	if (snapshotInFlight) {
		log.debug("Heap snapshot already in flight, skipping");
		return false;
	}
	if (lastSnapshotAt && now - lastSnapshotAt < AUTO_SNAPSHOT_MIN_INTERVAL_MS) {
		const minutesSince = Math.round((now - lastSnapshotAt) / 60_000);
		log.debug(
			{ minutesSinceLast: minutesSince },
			"Heap snapshot rate-limited (< 30 min since last capture)",
		);
		return false;
	}

	snapshotInFlight = true;
	try {
		if (!existsSync(SNAPSHOT_DIR)) {
			mkdirSync(SNAPSHOT_DIR, { recursive: true });
		}

		// Rotate old auto-snapshots. We only manage files we wrote ourselves
		// (auto-* prefix) — manual `dump-heap` snapshots use V8's default
		// "Heap.YYYYMMDD.*.heapsnapshot" naming and are left alone.
		const existing = readdirSync(SNAPSHOT_DIR)
			.filter((f) => f.startsWith("auto-") && f.endsWith(".heapsnapshot"))
			.map((f) => {
				const path = join(SNAPSHOT_DIR, f);
				return { path, mtime: statSync(path).mtimeMs };
			})
			.sort((a, b) => a.mtime - b.mtime);

		while (existing.length >= AUTO_SNAPSHOT_MAX_RETAINED) {
			const oldest = existing.shift();
			if (oldest) {
				try {
					unlinkSync(oldest.path);
				} catch (rotateErr) {
					log.warn({ err: rotateErr, path: oldest.path }, "Failed to rotate old heap snapshot");
				}
			}
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `auto-${timestamp}-${heapUsedMB}MB.heapsnapshot`;
		const filepath = join(SNAPSHOT_DIR, filename);

		log.warn(
			{ filepath, heapUsedMB, expectedFinalSizeMB: heapUsedMB * 3 },
			"Capturing heap snapshot (V8 may pause event loop ~2-5s)",
		);

		const captureStart = Date.now();
		await pipeline(getHeapSnapshot(), createWriteStream(filepath));
		const elapsedMs = Date.now() - captureStart;
		const sizeMB = Math.round(statSync(filepath).size / 1024 / 1024);

		lastSnapshotAt = Date.now();
		log.warn(
			{ filepath, sizeMB, elapsedMs },
			`Heap snapshot saved. Retrieve via: docker cp <container>:${filepath} ./`,
		);
		return true;
	} catch (err) {
		log.error(
			{ err, message: getErrorMessage(err), snapshotDir: SNAPSHOT_DIR },
			"Failed to capture heap snapshot — check that the directory is writable by the API user",
		);
		return false;
	} finally {
		snapshotInFlight = false;
	}
}

const heapMonitorPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let lastSample: MemorySample | null = null;

		const sample = (): void => {
			const m = process.memoryUsage();
			const heapUsedMB = Math.round(m.heapUsed / 1024 / 1024);
			const heapTotalMB = Math.round(m.heapTotal / 1024 / 1024);
			const rssMB = Math.round(m.rss / 1024 / 1024);
			const externalMB = Math.round(m.external / 1024 / 1024);
			const arrayBuffersMB = Math.round((m.arrayBuffers ?? 0) / 1024 / 1024);
			const now = Date.now();
			const uptimeSec = Math.round(process.uptime());
			// `heapPct` is heap-used relative to the V8-allocated heap, not the
			// `--max-old-space-size` cap. It still tracks pressure: V8 grows
			// heapTotal toward the cap, so heapPct climbing toward 1.0 means
			// V8 is squeezing the live set into all the space it has left.
			const heapPct = heapTotalMB > 0 ? heapUsedMB / heapTotalMB : 0;
			// `rssToHeapRatio` discriminates JS-side leaks (≈1.3–1.6x, normal)
			// from external/native memory pressure or glibc fragmentation (≥2x).
			// V8's heapPct can be healthy while RSS bloats past the container
			// cap — that's what bit reporters in #471.
			const rssToHeapRatio = heapTotalMB > 0 ? Math.round((rssMB / heapTotalMB) * 100) / 100 : 0;

			const payload: Record<string, number | undefined> = {
				heapUsedMB,
				heapTotalMB,
				rssMB,
				externalMB,
				arrayBuffersMB,
				heapPct: Math.round(heapPct * 100) / 100,
				rssToHeapRatio,
				uptimeSec,
			};

			if (lastSample) {
				payload.heapDeltaMB = heapUsedMB - lastSample.heapUsedMB;
				payload.rssDeltaMB = rssMB - lastSample.rssMB;
				payload.secondsSinceLast = Math.round((now - lastSample.timestamp) / 1000);
			}

			lastSample = {
				heapUsedMB,
				heapTotalMB,
				rssMB,
				externalMB,
				arrayBuffersMB,
				heapPct,
				timestamp: now,
			};

			if (heapPct >= WARN_HEAP_PCT) {
				app.log.warn(
					payload,
					AUTO_SNAPSHOT_AT_WARN
						? "Heap usage above 90% — auto-capturing snapshot to /config/heap-snapshots/ (set HEAP_AUTO_SNAPSHOT=0 or HEAP_AUTO_SNAPSHOT_AT_WARN=0 to disable)"
						: "Heap usage above 90% — capture a snapshot before OOM: `docker exec <container> dump-heap`",
				);
				if (AUTO_SNAPSHOT_AT_WARN) {
					// Fire-and-forget — captureHeapSnapshot is self-rate-limited and
					// self-rotating; we don't want sampling to block on the (potentially
					// multi-second) V8 walk and disk write.
					void captureHeapSnapshot(app.log, heapUsedMB);
				}
			} else if (heapPct >= INFO_HEAP_PCT) {
				app.log.info(payload, "Heap usage above 80%");
			} else {
				app.log.debug(payload, "Heap usage sample");
			}

			// RSS-bloat detection runs independently of heap pressure: the V8
			// heap can be healthy (heapPct < INFO_HEAP_PCT) while RSS climbs
			// past the container limit. Skip the warmup window so startup
			// spikes don't false-positive, and throttle to once-per-hour so
			// a sustained-bloat process doesn't spam logs.
			if (
				rssToHeapRatio >= RSS_BLOAT_RATIO &&
				uptimeSec >= RSS_BLOAT_MIN_UPTIME_SEC &&
				(rssBloatState.lastLogAt === null ||
					now - rssBloatState.lastLogAt >= RSS_BLOAT_LOG_INTERVAL_MS)
			) {
				app.log.warn(
					payload,
					"RSS is ≥2x V8 heap — likely external/native memory or glibc arena fragmentation. If RSS keeps climbing, try setting MALLOC_ARENA_MAX=2 (issue #471).",
				);
				rssBloatState.lastLogAt = now;
			}
		};

		app.addHook("onReady", async () => {
			// Log one sample at startup so we have a baseline anchor for deltas.
			sample();
			intervalHandle = setInterval(sample, SAMPLE_INTERVAL_MS);
			// Don't pin the event loop open during shutdown.
			intervalHandle.unref();
			app.log.info(
				{ intervalMs: SAMPLE_INTERVAL_MS },
				"Heap monitor started — periodic memoryUsage samples enabled",
			);
		});

		app.addHook("onClose", async () => {
			if (intervalHandle) {
				clearInterval(intervalHandle);
				intervalHandle = null;
			}
		});
	},
	{ name: "heap-monitor" },
);

export default heapMonitorPlugin;
