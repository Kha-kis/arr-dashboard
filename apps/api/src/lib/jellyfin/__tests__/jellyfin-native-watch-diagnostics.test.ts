import { describe, expect, it } from "vitest";
import { emptyNativeWatchProjectionDiagnostics } from "../jellyfin-native-watch-projection.js";
import {
	parseNativeWatchScopeDiagnostics,
	serializeNativeWatchScopeDiagnostics,
} from "../jellyfin-native-watch-diagnostics.js";

const diagnostics = {
	version: 1 as const,
	...emptyNativeWatchProjectionDiagnostics(),
	collectUnits: 1,
	verifyUnits: 1,
	collectStageRows: 3,
	verifyStageRows: 3,
	expectedCountsMatch: true,
	excludedRows: 0,
};
describe("native watch diagnostics", () => {
	it("round trips only versioned constant keys", () => {
		expect(
			parseNativeWatchScopeDiagnostics(serializeNativeWatchScopeDiagnostics(diagnostics)),
		).toEqual(diagnostics);
	});
	it.each([
		null,
		"",
		"{",
		" ".repeat(2049),
		JSON.stringify({ ...diagnostics, title: "private" }),
		JSON.stringify({ ...diagnostics, version: 2 }),
		JSON.stringify({ ...diagnostics, collectUnits: -1 }),
		JSON.stringify({ ...diagnostics, verifyStageRows: Number.MAX_SAFE_INTEGER + 1 }),
	])("treats legacy or malformed diagnostics as unavailable: %#", (json) => {
		expect(parseNativeWatchScopeDiagnostics(json)).toBeNull();
	});
});
