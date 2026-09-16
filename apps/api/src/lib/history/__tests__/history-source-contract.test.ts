import { describe, expect, it } from "vitest";
import {
	HISTORY_COLLECTION_MAX_RAW_ROWS,
	HISTORY_COLLECTION_MAX_REQUESTS,
	HISTORY_COLLECTION_PAGE_SIZE,
	HISTORY_OBSERVATION_METADATA_MAX_BYTES,
	HISTORY_OBSERVATION_RECEIPT_SCOPE,
	HISTORY_SERVICE_TYPES,
	historyServiceToCoverageProvider,
	historyServiceTypeToService,
	isHistoryServiceType,
} from "../history-source-contract.js";

describe("History source contract", () => {
	it("exports exactly the five database History service types and bounds", () => {
		expect(HISTORY_SERVICE_TYPES).toEqual(["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"]);
		expect(HISTORY_COLLECTION_MAX_REQUESTS).toBe(100);
		expect(HISTORY_COLLECTION_MAX_RAW_ROWS).toBe(10_000);
		expect(HISTORY_COLLECTION_PAGE_SIZE).toBe(100);
		expect(HISTORY_OBSERVATION_METADATA_MAX_BYTES).toBe(8 * 1024);
		expect(HISTORY_OBSERVATION_RECEIPT_SCOPE).toBe("history");
	});

	it.each([
		["SONARR", "sonarr", "sonarr_history"],
		["RADARR", "radarr", "radarr_history"],
		["PROWLARR", "prowlarr", "prowlarr_history"],
		["LIDARR", "lidarr", "lidarr_history"],
		["READARR", "readarr", "readarr_history"],
	] as const)(
		"maps %s exactly to its shared service and coverage provider",
		(source, service, provider) => {
			expect(isHistoryServiceType(source)).toBe(true);
			expect(historyServiceTypeToService(source)).toBe(service);
			expect(historyServiceToCoverageProvider(service)).toBe(provider);
		},
	);

	it.each(["sonarr", "Radarr", "Prowlarr", "plex", "", 1, null, undefined, {}, []])(
		"fails closed for a non-exact History source value: %p",
		(value) => {
			expect(isHistoryServiceType(value)).toBe(false);
		},
	);

	it("does not expose conversion results for unknown values", () => {
		expect(historyServiceTypeToService("plex" as never)).toBeUndefined();
		expect(historyServiceToCoverageProvider("plex" as never)).toBeUndefined();
	});

	it("keeps the metadata bound below the byte limit", () => {
		expect(HISTORY_OBSERVATION_METADATA_MAX_BYTES).toBeLessThanOrEqual(8192);
	});
});
