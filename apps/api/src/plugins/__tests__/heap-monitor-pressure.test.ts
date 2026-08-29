import { describe, expect, it, vi } from "vitest";
import {
	classifyMemoryPressure,
	parseCgroupMemoryLimitBytes,
	parseCgroupMemoryUsageBytes,
	readCgroupMemoryLimitBytes,
	readCgroupMemoryStats,
} from "../heap-monitor-pressure.js";

const MIB = 1024 * 1024;

describe("classifyMemoryPressure", () => {
	it("does not treat a nearly full committed heap as near-OOM when runtime headroom is large", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 200 * MIB,
			heapTotalBytes: 210 * MIB,
			rssBytes: 350 * MIB,
			heapSizeLimitBytes: 2048 * MIB,
			cgroupLimitBytes: 3072 * MIB,
		});

		expect(pressure.committedHeapPct).toBeCloseTo(0.95, 2);
		expect(pressure.heapLimitPct).toBeCloseTo(0.1, 2);
		expect(pressure.cgroupLimitPct).toBeCloseTo(0.11, 2);
		expect(pressure.runtimePct).toBeCloseTo(0.11, 2);
		expect(pressure.level).toBe("debug");
		expect(pressure.shouldSnapshot).toBe(false);
	});

	it("warns and snapshots when the live heap approaches the V8 heap limit", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 1900 * MIB,
			heapTotalBytes: 1950 * MIB,
			rssBytes: 2020 * MIB,
			heapSizeLimitBytes: 2048 * MIB,
		});

		expect(pressure.runtimePct).toBeCloseTo(0.93, 2);
		expect(pressure.pressureSource).toBe("v8_heap_limit");
		expect(pressure.level).toBe("warn");
		expect(pressure.shouldSnapshot).toBe(true);
	});

	it("uses RSS against a constrained cgroup limit as an independent near-OOM signal", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 200 * MIB,
			heapTotalBytes: 210 * MIB,
			rssBytes: 950 * MIB,
			heapSizeLimitBytes: 2048 * MIB,
			cgroupLimitBytes: 1024 * MIB,
		});

		expect(pressure.heapLimitPct).toBeCloseTo(0.1, 2);
		expect(pressure.cgroupLimitPct).toBeCloseTo(0.93, 2);
		expect(pressure.pressureSource).toBe("cgroup_memory_limit");
		expect(pressure.level).toBe("warn");
		expect(pressure.shouldSnapshot).toBe(false);
	});

	it("uses aggregate cgroup usage instead of API RSS for container pressure", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 200 * MIB,
			heapTotalBytes: 210 * MIB,
			rssBytes: 200 * MIB,
			cgroupUsageBytes: 950 * MIB,
			cgroupLimitBytes: 1024 * MIB,
		});

		expect(pressure.cgroupLimitPct).toBeCloseTo(0.93, 2);
		expect(pressure.pressureSource).toBe("cgroup_memory_limit");
		expect(pressure.level).toBe("warn");
		expect(pressure.shouldSnapshot).toBe(false);
	});

	it("does not snapshot from committed occupancy when only a finite cgroup limit is authoritative", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 200 * MIB,
			heapTotalBytes: 210 * MIB,
			rssBytes: 950 * MIB,
			cgroupLimitBytes: 1024 * MIB,
		});

		expect(pressure.heapLimitPct).toBeUndefined();
		expect(pressure.cgroupLimitPct).toBeCloseTo(0.93, 2);
		expect(pressure.level).toBe("warn");
		expect(pressure.shouldSnapshot).toBe(false);
	});

	it("keeps cgroup-only low pressure from triggering a committed-heap snapshot", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 200 * MIB,
			heapTotalBytes: 210 * MIB,
			rssBytes: 350 * MIB,
			cgroupLimitBytes: 2048 * MIB,
		});

		expect(pressure.level).toBe("debug");
		expect(pressure.shouldSnapshot).toBe(false);
	});

	it("continues to warn against the V8 limit when cgroup data is unavailable", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 1900 * MIB,
			heapTotalBytes: 1950 * MIB,
			rssBytes: 2000 * MIB,
			heapSizeLimitBytes: 2048 * MIB,
			cgroupLimitBytes: undefined,
		});

		expect(pressure.cgroupLimitPct).toBeUndefined();
		expect(pressure.level).toBe("warn");
	});

	it("falls back conservatively when no authoritative runtime limit is available", () => {
		const pressure = classifyMemoryPressure({
			heapUsedBytes: 95 * MIB,
			heapTotalBytes: 100 * MIB,
			rssBytes: 140 * MIB,
			heapSizeLimitBytes: undefined,
			cgroupLimitBytes: undefined,
		});

		expect(pressure.pressureSource).toBe("committed_heap_fallback");
		expect(pressure.level).toBe("warn");
		expect(pressure.shouldSnapshot).toBe(true);
	});
});

