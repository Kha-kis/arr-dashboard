import { describe, expect, it, vi } from "vitest";
import {
	classifyMemoryPressure,
	parseCgroupMemoryLimitBytes,
	readCgroupMemoryLimitBytes,
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
		expect(pressure.shouldSnapshot).toBe(true);
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
