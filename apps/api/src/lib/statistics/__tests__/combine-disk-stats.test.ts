/**
 * Tests for combineDiskStats — the de-duplication that fixes GitHub issue #486
 * ("Storage available" reporting ~4x reality).
 *
 * Root cause: each *arr instance reports the free/total space of whatever it
 * can see. On a single-array setup (the common Unraid/Docker layout) every
 * instance reports the SAME physical disk, and summing per-instance totals
 * multiplies the figure by the instance count. combineDiskStats collapses
 * disks that share a storage group or an identical (totalSpace, freeSpace)
 * fingerprint so the disk is counted once.
 */

import { dashboardStatisticsResponseSchema } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	buildCombinedDiskPayload,
	combineDiskStats,
	type DiskBearingInstance,
	type DiskContributor,
	toDiskMounts,
} from "../statistics-utils.js";

const TB = 1024 ** 4;

// One physical 120 TB array with ~105 TB free, as four different services would
// each independently report it.
const sharedArray = () => [{ totalSpace: 120 * TB, freeSpace: 105 * TB }];

describe("combineDiskStats", () => {
	it("counts a shared array once across many instances (issue #486)", () => {
		const contributors: DiskContributor[] = [
			{ diskEntries: sharedArray() }, // sonarr
			{ diskEntries: sharedArray() }, // radarr
			{ diskEntries: sharedArray() }, // lidarr
			{ diskEntries: sharedArray() }, // readarr
		];

		const result = combineDiskStats(contributors);

		expect(result.total).toBe(120 * TB);
		expect(result.free).toBe(105 * TB);
		expect(result.used).toBe(15 * TB);
		expect(result.diskCount).toBe(1);
		// Every instance reported storage, even the de-duplicated ones — this
		// drives the "1 disk across 4 instances" transparency line.
		expect(result.instanceCount).toBe(4);
	});

	it("sums genuinely distinct disks", () => {
		const result = combineDiskStats([
			{ diskEntries: [{ totalSpace: 10 * TB, freeSpace: 4 * TB }] },
			{ diskEntries: [{ totalSpace: 8 * TB, freeSpace: 3 * TB }] },
		]);

		expect(result.total).toBe(18 * TB);
		expect(result.free).toBe(7 * TB);
		expect(result.diskCount).toBe(2);
		expect(result.instanceCount).toBe(2);
	});

	it("de-duplicates across mixed mount sets (array shared, extra disk distinct)", () => {
		const result = combineDiskStats([
			{
				diskEntries: [
					{ totalSpace: 120 * TB, freeSpace: 105 * TB }, // shared array
					{ totalSpace: 2 * TB, freeSpace: 1 * TB }, // sonarr-only SSD
				],
			},
			{ diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB }] }, // same array
		]);

		expect(result.total).toBe(122 * TB); // array once + SSD once
		expect(result.free).toBe(106 * TB);
		expect(result.diskCount).toBe(2);
	});

	it("honors storage groups: a represented group skips later members entirely", () => {
		// Same array, but reported free space drifts by a few bytes between reads
		// (active downloads). The fingerprint alone would NOT merge these, but the
		// explicit storage group does.
		const result = combineDiskStats([
			{ storageGroupId: "nas", diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB }] },
			{
				storageGroupId: "nas",
				diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB - 4096 }],
			},
		]);

		expect(result.total).toBe(120 * TB);
		expect(result.free).toBe(105 * TB);
		expect(result.diskCount).toBe(1);
		// Both instances report storage; the de-dup is by group, but instanceCount
		// must still be 2 so the operator who configured groups isn't shown a
		// smaller instance count than one who relied on the fingerprint.
		expect(result.instanceCount).toBe(2);
	});

	it("combines storage-group and fingerprint de-dup in a single call", () => {
		// Realistic mixed setup: two services grouped as "nas", one un-grouped
		// service reporting the SAME array (caught by fingerprint), and one
		// un-grouped service on a genuinely distinct disk.
		const result = combineDiskStats([
			{ storageGroupId: "nas", diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB }] },
			{ storageGroupId: "nas", diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB }] },
			{ diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB }] }, // same array, no group
			{ diskEntries: [{ totalSpace: 4 * TB, freeSpace: 1 * TB }] }, // distinct disk
		]);

		expect(result.total).toBe(124 * TB); // array once + distinct disk
		expect(result.free).toBe(106 * TB);
		expect(result.diskCount).toBe(2);
		expect(result.instanceCount).toBe(4);
	});

	it("merges two genuinely distinct disks with identical (total, free) — documented accepted under-count", () => {
		// Accepted limitation: byte-identical total AND free across two real disks
		// is realistic only for empty equal-size disks (free ≈ total), where the
		// user has abundant space and the under-count is harmless. This test pins
		// the intended behavior so a future "fix" that re-keys the fingerprint
		// can't silently re-open issue #486.
		const result = combineDiskStats([
			{ diskEntries: [{ totalSpace: 2 * TB, freeSpace: 2 * TB }] },
			{ diskEntries: [{ totalSpace: 2 * TB, freeSpace: 2 * TB }] },
		]);

		expect(result.total).toBe(2 * TB); // merged, NOT 4 TB
		expect(result.diskCount).toBe(1);
		expect(result.instanceCount).toBe(2);
	});

	it("ignores entries with non-positive total space", () => {
		const result = combineDiskStats([
			{ diskEntries: [{ totalSpace: 0, freeSpace: 0 }] },
			{ diskEntries: [{ totalSpace: undefined, freeSpace: undefined }] },
		]);

		expect(result.total).toBe(0);
		expect(result.diskCount).toBe(0);
		expect(result.instanceCount).toBe(0);
		expect(result.usagePercent).toBe(0);
	});

	it("returns zeros for no contributors", () => {
		const result = combineDiskStats([]);
		expect(result).toEqual({
			total: 0,
			free: 0,
			used: 0,
			usagePercent: 0,
			diskCount: 0,
			instanceCount: 0,
		});
	});

	// Regression guard: diskCount/instanceCount are optional schema additions.
	// Zod's .parse() strips keys absent from the schema, so a forgotten field
	// here would silently drop from the API response despite green types/units.
	it("diskCount and instanceCount survive the response schema's parse()", () => {
		const combined = combineDiskStats([
			{ diskEntries: sharedArray() },
			{ diskEntries: sharedArray() },
		]);
		const payload = {
			sonarr: { instances: [], aggregate: undefined },
			radarr: { instances: [], aggregate: undefined },
			prowlarr: { instances: [], aggregate: undefined },
			lidarr: { instances: [], aggregate: undefined },
			readarr: { instances: [], aggregate: undefined },
			combinedDisk: {
				diskTotal: combined.total,
				diskFree: combined.free,
				diskUsed: combined.used,
				diskUsagePercent: combined.usagePercent,
				diskCount: combined.diskCount,
				instanceCount: combined.instanceCount,
			},
		};

		const parsed = dashboardStatisticsResponseSchema.parse(payload);

		expect(parsed.combinedDisk?.diskTotal).toBe(120 * TB); // not the 240 TB naive sum
		expect(parsed.combinedDisk?.diskCount).toBe(1);
		expect(parsed.combinedDisk?.instanceCount).toBe(2);
	});
});

