import { afterEach, describe, expect, it, vi } from "vitest";
import { deployMultipleCustomFormats } from "../custom-formats";

const request = { instanceId: "instance", serviceType: "RADARR" as const, trashIds: ["selected"] };
const complete = () => ({
	success: true,
	outcome: "complete",
	historyId: "history",
	message: "Complete",
	created: ["Selected"],
	updated: [],
	unchanged: [],
	failed: [],
	targets: [{ trashId: "selected", name: "Selected", status: "created", tracked: true }],
});
function respond(value: unknown) {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
}
afterEach(() => vi.unstubAllGlobals());
describe("standalone deployment acknowledgment", () => {
	it("accepts exact verified completion", async () => {
		respond(complete());
		expect((await deployMultipleCustomFormats(request)).success).toBe(true);
	});
	it.each([
		{ ...complete(), targets: [] },
		{ ...complete(), targets: [{ ...complete().targets[0], trashId: "another" }] },
		{ ...complete(), targets: [...complete().targets, ...complete().targets] },
		{ ...complete(), targets: [{ ...complete().targets[0], tracked: false }] },
		{ ...complete(), targets: [{ ...complete().targets[0], status: "uncertain" }] },
		{ ...complete(), created: [] },
		{ ...complete(), failed: [{ name: "Selected", error: "Failed" }] },
		{ ...complete(), outcome: "uncertain" },
	])("refuses inconsistent success %j", async (result) => {
		respond(result);
		await expect(deployMultipleCustomFormats(request)).rejects.toThrow(/acknowledgment/i);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("retains all uncertain target outcomes without repeating the mutation", async () => {
		const partial = {
			...complete(),
			success: false,
			outcome: "uncertain",
			created: [],
			failed: [{ name: "Selected", error: "Readback unavailable" }],
			targets: [{ ...complete().targets[0], status: "uncertain", tracked: false }],
		};
		respond(partial);
		expect(await deployMultipleCustomFormats(request)).toEqual(partial);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
