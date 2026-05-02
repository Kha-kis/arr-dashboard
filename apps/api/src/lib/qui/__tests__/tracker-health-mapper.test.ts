import { describe, expect, it } from "vitest";
import { isTrackerUnhealthy, mapTrackerHealth } from "../tracker-health-mapper.js";

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

describe("isTrackerUnhealthy", () => {
	it("flags not_working and disabled as unhealthy", () => {
		expect(isTrackerUnhealthy("not_working")).toBe(true);
		expect(isTrackerUnhealthy("disabled")).toBe(true);
	});

	it("does not flag transient or normal states", () => {
		expect(isTrackerUnhealthy("working")).toBe(false);
		expect(isTrackerUnhealthy("not_contacted")).toBe(false);
		expect(isTrackerUnhealthy("updating")).toBe(false);
		expect(isTrackerUnhealthy("unknown")).toBe(false);
	});
});
