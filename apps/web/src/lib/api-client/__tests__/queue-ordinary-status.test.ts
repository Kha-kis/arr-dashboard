import { afterEach, describe, expect, it, vi } from "vitest";
import { performQueueAction, performQueueBulkAction } from "../dashboard";

afterEach(() => vi.unstubAllGlobals());
const cases = [
	["single", "delete"],
	["single", "retry"],
	["bulk", "delete"],
	["bulk", "retry"],
] as const;
function request(kind: "single" | "bulk", action: "delete" | "retry") {
	const options = {
		instanceId: "first",
		service: "radarr" as const,
		action,
		removeFromClient: true,
		blocklist: false,
		changeCategory: false,
		search: false,
	};
	return kind === "single"
		? performQueueAction({ ...options, itemId: 11 })
		: performQueueBulkAction({ ...options, ids: [11, 12] });
}
describe("ordinary queue acknowledgment status at the real API client boundary", () => {
	it.each(cases)("accepts only genuine204 for %s %s", async (kind, action) => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return new Response(null, { status: 204 });
		});
		await expect(request(kind, action)).resolves.toBeUndefined();
		expect(calls).toBe(1);
	});
	it.each(cases)("refuses wrong-success200 for %s %s without replay", async (kind, action) => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return Response.json({ removal: "completed", search: "submitted" }, { status: 200 });
		});
		await expect(request(kind, action)).rejects.toThrow(
			"Request acknowledgment could not be verified.",
		);
		expect(calls).toBe(1);
	});
});
