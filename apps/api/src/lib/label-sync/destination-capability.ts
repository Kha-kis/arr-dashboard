/** API-local compatibility facade; the shared package owns the contract. */

export type { LabelSyncDestinationMutationCapability } from "@arr/shared";
export {
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE,
	DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE,
	getLabelSyncDestinationMutationCapability,
} from "@arr/shared";
