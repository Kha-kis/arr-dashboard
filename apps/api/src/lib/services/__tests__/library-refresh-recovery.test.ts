import { describe, expect, it, vi } from "vitest";
import {
	createLibraryRefreshRecoveryBridge,
	type LibraryRefreshRecoveryRequest,
} from "../library-refresh-recovery.js";

const attempt = {
	attemptedAt: new Date("2026-09-14T12:00:00.000Z"),
	resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
};

function request(resultMarker = attempt.resultMarker): LibraryRefreshRecoveryRequest {
	return {
		provider: "plex",
		userId: "user-1",
		instanceId: "plex-1",
		attempt: { ...attempt, resultMarker },
	};
}

describe("library refresh recovery bridge", () => {
	it("rejects a stale settlement after a newer claim is admitted", async () => {
		const bridge = createLibraryRefreshRecoveryBridge();
		const handler = vi.fn().mockResolvedValue({ status: "accepted" as const });
		bridge.register("plex", handler);
		const newer = request("in_progress:00000000-0000-4000-8000-000000000002");

		bridge.admit(request());
		bridge.admit(newer);

		await expect(bridge.arm(request())).resolves.toEqual({ status: "unavailable" });
		expect(handler).not.toHaveBeenCalled();
		await expect(bridge.arm(newer)).resolves.toEqual({ status: "accepted" });
		expect(handler).toHaveBeenCalledWith(newer);
	});
});
