import {
	getLabelSyncDestinationMutationCapability as getSharedCapability,
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE as SHARED_UNAVAILABLE,
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE as SHARED_UNAVAILABLE_MESSAGE,
} from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE,
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE,
	getLabelSyncDestinationMutationCapability,
} from "../destination-capability.js";

describe("label-sync destination mutation capability", () => {
	it("uses the shared capability contract through the API facade", () => {
		expect(DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE).toBe(SHARED_UNAVAILABLE);
		expect(DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE).toBe(SHARED_UNAVAILABLE_MESSAGE);
		expect(getLabelSyncDestinationMutationCapability).toBe(getSharedCapability);
	});

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
