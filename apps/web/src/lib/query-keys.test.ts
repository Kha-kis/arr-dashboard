import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { dashboardKeys, qualityProfileKeys } from "./query-keys";

describe("cloned profile query keys", () => {
	it("keeps transformed configuration data out of the source-review token cache", () => {
		const queryClient = new QueryClient();
		const trashId = "cloned-instance-1-7";
		queryClient.setQueryData(qualityProfileKeys.clone.configuration(trashId), {
			profile: { name: "Any" },
		});

		expect(
			queryClient.getQueryData(qualityProfileKeys.clone.sourceReview(trashId)),
		).toBeUndefined();
	});
});

describe("History query keys", () => {
	it("has a fixed non-cursor shape with chain revision", () => {
		const key = dashboardKeys.history({
			limit: 25,
			startDate: null,
			endDate: null,
			search: null,
			service: null,
			instanceId: null,
			eventType: null,
			hideProwlarrRss: true,
			chainRevision: 0,
		});
		expect(key).toEqual([
			"dashboard",
			"history",
			{
				limit: 25,
				startDate: null,
				endDate: null,
				search: null,
				service: null,
				instanceId: null,
				eventType: null,
				hideProwlarrRss: true,
				chainRevision: 0,
			},
		]);
		expect(JSON.stringify(key)).not.toContain("cursor");
	});

	it("changes when any server filter or chain revision changes", () => {
		const base = {
			limit: 25,
			startDate: null,
			endDate: null,
			search: null,
			service: null,
			instanceId: null,
			eventType: null,
			hideProwlarrRss: true,
			chainRevision: 0,
		};
		for (const field of Object.keys(base) as Array<keyof typeof base>) {
			const changed = {
				...base,
				[field]:
					field === "limit"
						? 50
						: field === "hideProwlarrRss"
							? false
							: field === "chainRevision"
								? 1
								: "changed",
			};
			expect(dashboardKeys.history(changed)).not.toEqual(dashboardKeys.history(base));
		}
	});
});
