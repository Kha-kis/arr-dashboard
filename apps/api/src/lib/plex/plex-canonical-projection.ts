import { createHash } from "node:crypto";
import type { PlexCanonicalDomain } from "@arr/shared";

export const PLEX_CANONICALIZATION_VERSION = 1 as const;

export type PlexCanonicalSelection =
	| { kind: "all" | "authority-only" }
	| { kind: "targets"; targets: Array<{ mediaType: string; tmdbId: number }> }
	| { kind: "label-membership"; label: string }
	| { kind: "recently-added"; limit: number }
	| { kind: "on-deck"; limit: number };

export type PlexCanonicalObservation = {
	sectionId: string;
	sectionTitle?: string | null;
	mediaType: string;
	tmdbId: number;
	ratingKey?: string | null;
	title?: string | null;
	labels?: string[] | string | null;
	collections?: string[] | string | null;
	watchCount?: number | null;
	watchedByUsers?: string[] | string | null;
	lastWatchedAt?: Date | string | number | null;
	onDeck?: boolean | null;
	userRating?: number | null;
	addedAt?: Date | string | number | null;
	thumb?: string | null;
	seasonNumber?: number | null;
	episodeNumber?: number | null;
	parentRatingKey?: string | null;
	watched?: boolean | null;
};

export type PlexCanonicalProjection = {
	algorithmVersion: typeof PLEX_CANONICALIZATION_VERSION;
	domains: Partial<Record<PlexCanonicalDomain, string>>;
	digest: string;
};

type PlexCanonicalBoundedSelection =
	| { kind: "recently-added"; limit: number }
	| { kind: "on-deck"; limit: number };

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableString(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return `string:${JSON.stringify(value)}`;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Canonical Plex numbers must be finite");
		return `number:${Object.is(value, -0) ? 0 : value}`;
	}
	if (typeof value === "boolean") return `boolean:${value}`;
	if (Array.isArray(value)) return `array:[${value.map(stableString).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		return `object:{${entries
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableString(entry)}`)
			.join(",")}}`;
	}
	throw new Error("Unsupported canonical Plex value");
}

function stringSet(value: string[] | string | null | undefined): string[] {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new Error("Invalid persisted Plex array");
		}
	}
	if (parsed == null) return [];
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error("Invalid Plex string set");
	}
	return [...new Set(parsed)].sort((left, right) => left.localeCompare(right));
}

function timestamp(value: Date | string | number | null | undefined): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error("Invalid Plex timestamp");
	return date.toISOString();
}

function identity(row: PlexCanonicalObservation) {
	if (!Number.isSafeInteger(row.tmdbId) || row.tmdbId <= 0) {
		throw new Error("Invalid Plex TMDB identity");
	}
	return {
		sectionId: row.sectionId,
		mediaType: row.mediaType,
		tmdbId: row.tmdbId,
		ratingKey: row.ratingKey == null ? null : String(row.ratingKey),
	};
}

export function selectPlexBoundedValueRows<T extends PlexCanonicalObservation>(
	rows: readonly T[],
	selection: PlexCanonicalBoundedSelection,
): T[] {
	if (selection.kind === "recently-added") {
		return [...rows]
			.sort(
				(left, right) =>
					(timestamp(right.addedAt) ?? "").localeCompare(timestamp(left.addedAt) ?? "") ||
					stableString(identity(left)).localeCompare(stableString(identity(right))),
			)
			.slice(0, selection.limit);
	}
	return rows
		.filter((row) => row.onDeck === true)
		.sort((left, right) =>
			stableString(identity(left)).localeCompare(stableString(identity(right))),
		)
		.slice(0, selection.limit);
}

export function selectPlexCanonicalRows<T extends PlexCanonicalObservation>(
	rows: readonly T[],
	selection: PlexCanonicalSelection,
): T[] {
	let selected: T[];
	switch (selection.kind) {
		case "all":
			selected = [...rows];
			break;
		case "authority-only":
			selected = [];
			break;
		case "targets": {
			const targets = new Set(
				selection.targets.map((target) => `${target.mediaType}\u0000${target.tmdbId}`),
			);
			selected = rows.filter((row) => targets.has(`${row.mediaType}\u0000${row.tmdbId}`));
			break;
		}
		case "label-membership":
			selected = rows.filter((row) => stringSet(row.labels).includes(selection.label));
			break;
		case "recently-added":
			selected = selectPlexBoundedValueRows(rows, selection);
			break;
		case "on-deck":
			selected = selectPlexBoundedValueRows(rows, selection);
			break;
	}
	return selected.sort((left, right) =>
		stableString(identity(left)).localeCompare(stableString(identity(right))),
	);
}

function domainRow(domain: PlexCanonicalDomain, row: PlexCanonicalObservation): unknown {
	const id = identity(row);
	switch (domain) {
		case "membership":
			return id;
		case "display":
			return {
				...id,
				sectionTitle: row.sectionTitle ?? null,
				title: row.title ?? null,
				addedAt: timestamp(row.addedAt),
				thumb: row.thumb ?? null,
			};
		case "labels":
			return { ...id, labels: stringSet(row.labels) };
		case "collections":
			return { ...id, collections: stringSet(row.collections) };
		case "watch":
			return {
				...id,
				watchCount: row.watchCount ?? 0,
				watchedByUsers: stringSet(row.watchedByUsers),
				lastWatchedAt: timestamp(row.lastWatchedAt),
				userRating: row.userRating ?? null,
			};
		case "on-deck":
			return { ...id, onDeck: row.onDeck === true };
		case "episode-parents":
			return { ...id, parentRatingKey: row.parentRatingKey ?? row.ratingKey ?? null };
		case "episodes":
			return {
				...id,
				title: row.title ?? null,
				seasonNumber: row.seasonNumber ?? null,
				episodeNumber: row.episodeNumber ?? null,
				watched: row.watched === true,
				watchCount: row.watchCount ?? 0,
				watchedByUsers: stringSet(row.watchedByUsers),
				lastWatchedAt: timestamp(row.lastWatchedAt),
			};
	}
}

export function createPlexSelectionProjection(input: {
	rows: readonly PlexCanonicalObservation[];
	selection: PlexCanonicalSelection;
	domains: readonly PlexCanonicalDomain[];
}): PlexCanonicalProjection {
	const rows = selectPlexCanonicalRows(input.rows, input.selection);
	const domains: Partial<Record<PlexCanonicalDomain, string>> = {};
	for (const domain of [...new Set(input.domains)].sort()) {
		domains[domain] = sha256(
			stableString({
				algorithmVersion: PLEX_CANONICALIZATION_VERSION,
				domain,
				rows: rows.map((row) => domainRow(domain, row)),
			}),
		);
	}
	return {
		algorithmVersion: PLEX_CANONICALIZATION_VERSION,
		domains,
		digest: sha256(stableString({ algorithmVersion: PLEX_CANONICALIZATION_VERSION, domains })),
	};
}
