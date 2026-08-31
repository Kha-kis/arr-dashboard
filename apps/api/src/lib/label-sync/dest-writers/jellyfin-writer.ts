/**
 * Destination writer for Jellyfin / Emby instances.
 *
 * Stable containment: Jellyfin / Emby remain source integrations, but their
 * destination mutation path is disabled until issue #836 receives durable
 * mutation claims, outcomes, and reconciliation.
 */

import type { ServiceType } from "../../prisma.js";
import { getLabelSyncDestinationMutationCapability } from "../destination-capability.js";
import type { DestWriteResult, DestWriter, DestWriterOpts } from "../strategy-types.js";

interface JellyfinWriterConfig {
	prismaService: Extract<ServiceType, "JELLYFIN" | "EMBY">;
	destService: "jellyfin" | "emby";
}

export const jellyfinDestWriter: DestWriter = createWriter({
	prismaService: "JELLYFIN",
	destService: "jellyfin",
});
export const embyDestWriter: DestWriter = createWriter({
	prismaService: "EMBY",
	destService: "emby",
});

function createWriter(config: JellyfinWriterConfig): DestWriter {
	return {
		prismaService: config.prismaService,
		async applyLabels(opts: DestWriterOpts): Promise<DestWriteResult> {
			const { candidates } = opts;

			if (candidates.length === 0) {
				return { matchesFound: 0, labelsApplied: 0, failures: 0 };
			}

			const capability = getLabelSyncDestinationMutationCapability(config.destService);
			if (!capability.supported) {
				return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
			}

			// If the centralized table is changed without a replacement writer,
			// this stable implementation still fails closed instead of restoring I/O.
			return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
		},
	};
}
