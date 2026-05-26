import { describe, expect, it } from "vitest";
import { mapTrackerHealth } from "../tracker-health-mapper.js";

describe("mapTrackerHealth", () => {
	it("maps the documented qBit status integers", () => {
		expect(mapTrackerHealth(0)).toBe("disabled");
		expect(mapTrackerHealth(1)).toBe("not_contacted");
		expect(mapTrackerHealth(2)).toBe("working");
		expect(mapTrackerHealth(3)).toBe("updating");
		expect(mapTrackerHealth(4)).toBe("not_working");
	});

	it("returns 'unknown' for out-of-range values", () => {
		expect(mapTrackerHealth(5)).toBe("unknown");
		expect(mapTrackerHealth(-1)).toBe("unknown");
		expect(mapTrackerHealth(99)).toBe("unknown");
	});
});
