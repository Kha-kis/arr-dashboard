/**
 * Destination writer for Jellyfin / Emby instances.
 *
 * Jellyfin destination writes use the durable mutation executor when the
 * centralized capability gate is enabled. Emby remains disabled.
 */

import type { ServiceType } from "../../prisma.js";
import { getLabelSyncDestinationMutationCapability } from "../destination-capability.js";
import { executeJellyfinMutations } from "../jellyfin-mutation-executor.js";
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
			if (config.destService === "emby") {
				return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
			}
			return await executeJellyfinMutations(opts);
		},
	};
}
