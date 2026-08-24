import type { PlexCoverageReasonCode } from "@arr/shared";

export type PlexLiveSection = {
	key: string;
	uuid: string;
	title: string;
	type: string;
	refreshing: boolean;
	scannedAt: number | null;
	updatedAt: number;
	agent?: string;
};

export type PlexLiveActivity = {
	type: string;
	Context?: { librarySectionID?: string };
};

export type PlexLiveSettlementResult =
	| { settled: true; reasonCodes: [] }
	| { settled: false; reasonCodes: PlexCoverageReasonCode[] };

export function evaluatePlexLiveSettlement(input: {
	activities: readonly PlexLiveActivity[];
	sections: readonly PlexLiveSection[];
	selectedSectionKeys: readonly string[];
}): PlexLiveSettlementResult {
	const sectionByKey = new Map(input.sections.map((section) => [section.key, section]));
	const selected = new Set(input.selectedSectionKeys);
	for (const sectionKey of selected) {
		const section = sectionByKey.get(sectionKey);
		if (!section) {
			return { settled: false, reasonCodes: ["plex_library_revision_changed"] };
		}
		if (section.refreshing) {
			return { settled: false, reasonCodes: ["plex_library_scan_in_progress"] };
		}
		if (section.scannedAt === null) {
			return { settled: false, reasonCodes: ["plex_library_revision_changed"] };
		}
	}

	for (const activity of input.activities) {
		if (activity.type === "library.update.item.metadata") {
			return { settled: false, reasonCodes: ["plex_metadata_refresh_in_progress"] };
		}
		if (activity.type === "library.update.section") {
			const sectionKey = activity.Context?.librarySectionID;
			if (!sectionKey) {
				return { settled: false, reasonCodes: ["plex_library_activity_unknown"] };
			}
			const section = sectionByKey.get(sectionKey);
			if (!section) {
				return { settled: false, reasonCodes: ["plex_library_activity_unknown"] };
			}
			if (selected.has(sectionKey)) {
				return { settled: false, reasonCodes: ["plex_library_scan_in_progress"] };
			}
			if (section.type === "artist") continue;
			if (section.type === "movie" || section.type === "show") continue;
			return { settled: false, reasonCodes: ["plex_library_activity_unknown"] };
		}
		if (activity.type.startsWith("library.update.")) {
			return { settled: false, reasonCodes: ["plex_library_activity_unknown"] };
		}
	}

	return { settled: true, reasonCodes: [] };
}