describe("toDiskMounts", () => {
	// Pins the exact shape combineDiskStats depends on: path is dropped, and
	// missing total/free coerce to 0. If the `?? 0` coercion ever regressed to
	// `undefined`, the fingerprint key would become "120…:undefined" and shared
	// disks would silently stop merging (re-opening issue #486) with green types.
	it("drops path and coerces missing total/free to 0", () => {
		const mounts = toDiskMounts([
			{ path: "/tv", totalSpace: 120 * 1024 ** 4, freeSpace: 105 * 1024 ** 4 },
			{ path: "/data" }, // missing total/free
			{ totalSpace: 2 * 1024 ** 4, freeSpace: undefined },
		] as Array<{ path?: string; totalSpace?: number; freeSpace?: number }>);

		expect(mounts).toEqual([
			{ totalSpace: 120 * 1024 ** 4, freeSpace: 105 * 1024 ** 4 },
			{ totalSpace: 0, freeSpace: 0 },
			{ totalSpace: 2 * 1024 ** 4, freeSpace: 0 },
		]);
		// No `path` key survives.
		expect(mounts.every((m) => !("path" in m))).toBe(true);
	});
});

describe("buildCombinedDiskPayload", () => {
	// Helper: a minimal disk-bearing instance carrying just the shape the
	// combinedDisk computation reads. The real route's instance arrays carry
	// many more fields (instanceId, shouldCountDisk, etc.); structural typing
	// lets us narrow here.
	const instanceWithArray = (): DiskBearingInstance => ({
		data: { diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB }] },
	});

	it("collapses one array reported by all four services into a single disk", () => {
		const payload = buildCombinedDiskPayload({
			sonarr: [instanceWithArray()],
			radarr: [instanceWithArray()],
			lidarr: [instanceWithArray()],
			readarr: [instanceWithArray()],
		});

		expect(payload).toEqual({
			diskTotal: 120 * TB,
			diskFree: 105 * TB,
			diskUsed: 15 * TB,
			diskUsagePercent: expect.any(Number),
			diskCount: 1,
			instanceCount: 4,
		});
	});

	it("returns undefined when no instance reports any storage", () => {
		expect(
			buildCombinedDiskPayload({ sonarr: [], radarr: [], lidarr: [], readarr: [] }),
		).toBeUndefined();
	});

	it("returns undefined when instances exist but diskEntries is missing", () => {
		// Legacy / partial response shape: an instance with no `diskEntries`
		// at all (e.g. an older fetch path or a failed fetch fallback object)
		// must NOT contribute a phantom 0-byte disk; the helper should return
		// undefined so the UI omits the combinedDisk card rather than rendering
		// "of 0 B available".
		expect(
			buildCombinedDiskPayload({
				sonarr: [{ data: {} }],
				radarr: [{ data: {} }],
				lidarr: [],
				readarr: [],
			}),
		).toBeUndefined();
	});

	it("respects storage groups across services (e.g. sonarr+radarr grouped on the same array)", () => {
		const payload = buildCombinedDiskPayload({
			sonarr: [
				{
					storageGroupId: "nas",
					data: { diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB }] },
				},
			],
			radarr: [
				{
					storageGroupId: "nas",
					data: { diskEntries: [{ totalSpace: 120 * TB, freeSpace: 105 * TB - 4096 }] },
				},
			],
			lidarr: [],
			readarr: [],
		});

		expect(payload?.diskTotal).toBe(120 * TB); // sonarr's reading; radarr's skew dropped
		expect(payload?.diskCount).toBe(1);
		expect(payload?.instanceCount).toBe(2);
	});

	// Compile-time guard documented as a test: the helper's parameter type
	// (DiskBearingServiceInstances) has exactly four keys — sonarr, radarr,
	// lidarr, readarr. Prowlarr is not a key, so a future contributor cannot
	// accidentally feed Prowlarr instances into the combined disk total
	// without a deliberate type change. This `@ts-expect-error` fails the
	// build if Prowlarr is ever added to the input type.
	it("structurally excludes Prowlarr from disk contributors", () => {
		buildCombinedDiskPayload({
			sonarr: [],
			radarr: [],
			lidarr: [],
			readarr: [],
			// @ts-expect-error — Prowlarr is intentionally not a valid input key
			prowlarr: [{ data: { diskEntries: [{ totalSpace: 1, freeSpace: 1 }] } }],
		});
	});
});
