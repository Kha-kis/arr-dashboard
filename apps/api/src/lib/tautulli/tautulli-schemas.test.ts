import { describe, expect, it } from "vitest";
import {
	tautulliHomeStatSchema,
	tautulliMetadataSchema,
	tautulliUserSchema,
} from "./tautulli-schemas.js";

describe("Tautulli boundary schemas", () => {
	it("normalizes a sparse metadata success payload without inventing identity", () => {
		const parsed = tautulliMetadataSchema.parse({});

		expect(parsed).toEqual({ guids: [], media_type: "unknown", title: "" });
	});

	it("makes incomplete home-stat rows arithmetically complete", () => {
		const parsed = tautulliHomeStatSchema.parse({
			stat_id: "top_platforms",
			stat_title: "Top Platforms",
			rows: [{ title: "Browser" }],
		});

		expect(parsed.rows[0]).toMatchObject({ total_plays: 0, total_duration: 0 });
	});

	it("accepts documented user identities without inventing fields", () => {
		expect(
			tautulliUserSchema.parse({
				user_id: "133788",
				username: "jon@example.test",
				friendly_name: "Jon Snow",
			}),
		).toEqual({
			user_id: "133788",
			username: "jon@example.test",
			friendly_name: "Jon Snow",
		});
	});

	it("preserves documented stat-specific row identity and metrics", () => {
		const platform = tautulliHomeStatSchema.parse({
			stat_id: "top_platforms",
			stat_title: "Most Active Platforms",
			rows: [{ platform: "Chrome", total_plays: 4, total_duration: 120 }],
		});
		const user = tautulliHomeStatSchema.parse({
			stat_id: "top_users",
			stat_title: "Most Active Users",
			rows: [{ user: "jon", friendly_name: "Jon Snow", total_plays: 4 }],
		});
		const concurrent = tautulliHomeStatSchema.parse({
			stat_id: "most_concurrent",
			stat_title: "Most Concurrent Streams",
			rows: [{ count: 3, started: 10, stopped: 20 }],
		});

		expect(platform.rows[0]).toMatchObject({ platform: "Chrome", total_plays: 4 });
		expect(user.rows[0]).toMatchObject({ user: "jon", friendly_name: "Jon Snow" });
		expect(concurrent.rows[0]).toMatchObject({ count: 3, started: 10, stopped: 20 });
	});
});
