import { describe, expect, it } from "vitest";
import { plexEpisodeRefreshResultStatus } from "../plex-episode-cache-scheduler.js";

describe("plexEpisodeRefreshResultStatus", () => {
	it("reports mixed authoritative success and attribution errors as partial", () => {
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 1,
				upserted: 1,
				refreshedShows: 1,
				capacityDegraded: false,
			}),
		).toBe("partial");
	});

	it("reserves error for runs with no persisted refresh", () => {
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 1,
				upserted: 0,
				refreshedShows: 1,
				capacityDegraded: false,
			}),
		).toBe("error");
	});

	it("keeps capacity degradation partial and complete runs successful", () => {
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 0,
				upserted: 10,
				refreshedShows: 2,
				capacityDegraded: true,
			}),
		).toBe("partial");
		expect(
			plexEpisodeRefreshResultStatus({
				errors: 0,
				upserted: 10,
				refreshedShows: 2,
				capacityDegraded: false,
			}),
		).toBe("success");
	});
});
