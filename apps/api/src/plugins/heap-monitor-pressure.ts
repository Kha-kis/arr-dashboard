import { readFileSync } from "node:fs";

export const MEMORY_WARN_PCT = 0.9;
export const MEMORY_INFO_PCT = 0.8;

const CGROUP_MEMORY_LIMIT_PATHS = [
	"/sys/fs/cgroup/memory.max",
	"/sys/fs/cgroup/memory/memory.limit_in_bytes",
] as const;

type ReadTextFile = (path: string) => string;

export interface MemoryPressureInput {
	heapUsedBytes: number;
	heapTotalBytes: number;
	rssBytes: number;
	heapSizeLimitBytes?: number;
	cgroupLimitBytes?: number;
}

export type MemoryPressureSource =
	| "v8_heap_limit"
	| "cgroup_memory_limit"
	| "committed_heap_fallback";

export interface MemoryPressureClassification {
	committedHeapPct: number;
	heapLimitPct?: number;
	cgroupLimitPct?: number;
	runtimePct: number;
	pressureSource: MemoryPressureSource;
	level: "debug" | "info" | "warn";
	shouldSnapshot: boolean;
}

function ratio(usedBytes: number, limitBytes: number | undefined): number | undefined {
	if (
		limitBytes === undefined ||
		!Number.isFinite(limitBytes) ||
		limitBytes <= 0 ||
		!Number.isFinite(usedBytes) ||
		usedBytes < 0
	) {
		return undefined;
	}
	return usedBytes / limitBytes;
}

/**
 * Classify process memory pressure against limits that represent real runtime
 * headroom. Committed heap occupancy is retained as telemetry and becomes a
 * conservative fallback only when neither V8 nor cgroup exposes a usable
 * limit.
 */
export function classifyMemoryPressure(input: MemoryPressureInput): MemoryPressureClassification {
	const committedHeapPct = ratio(input.heapUsedBytes, input.heapTotalBytes) ?? 0;
	const heapLimitPct = ratio(input.heapUsedBytes, input.heapSizeLimitBytes);
	const cgroupLimitPct = ratio(input.rssBytes, input.cgroupLimitBytes);

	let runtimePct: number;
	let pressureSource: MemoryPressureSource;
	if (heapLimitPct !== undefined || cgroupLimitPct !== undefined) {
		runtimePct = heapLimitPct ?? cgroupLimitPct ?? 0;
		pressureSource = heapLimitPct !== undefined ? "v8_heap_limit" : "cgroup_memory_limit";
		if (cgroupLimitPct !== undefined && cgroupLimitPct > runtimePct) {
			runtimePct = cgroupLimitPct;
			pressureSource = "cgroup_memory_limit";
		}
	} else {
		runtimePct = committedHeapPct;
		pressureSource = "committed_heap_fallback";
	}

	const level =
		runtimePct >= MEMORY_WARN_PCT ? "warn" : runtimePct >= MEMORY_INFO_PCT ? "info" : "debug";

	return {
		committedHeapPct,
		heapLimitPct,
		cgroupLimitPct,
		runtimePct,
		pressureSource,
		level,
		shouldSnapshot: level === "warn",
	};
}

/** Parse cgroup v1/v2 memory limits while rejecting unlimited sentinels. */
export function parseCgroupMemoryLimitBytes(rawValue: string): number | undefined {
	const value = rawValue.trim();
	if (value.length === 0 || value === "max") return undefined;

	try {
		const parsed = BigInt(value);
		if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
		return Number(parsed);
	} catch {
		return undefined;
	}
}

/** Read the first finite cgroup v2 or v1 process-memory limit. */
export function readCgroupMemoryLimitBytes(
	readTextFile: ReadTextFile = (path) => readFileSync(path, "utf8"),
): number | undefined {
	for (const path of CGROUP_MEMORY_LIMIT_PATHS) {
		try {
			const limit = parseCgroupMemoryLimitBytes(readTextFile(path));
			if (limit !== undefined) return limit;
		} catch {
			// Missing controller files are normal outside containers and on the
			// other cgroup generation. Try the next known path.
		}
	}
	return undefined;
}
