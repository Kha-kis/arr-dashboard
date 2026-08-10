import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { qualityProfileKeys } from "./query-keys";

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
