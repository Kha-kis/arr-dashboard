export const DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE =
	"destination_mutation_authority_unavailable" as const;

export const DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE =
	"Jellyfin and Emby label destinations are temporarily unavailable because the provider cannot yet be re-authorized safely at execution time.";

export type LabelSyncDestinationMutationCapability =
	| { supported: true }
	| {
			supported: false;
			code: typeof DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE;
			message: typeof DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE;
	  };

/** Stable containment for destination mutations; source capabilities are intentionally unrelated. */
export function getLabelSyncDestinationMutationCapability(
	service: string,
): LabelSyncDestinationMutationCapability {
	if (service === "jellyfin" || service === "emby") {
		return {
			supported: false,
			code: DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE,
			message: DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE,
		};
	}

	return { supported: true };
}
