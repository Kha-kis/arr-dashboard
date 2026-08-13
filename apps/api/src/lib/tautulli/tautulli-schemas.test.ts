import { describe, expect, it } from "vitest";
import { tautulliHomeStatSchema, tautulliMetadataSchema } from "./tautulli-schemas.js";

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
});
