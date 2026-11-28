import { describe, expect, it } from "vitest";
import { multiInstanceQueueResponseSchema } from "../dashboard.js";

describe("queue GET observation contract", () => {
	it.each([true, false, undefined])("retains optional success %s", (success) => {
		const response = multiInstanceQueueResponseSchema.parse({
			instances: [
				{
					instanceId: "source",
					instanceName: "Synthetic",
					service: "sonarr",
					data: [],
					...(success === undefined ? {} : { success }),
				},
			],
			aggregated: [],
			totalCount: 0,
		});
		expect(response.instances[0]).toEqual({
			instanceId: "source",
			instanceName: "Synthetic",
			service: "sonarr",
			data: [],
			...(success === undefined ? {} : { success }),
		});
	});
	it("rejects nonboolean read evidence", () => {
		expect(
			multiInstanceQueueResponseSchema.safeParse({
				instances: [
					{
						instanceId: "source",
						instanceName: "Synthetic",
						service: "sonarr",
						data: [],
						success: "true",
					},
				],
				aggregated: [],
				totalCount: 0,
			}).success,
		).toBe(false);
	});
});
