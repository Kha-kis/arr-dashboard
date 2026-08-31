import { describe, expect, it } from "vitest";
import {
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE,
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE,
	getLabelSyncDestinationMutationCapability,
} from "../destination-capability.js";

describe("label-sync destination mutation capability", () => {
	it.each(["sonarr", "radarr", "plex"])("keeps %s destination mutation supported", (service) => {
		expect(getLabelSyncDestinationMutationCapability(service)).toEqual({ supported: true });
	});

	it.each(["jellyfin", "emby"])("fails closed for the %s destination", (service) => {
		expect(getLabelSyncDestinationMutationCapability(service)).toEqual({
			supported: false,
			code: DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE,
			message: DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE,
		});
	});
});
