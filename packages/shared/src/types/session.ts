/** Informational coverage for a live session read, never mutation authority. */
export interface SessionAvailability {
	status: "complete" | "partial" | "unavailable" | "not-configured";
	configuredSources: number;
	availableSources: number;
}
