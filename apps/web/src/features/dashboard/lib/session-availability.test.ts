import { describe, expect, it } from "vitest";
import { summarizeSessionQueries } from "./session-availability";

const current = () => ({
	enabled: true,
	query: {
		isLoading: false,
		isError: false,
		data: {
			sessions: [{}],
			availability: {
				status: "complete" as const,
				configuredSources: 1,
				availableSources: 1,
			},
		},
	},
});

describe("Activity count uses live-session coverage", () => {
	it("reports complete independent-source counts and healthy empty zero", () => {
		expect(summarizeSessionQueries([current(), current()]).exactCount).toBe(2);
		const empty = current();
		empty.query.data.sessions = [];
		expect(summarizeSessionQueries([empty]).exactCount).toBe(0);
	});
	it.each(["error", "loading", "partial", "not-configured", "legacy", "multiple"])(
		"does not show an exact Activity badge for %s coverage",
		(state) => {
			const source = current();
			if (state === "error") source.query.isError = true;
			if (state === "loading") source.query.isLoading = true;
			if (state === "multiple") source.query.data.availability.configuredSources = 2;
			const data =
				state === "legacy"
					? { sessions: [{}] }
					: {
							...source.query.data,
							availability: {
								...source.query.data.availability,
								status:
									state === "partial"
										? ("partial" as const)
										: state === "not-configured"
											? ("not-configured" as const)
											: ("complete" as const),
							},
						};
			expect(
				summarizeSessionQueries([{ ...source, query: { ...source.query, data } }]).exactCount,
			).toBeUndefined();
		},
	);
	it("ignores disabled sources with cached rows or errors", () => {
		const disabled = current();
		disabled.enabled = false;
		disabled.query.isError = true;
		expect(summarizeSessionQueries([current(), disabled]).exactCount).toBe(1);
		expect(summarizeSessionQueries([disabled]).exactCount).toBeUndefined();
	});
});
