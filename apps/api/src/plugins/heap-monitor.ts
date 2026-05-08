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
 * Companion runtime knobs:
 *   - `--heapsnapshot-signal=SIGUSR2`  Always on (set in Dockerfile
 *     NODE_OPTIONS). An operator who sees heap climbing in these logs can
 *     capture a snapshot on demand:
 *       docker exec <container> sh -c 'kill -USR2 $(pgrep -f "node /app/api/dist/index.js")'
 *     Snapshots land on /config/heap-snapshots/.
 *
 *   - `HEAP_AUTO_SNAPSHOT=1` env var  OPT-IN. When set, start-combined.sh
 *     appends --heapsnapshot-near-heap-limit=1 so V8 auto-captures a
 *     snapshot just before OOM. Off by default because each snapshot is ~3x
 *     the heap (~2.3 GB at the 768 MB cap) — a lot for small /config volumes.
 *     Set it in your compose / Unraid template alongside the other env vars.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — enough resolution to spot leaks, light on log volume.
const WARN_HEAP_PCT = 0.9;
const INFO_HEAP_PCT = 0.8;

interface MemorySample {
	heapUsedMB: number;
	heapTotalMB: number;
	rssMB: number;
	externalMB: number;
	arrayBuffersMB: number;
	heapPct: number;
	timestamp: number;
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
			// `heapPct` is heap-used relative to the V8-allocated heap, not the
			// `--max-old-space-size` cap. It still tracks pressure: V8 grows
			// heapTotal toward the cap, so heapPct climbing toward 1.0 means
			// V8 is squeezing the live set into all the space it has left.
			const heapPct = heapTotalMB > 0 ? heapUsedMB / heapTotalMB : 0;

			const payload: Record<string, number | undefined> = {
				heapUsedMB,
				heapTotalMB,
				rssMB,
				externalMB,
				arrayBuffersMB,
				heapPct: Math.round(heapPct * 100) / 100,
				uptimeSec: Math.round(process.uptime()),
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
					"Heap usage above 90% — capture a snapshot before OOM: docker exec <container> sh -c 'kill -USR2 $(pgrep -f \"node /app/api/dist/index.js\")'",
				);
			} else if (heapPct >= INFO_HEAP_PCT) {
				app.log.info(payload, "Heap usage above 80%");
			} else {
				app.log.debug(payload, "Heap usage sample");
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
