import { describe, expect, it, vi } from "vitest";
import tautulliCacheSchedulerPlugin from "../plugins/tautulli-cache-scheduler.js";
import { registerSchedulers } from "./schedulers.js";

describe("registerSchedulers", () => {
	it("registers the optional Tautulli cache scheduler", () => {
		const register = vi.fn();

		registerSchedulers({ register } as never);

		expect(register).toHaveBeenCalledWith(tautulliCacheSchedulerPlugin);
	});
});
