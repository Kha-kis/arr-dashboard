import { describe, expect, it } from "vitest";
import * as notifications from "./notifications.js";

const valid = {
	channelId: "selected",
	expectedRevision: "a".repeat(64),
	endpoint: "https://synthetic.invalid/device",
	keys: { p256dh: "generated-key", auth: "generated-auth" },
};
describe("selected Browser Push reconnect request", () => {
	it("requires a strict complete selected revision and generated config", () => {
		const schema = notifications.browserPushReconnectRequestSchema;
		expect(schema).toBeDefined();
		expect(schema.safeParse(valid).success).toBe(true);
		for (const field of ["channelId", "expectedRevision", "endpoint", "keys"] as const) {
			const incomplete = { ...valid };
			delete (incomplete as Partial<typeof valid>)[field];
			expect(schema.safeParse(incomplete).success).toBe(false);
		}
		for (const invalid of [
			{ ...valid, channelId: "" },
			{ ...valid, expectedRevision: "A".repeat(64) },
			{ ...valid, endpoint: "http://127.0.0.1/private" },
			{ ...valid, enabled: true },
			{ ...valid, keys: { ...valid.keys, extra: "secret" } },
			{ ...valid, keys: { p256dh: "", auth: "auth" } },
		])
			expect(schema.safeParse(invalid).success).toBe(false);
	});
});