describe("cgroup memory limits", () => {
	it.each(["", "max", "invalid", "-1", "0", "9223372036854771712"])(
		"treats %j as unknown",
		(value) => {
			expect(parseCgroupMemoryLimitBytes(value)).toBeUndefined();
		},
	);

	it("parses a finite byte limit", () => {
		expect(parseCgroupMemoryLimitBytes("1073741824\n")).toBe(1024 * MIB);
	});

	it("parses zero cgroup usage as a valid observation", () => {
		expect(parseCgroupMemoryUsageBytes("0\n")).toBe(0);
	});

	it.each(["", "max", "unlimited", "invalid", "-1", "9223372036854771712"])(
		"treats %j cgroup usage as unknown",
		(value) => {
			expect(parseCgroupMemoryUsageBytes(value)).toBeUndefined();
		},
	);

	it("reads usage and limit from the same cgroup generation", () => {
		const readFile = vi.fn((path: string) => {
			if (path === "/sys/fs/cgroup/memory.max") return String(1024 * MIB);
			if (path === "/sys/fs/cgroup/memory.current") return String(950 * MIB);
			throw new Error("unexpected path");
		});

		expect(readCgroupMemoryStats(readFile)).toEqual({
			generation: "v2",
			usageBytes: 950 * MIB,
			limitBytes: 1024 * MIB,
		});
	});

	it("does not combine a v2 limit with a v1 usage value", () => {
		const readFile = vi.fn((path: string) => {
			if (path === "/sys/fs/cgroup/memory.max") return String(1024 * MIB);
			if (path === "/sys/fs/cgroup/memory.current") throw new Error("missing v2 usage");
			if (path === "/sys/fs/cgroup/memory/memory.limit_in_bytes") return String(512 * MIB);
			if (path === "/sys/fs/cgroup/memory/memory.usage_in_bytes") return String(100 * MIB);
			throw new Error("unexpected path");
		});

		expect(readCgroupMemoryStats(readFile)).toEqual({
			generation: "v1",
			usageBytes: 100 * MIB,
			limitBytes: 512 * MIB,
		});
	});

	it("falls back from an unavailable v2 limit to a finite v1 limit", () => {
		const readFile = vi.fn((path: string) => {
			if (path === "/sys/fs/cgroup/memory.max") return "max";
			if (path === "/sys/fs/cgroup/memory/memory.limit_in_bytes") {
				return String(512 * MIB);
			}
			throw new Error("unexpected path");
		});

		expect(readCgroupMemoryLimitBytes(readFile)).toBe(512 * MIB);
		expect(readFile).toHaveBeenCalledTimes(2);
	});

	it("returns unknown when cgroup files cannot be read", () => {
		const readFile = vi.fn(() => {
			throw new Error("ENOENT");
		});

		expect(readCgroupMemoryLimitBytes(readFile)).toBeUndefined();
	});
});
