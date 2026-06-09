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
	filterToRootFolderDisks,
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
			disks: [],
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
	// Pins the shape combineDiskStats depends on: missing total/free coerce to
	// 0 (so the fingerprint key stays "n:n" instead of "n:undefined" — which
	// would silently break the dedup that fixes issue #486), and `path` is
	// PRESERVED on the wire so the #495 root-folder filter can use it. Before
	// #495 the path was dropped here for privacy reasons; the breakdown UI now
	// needs it, and the frontend handles anonymization under incognito mode.
	it("preserves path and coerces missing total/free to 0", () => {
		const mounts = toDiskMounts([
			{ path: "/tv", totalSpace: 120 * 1024 ** 4, freeSpace: 105 * 1024 ** 4 },
			{ path: "/data" }, // missing total/free
			{ totalSpace: 2 * 1024 ** 4, freeSpace: undefined },
		] as Array<{ path?: string; totalSpace?: number; freeSpace?: number }>);

		expect(mounts).toEqual([
			{ path: "/tv", totalSpace: 120 * 1024 ** 4, freeSpace: 105 * 1024 ** 4 },
			{ path: "/data", totalSpace: 0, freeSpace: 0 },
			{ path: undefined, totalSpace: 2 * 1024 ** 4, freeSpace: 0 },
		]);
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

		// Use toMatchObject so the breakdown payload added in #495 doesn't tighten
		// this test's contract: the rollup numbers are what we care about here.
		expect(payload).toMatchObject({
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

// ===========================================================================
// Root-folder filter (#495)
// ===========================================================================

describe("filterToRootFolderDisks (#495)", () => {
	it("falls back to keeping everything when no root folders are supplied", () => {
		// Pre-#495 callers don't pass rootFolderPaths. We must not regress them
		// to showing 0 disks — preserve current behavior as the safety net.
		const entries = [
			{ path: "/", totalSpace: 1.5 * TB, freeSpace: 553.9 * 1024 ** 3 },
			{ path: "/data", totalSpace: 131 * TB, freeSpace: 37.6 * TB },
		];

		expect(filterToRootFolderDisks(entries, undefined).included).toEqual(entries);
		expect(filterToRootFolderDisks(entries, []).included).toEqual(entries);
		expect(filterToRootFolderDisks(entries, ["   "]).included).toEqual(entries);
	});

	it("keeps only the disk holding the *arr root folder (longest prefix wins)", () => {
		// The developer's personal Sonarr setup from issue #495 — three disks
		// reported, one media root folder configured on /data.
		const entries = [
			{ path: "/", totalSpace: 1.5 * TB, freeSpace: 553.9 * 1024 ** 3 },
			{ path: "/data", totalSpace: 131 * TB, freeSpace: 37.6 * TB },
			{ path: "/config", totalSpace: 585.5 * 1024 ** 3, freeSpace: 553.9 * 1024 ** 3 },
		];

		const { included, excluded } = filterToRootFolderDisks(entries, ["/data/tv"]);

		expect(included.map((e) => e.path)).toEqual(["/data"]);
		expect(excluded.map((e) => e.path)).toEqual(["/", "/config"]);
	});

	it("keeps the root partition on bare-metal setups with no other disk", () => {
		// Bare-metal *arr where media lives somewhere under /, with no separate
		// mount. The only candidate disk is /, and the root folder's path starts
		// with / — so / wins.
		const entries = [{ path: "/", totalSpace: 4 * TB, freeSpace: 1 * TB }];

		const { included } = filterToRootFolderDisks(entries, ["/home/user/Media"]);

		expect(included).toEqual(entries);
	});

	it("respects path-segment boundaries (/data does not match /dataother)", () => {
		// String-prefix is not enough — /data should NOT be considered the mount
		// holding a root folder at /dataother/movies. The match needs the next
		// character after the disk path to be / or end-of-string.
		const entries = [
			{ path: "/data", totalSpace: 10 * TB, freeSpace: 5 * TB },
			{ path: "/dataother", totalSpace: 4 * TB, freeSpace: 1 * TB },
		];

		const { included } = filterToRootFolderDisks(entries, ["/dataother/movies"]);

		expect(included.map((e) => e.path)).toEqual(["/dataother"]);
	});

	it("normalizes trailing slashes on both disk paths and root folder paths", () => {
		const entries = [{ path: "/data/", totalSpace: 10 * TB, freeSpace: 5 * TB }];

		const { included } = filterToRootFolderDisks(entries, ["/data/tv/"]);

		expect(included).toHaveLength(1);
	});

	it("keeps each unique disk only once even when many root folders share it", () => {
		// Two root folders, both on the same /data disk. Disk should be kept
		// once, not twice.
		const entries = [
			{ path: "/", totalSpace: 1.5 * TB, freeSpace: 553.9 * 1024 ** 3 },
			{ path: "/data", totalSpace: 131 * TB, freeSpace: 37.6 * TB },
		];

		const { included } = filterToRootFolderDisks(entries, ["/data/tv", "/data/movies"]);

		expect(included.map((e) => e.path)).toEqual(["/data"]);
	});

	it("excludes everything when no disk's path is a prefix of any root folder", () => {
		// All root folders live on disks the *arr never enumerated (perhaps the
		// root folders point at unmounted paths). Filter excludes everything;
		// caller's safety net should handle that case at the layer above.
		const entries = [
			{ path: "/", totalSpace: 1.5 * TB, freeSpace: 100 * 1024 ** 3 },
			{ path: "/tmp", totalSpace: 10 * 1024 ** 3, freeSpace: 8 * 1024 ** 3 },
		];

		const { included, excluded } = filterToRootFolderDisks(entries, ["/data/tv"]);

		// "/data/tv" starts with "/" — so the / disk matches as the longest
		// prefix and is kept. /tmp does not match.
		expect(included.map((e) => e.path)).toEqual(["/"]);
		expect(excluded.map((e) => e.path)).toEqual(["/tmp"]);
	});
});

describe("combineDiskStats with root-folder filter (#495)", () => {
	const KIB = 1024;
	const GIB = KIB ** 3;
	const TIB = KIB ** 4;

	it("produces the right rollup + breakdown for the issue-#495 reporter's case", () => {
		// Models the developer's own Sonarr disk reading reproduced in #495:
		// three disks shown by the *arr, only /data is media.
		const result = combineDiskStats([
			{
				instanceName: "Sonarr",
				rootFolderPaths: ["/data/tv"],
				diskEntries: [
					{ path: "/", totalSpace: 1.5 * TIB, freeSpace: 553.9 * GIB },
					{ path: "/data", totalSpace: 131 * TIB, freeSpace: 37.6 * TIB },
					{ path: "/config", totalSpace: 585.5 * GIB, freeSpace: 553.9 * GIB },
				],
			},
		]);

		// Rollup: only /data is counted.
		expect(result.total).toBe(131 * TIB);
		expect(result.free).toBe(37.6 * TIB);
		expect(result.diskCount).toBe(1);
		expect(result.instanceCount).toBe(1);

		// Breakdown: every disk is listed with its decision so the UI can show
		// the "Show all disks" expansion.
		expect(result.disks).toHaveLength(3);

		const byPath = Object.fromEntries(result.disks.map((d) => [d.path, d]));
		expect(byPath["/data"]).toMatchObject({ includedInRollup: true, reason: "media" });
		expect(byPath["/"]).toMatchObject({
			includedInRollup: false,
			reason: "no-matching-root-folder",
		});
		expect(byPath["/config"]).toMatchObject({
			includedInRollup: false,
			reason: "no-matching-root-folder",
		});
		// All three carry the instance label for UI attribution.
		expect(result.disks.every((d) => d.instanceName === "Sonarr")).toBe(true);
	});

	it("marks group-deduplicated disks with reason 'deduplicated' in the breakdown", () => {
		// Two instances declared in the same storage group. The first contributes
		// to the rollup; the second's disks are recorded as duplicates so the UI
		// can show "Radarr's /data ⊘ already counted via Sonarr".
		const result = combineDiskStats([
			{
				instanceName: "Sonarr",
				storageGroupId: "nas",
				rootFolderPaths: ["/data/tv"],
				diskEntries: [{ path: "/data", totalSpace: 131 * TIB, freeSpace: 37.6 * TIB }],
			},
			{
				instanceName: "Radarr",
				storageGroupId: "nas",
				rootFolderPaths: ["/data/movies"],
				diskEntries: [{ path: "/data", totalSpace: 131 * TIB, freeSpace: 37.6 * TIB }],
			},
		]);

		expect(result.diskCount).toBe(1);
		expect(result.instanceCount).toBe(2);
		expect(result.disks).toHaveLength(2);
		expect(result.disks[0]).toMatchObject({
			instanceName: "Sonarr",
			includedInRollup: true,
			reason: "media",
		});
		expect(result.disks[1]).toMatchObject({
			instanceName: "Radarr",
			includedInRollup: false,
			reason: "deduplicated",
		});
	});

	it("marks fingerprint-deduplicated media disks as 'deduplicated' in the breakdown", () => {
		// Two ungrouped *arrs both reporting an identically-sized identically-free
		// media disk. PR #490's fingerprint dedup catches them; the breakdown
		// records the second one as deduplicated rather than dropping it silently.
		const result = combineDiskStats([
			{
				instanceName: "Sonarr",
				rootFolderPaths: ["/data/tv"],
				diskEntries: [{ path: "/data", totalSpace: 131 * TIB, freeSpace: 37.6 * TIB }],
			},
			{
				instanceName: "Radarr",
				rootFolderPaths: ["/data/movies"],
				diskEntries: [{ path: "/data", totalSpace: 131 * TIB, freeSpace: 37.6 * TIB }],
			},
		]);

		expect(result.diskCount).toBe(1);
		expect(result.disks.map((d) => d.reason)).toEqual(["media", "deduplicated"]);
	});

	it("falls back to current behavior for contributors that don't supply root folders", () => {
		// Pre-#495 callers (or contributors whose root-folder fetch failed) don't
		// pass rootFolderPaths. Those contributors keep all their disks as "media"
		// — preserving the rollup users see today rather than dropping to 0 TB.
		const result = combineDiskStats([
			{
				instanceName: "Sonarr (legacy)",
				// rootFolderPaths intentionally absent
				diskEntries: [
					{ path: "/", totalSpace: 1.5 * TIB, freeSpace: 553.9 * GIB },
					{ path: "/data", totalSpace: 131 * TIB, freeSpace: 37.6 * TIB },
				],
			},
		]);

		expect(result.diskCount).toBe(2);
		expect(result.total).toBe(1.5 * TIB + 131 * TIB);
		expect(result.disks.every((d) => d.reason === "media")).toBe(true);
	});
});
