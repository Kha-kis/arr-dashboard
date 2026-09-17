import type { FastifyBaseLogger } from "fastify";
import type { PlexSettlementLibrary } from "./plex-client.js";

const CATALOG_FIELDS = [
	["uuid", "identity"],
	["type", "media-type"],
	["title", "display-name"],
	["scannedAt", "scan-revision"],
	["updatedAt", "update-revision"],
] as const;

export type PlexCatalogChange =
	| "section-membership"
	| (typeof CATALOG_FIELDS)[number][1]
	| "unknown";

type CatalogSection = Pick<PlexSettlementLibrary, "key" | (typeof CATALOG_FIELDS)[number][0]>;

/** Classify known client failures without serializing any upstream error text. */
export function classifyPlexHistoryFailure(
	error: unknown,
): "history-pagination-changed" | "history-verification-changed" | "unclassified" {
	try {
		if (!(error instanceof Error)) return "unclassified";
		switch (error.message) {
			case "Plex history changed while it was being paged":
				return "history-pagination-changed";
			case "Plex history changed before its complete snapshot could be verified":
				return "history-verification-changed";
			default:
				return "unclassified";
		}
	} catch {
		return "unclassified";
	}
}

/** Diagnostics only: values and identifiers never leave this comparison. */
export function classifyPlexCatalogChanges(
	before: readonly CatalogSection[],
	after: readonly CatalogSection[],
): PlexCatalogChange[] {
	try {
		const left = new Map(before.map((section) => [section.key, section]));
		const right = new Map(after.map((section) => [section.key, section]));
		if (left.size !== before.length || right.size !== after.length) return ["unknown"];
		const changes = new Set<PlexCatalogChange>();
		for (const key of new Set([...left.keys(), ...right.keys()])) {
			const initial = left.get(key);
			const final = right.get(key);
			if (!initial || !final) {
				changes.add("section-membership");
				continue;
			}
			for (const [field, category] of CATALOG_FIELDS) {
				if (initial[field] !== final[field]) changes.add(category);
			}
		}
		return [...changes].sort();
	} catch {
		return ["unknown"];
	}
}

/**
 * Request/authority callers can carry private bindings that Pino serializes
 * even when a log call supplies only safe fields. Cache entrypoints pass the
 * application logger; other bound callers must omit these optional diagnostics.
 */
export function logPlexCollectionRejection(
	log: FastifyBaseLogger | undefined,
	event: {
		category: "plex-canonical-collection-rejected" | "plex-native-collection-rejected";
		stage: string;
		reason: string;
		catalogChanges?: readonly PlexCatalogChange[];
	},
): void {
	try {
		if (!log) return;
		const bindings = "bindings" in log && typeof log.bindings === "function" ? log.bindings() : {};
		if (Object.keys(bindings).some((key) => !["pid", "hostname", "reqId"].includes(key))) return;
		log.warn(
			event,
			event.category === "plex-native-collection-rejected"
				? "Plex native inventory collection rejected"
				: "Plex canonical collection rejected",
		);
	} catch {
		// Diagnostics must never affect publication eligibility or failure handling.
	}
}
