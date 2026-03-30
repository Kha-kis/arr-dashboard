/**
 * Stats Aggregation Tests
 *
 * Validates that Tautulli home stats survive the full pipeline:
 * raw upstream JSON → Zod schema parse → route aggregation logic.
 *
 * Regression test for #233: get_home_stats rows without total_duration/total_plays
 * caused validation failure, which surfaced as "degraded" in the UI.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tautulliHomeStatSchema } from "../../../lib/tautulli/tautulli-schemas.js";

/**
 * Simulate the aggregation logic from stats-routes.ts lines 69-92.
 * Extracted here so we can test it in isolation against real parsed data.
 */
function aggregateHomeStats(
	homeStats: z.infer<typeof tautulliHomeStatSchema>[],
): Map<string, { statTitle: string; rows: Map<string, { title: string; totalPlays: number; totalDuration: number; platform?: string }> }> {
	const homeStatsMap = new Map<
		string,
		{ statTitle: string; rows: Map<string, { title: string; totalPlays: number; totalDuration: number; platform?: string }> }
	>();

	for (const stat of homeStats) {
		let existing = homeStatsMap.get(stat.stat_id);
		if (!existing) {
			existing = { statTitle: stat.stat_title, rows: new Map() };
			homeStatsMap.set(stat.stat_id, existing);
		}
		for (const r of stat.rows) {
			const rowKey = r.title;
			const prev = existing.rows.get(rowKey);
			if (prev) {
				prev.totalPlays += r.total_plays;
				prev.totalDuration += r.total_duration;
			} else {
				existing.rows.set(rowKey, {
					title: r.title,
					totalPlays: r.total_plays,
					totalDuration: r.total_duration,
					platform: r.platform,
				});
			}
		}
	}

	return homeStatsMap;
}

describe("Tautulli stats aggregation (#233)", () => {
	it("aggregates home stats with all fields present", () => {
		const raw = [
			{
				stat_id: "top_movies",
				stat_title: "Most Watched Movies",
				rows: [
					{ title: "Dune: Part Two", total_plays: 5, total_duration: 36000, thumb: "/thumb" },
					{ title: "Interstellar", total_plays: 3, total_duration: 24000 },
				],
			},
		];

		const parsed = z.array(tautulliHomeStatSchema).parse(raw);
		const result = aggregateHomeStats(parsed);

		const topMovies = result.get("top_movies")!;
		expect(topMovies.rows.get("Dune: Part Two")!.totalPlays).toBe(5);
		expect(topMovies.rows.get("Dune: Part Two")!.totalDuration).toBe(36000);
		expect(topMovies.rows.get("Interstellar")!.totalPlays).toBe(3);
	});

	it("handles rows missing total_plays and total_duration (defaults to 0)", () => {
		// This is the exact payload shape that caused #233
		const raw = [
			{
				stat_id: "top_platforms",
				stat_title: "Top Platforms",
				rows: [
					{ title: "Chrome", platform: "Chrome" },
					{ title: "Roku", platform: "Roku" },
				],
			},
		];

		const parsed = z.array(tautulliHomeStatSchema).parse(raw);
		const result = aggregateHomeStats(parsed);

		const topPlatforms = result.get("top_platforms")!;
		const chrome = topPlatforms.rows.get("Chrome")!;
		expect(chrome.totalPlays).toBe(0);
		expect(chrome.totalDuration).toBe(0);
		expect(chrome.platform).toBe("Chrome");

		// Ensure no NaN from arithmetic on defaulted values
		expect(Number.isNaN(chrome.totalPlays)).toBe(false);
		expect(Number.isNaN(chrome.totalDuration)).toBe(false);
	});

	it("merges rows across multiple instances with mixed field presence", () => {
		// Instance 1: has duration info
		const instance1 = [
			{
				stat_id: "top_users",
				stat_title: "Top Users",
				rows: [
					{ title: "admin", friendly_name: "Admin", total_plays: 10, total_duration: 72000 },
				],
			},
		];
		// Instance 2: missing duration (like some Tautulli configurations)
		const instance2 = [
			{
				stat_id: "top_users",
				stat_title: "Top Users",
				rows: [
					{ title: "admin", friendly_name: "Admin" },
				],
			},
		];

		const parsed1 = z.array(tautulliHomeStatSchema).parse(instance1);
		const parsed2 = z.array(tautulliHomeStatSchema).parse(instance2);

		// Simulate multi-instance merge (first instance sets base, second adds)
		const result = aggregateHomeStats(parsed1);
		// Manually run second instance through same logic
		for (const stat of parsed2) {
			const existing = result.get(stat.stat_id);
			if (existing) {
				for (const r of stat.rows) {
					const prev = existing.rows.get(r.title);
					if (prev) {
						prev.totalPlays += r.total_plays;
						prev.totalDuration += r.total_duration;
					}
				}
			}
		}

		const admin = result.get("top_users")!.rows.get("admin")!;
		// 10 + 0 = 10, not NaN
		expect(admin.totalPlays).toBe(10);
		// 72000 + 0 = 72000, not NaN
		expect(admin.totalDuration).toBe(72000);
	});

	it("would have failed before fix: z.number() rejects undefined", () => {
		// Prove that the old schema (z.number() without .optional()) would reject this payload
		const strictSchema = z.looseObject({
			stat_id: z.string(),
			stat_title: z.string(),
			rows: z.array(
				z.looseObject({
					title: z.string(),
					total_plays: z.number(), // strict — no optional/default
					total_duration: z.number(), // strict — no optional/default
				}),
			),
		});

		const rawMissingFields = {
			stat_id: "top_platforms",
			stat_title: "Top Platforms",
			rows: [{ title: "Chrome", platform: "Chrome" }],
		};

		const result = strictSchema.safeParse(rawMissingFields);
		expect(result.success).toBe(false);
		if (!result.success) {
			const paths = result.error.issues.map((i) => i.path.join("."));
			expect(paths).toContain("rows.0.total_duration");
			expect(paths).toContain("rows.0.total_plays");
		}
	});
});
