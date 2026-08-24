/**
 * Explicit historical-observation surface. These loaders describe immutable
 * published generations for status, diagnostics, and refresh scheduling only.
 * They do not establish current exact, negative, or mutation authority.
 */
export {
	getPublishedEpisodeGenerationObservation,
	getPublishedGenerationObservation,
	getPublishedGenerationObservationForOwnedInstance,
	loadGenerationObservationsForOwnedInstances,
	loadUserGenerationObservations,
} from "./plex-evidence-repository.js";
