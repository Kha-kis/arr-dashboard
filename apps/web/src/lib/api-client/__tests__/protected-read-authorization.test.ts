import { afterEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "../base";
import {
	fetchDashboardStatistics,
	fetchMultiInstanceCalendar,
	fetchMultiInstanceQueue,
} from "../dashboard";
import { fetchLibrary, fetchLibraryItemByTmdbId } from "../library";
import { fetchServices } from "../services";
import { fetchTags } from "../tags";

describe("protected read authorization", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("never converts a 401 into successful empty data", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

		for (const read of [
			() => fetchServices(),
			() => fetchTags(),
			() => fetchLibrary(),
			() => fetchLibraryItemByTmdbId(42),
			() => fetchMultiInstanceQueue(),
			() => fetchMultiInstanceCalendar(),
			() => fetchDashboardStatistics(),
		]) {
			await expect(read()).rejects.toBeInstanceOf(UnauthorizedError);
		}
	});
});
