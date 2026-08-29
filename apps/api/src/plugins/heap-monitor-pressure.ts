import { readFileSync } from "node:fs";

export const MEMORY_WARN_PCT = 0.9;
export const MEMORY_INFO_PCT = 0.8;

const CGROUP_MEMORY_PATHS = [
	{
		generation: "v2",
		usagePath: "/sys/fs/cgroup/memory.current",
		limitPath: "/sys/fs/cgroup/memory.max",
	},
	{
		generation: "v1",
		usagePath: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
		limitPath: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
	},
] as const;

const CGROUP_MEMORY_LIMIT_PATHS = CGROUP_MEMORY_PATHS.map(({ limitPath }) => limitPath);

type ReadTextFile = (path: string) => string;

export interface MemoryPressureInput {
	heapUsedBytes: number;
	heapTotalBytes: number;
	rssBytes: number;
	heapSizeLimitBytes?: number;
	cgroupUsageBytes?: number;
	cgroupLimitBytes?: number;
}

export interface CgroupMemoryStats {
	generation: "v1" | "v2";
	usageBytes: number;
	limitBytes: number;
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
	const cgroupUsageBytes =
		input.cgroupUsageBytes === undefined ? input.rssBytes : input.cgroupUsageBytes;
	const cgroupLimitPct = ratio(cgroupUsageBytes, input.cgroupLimitBytes);

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
		// A V8 heap snapshot diagnoses live JavaScript objects, not native/RSS
		// pressure. Fall back to committed occupancy only if V8 exposes no
		// usable heap limit; cgroup-only pressure remains warning-only.
		shouldSnapshot:
			heapLimitPct !== undefined
				? heapLimitPct >= MEMORY_WARN_PCT
				: cgroupLimitPct === undefined && committedHeapPct >= MEMORY_WARN_PCT,
	};
}

/** Parse cgroup v1/v2 memory limits while rejecting unlimited sentinels. */
export function parseCgroupMemoryLimitBytes(rawValue: string): number | undefined {
	return parseCgroupBytes(rawValue, false);
}

/** Parse cgroup usage bytes, where zero is a valid observed usage. */
export function parseCgroupMemoryUsageBytes(rawValue: string): number | undefined {
	return parseCgroupBytes(rawValue, true);
}

function parseCgroupBytes(rawValue: string, allowZero: boolean): number | undefined {
	const value = rawValue.trim();
	if (value.length === 0 || value === "max") return undefined;

	try {
		const parsed = BigInt(value);
		if ((allowZero ? parsed < 0n : parsed <= 0n) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
			return undefined;
		}
		return Number(parsed);
	} catch {
		return undefined;
	}
}

/** Read usage and limit from one cgroup generation without mixing v1/v2 data. */
export function readCgroupMemoryStats(
	readTextFile: ReadTextFile = (path) => readFileSync(path, "utf8"),
): CgroupMemoryStats | undefined {
	for (const { generation, usagePath, limitPath } of CGROUP_MEMORY_PATHS) {
		try {
			const limitBytes = parseCgroupMemoryLimitBytes(readTextFile(limitPath));
			if (limitBytes === undefined) continue;
			const usageBytes = parseCgroupMemoryUsageBytes(readTextFile(usagePath));
			if (usageBytes === undefined) continue;
			return { generation, usageBytes, limitBytes };
		} catch {
			// Missing or malformed controller files are normal outside containers.
			// Try the next complete cgroup generation.
		}
	}
	return undefined;
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
