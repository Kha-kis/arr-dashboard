import { createHash } from "node:crypto";
import type { TautulliLibrary } from "@arr/shared";
import {
	createTautulliGenerationObservationRoot,
	createTautulliTargetCatalogRoot,
	normalizeTautulliGenerationObservations,
	type TautulliGenerationObservation,
	type TautulliGenerationRoot,
} from "./tautulli-generation-observations.js";
import type { TautulliReasonCode } from "./tautulli-generation-metadata.js";

export const TAUTULLI_CATALOG_PAGE_SIZE = 250;
export const TAUTULLI_METADATA_CONCURRENCY = 6;
export const TAUTULLI_MAX_EXACT_TARGETS = 20_000;

export type TautulliSupportedSection = Readonly<{
	sectionId: string;
	sectionType: "movie" | "show";
	declaredCount: number;
}>;

export type TautulliCatalogRow = {
	section_id: string;
	rating_key: string;
	media_type: string;
	play_count: number | null;
	last_played: number | null;
};

export type TautulliCatalogPage = {
	data: TautulliCatalogRow[];
	recordsFiltered: number;
	recordsTotal: number;
	last_refreshed: string | number | null;
};

export type TautulliCatalogMetadata = {
	rating_key?: string;
	section_id?: string;
	media_type: string;
	guid?: string;
	guids: string[];
};

type Client = {
	getLibraries(): Promise<TautulliLibrary[]>;
	refreshLibraryMediaInfo(sectionId: string): Promise<unknown>;
	getLibraryMediaInfo(params: {
		sectionId: string;
		start: number;
		length: number;
	}): Promise<TautulliCatalogPage>;
	getMetadata(ratingKey: string): Promise<TautulliCatalogMetadata>;
};

type Scope = Pick<
	TautulliGenerationObservation,
	"instanceId" | "generationId" | "connectionGeneration" | "identityGeneration"
>;

export class TautulliEvidenceError extends Error {
	constructor(public readonly code: TautulliReasonCode) {
		super(`Tautulli evidence unavailable: ${code}`);
		this.name = "TautulliEvidenceError";
	}
}

function safeTotal(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= 0 &&
		(value as number) <= TAUTULLI_MAX_EXACT_TARGETS
	);
}

function fingerprintProviderGuid(value: string): string {
	const canonical = value.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\/.+$/i.test(canonical) || canonical.includes("\0"))
		throw new TautulliEvidenceError("metadata_identity_mismatch");
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function uniqueTmdbId(guids: readonly string[]): number {
	const ids = new Set<number>();
	for (const guid of guids) {
		const match = /^tmdb:\/\/(\d+)$/.exec(guid.trim());
		if (match?.[1]) {
			const id = Number.parseInt(match[1], 10);
			if (Number.isSafeInteger(id) && id > 0) ids.add(id);
		}
	}
	if (ids.size !== 1) throw new TautulliEvidenceError("metadata_tmdb_unmapped");
	return [...ids][0]!;
}

async function boundedMap<T, R>(
	values: readonly T[],
	limit: number,
	map: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, values.length) }, async () => {
			while (true) {
				const index = next++;
				if (index >= values.length) return;
				results[index] = await map(values[index]!);
			}
		}),
	);
	return results;
}

async function collectSection(
	client: Client,
	section: TautulliSupportedSection,
): Promise<TautulliCatalogRow[]> {
	await client.refreshLibraryMediaInfo(section.sectionId);
	const rows: TautulliCatalogRow[] = [];
	const seen = new Set<string>();
	let expectedTotal: number | undefined;
	let timestamp: string | undefined;
	for (let start = 0; ; start += TAUTULLI_CATALOG_PAGE_SIZE) {
		let page: TautulliCatalogPage;
		try {
			page = await client.getLibraryMediaInfo({
				sectionId: section.sectionId,
				start,
				length: TAUTULLI_CATALOG_PAGE_SIZE,
			});
		} catch {
			throw new TautulliEvidenceError("catalog_unavailable");
		}
		if (
			!safeTotal(page.recordsFiltered) ||
			!safeTotal(page.recordsTotal) ||
			page.recordsFiltered !== page.recordsTotal
		)
			throw new TautulliEvidenceError("catalog_total_mismatch");
		if (page.recordsFiltered !== section.declaredCount)
			throw new TautulliEvidenceError("catalog_total_mismatch");
		if (expectedTotal === undefined) expectedTotal = page.recordsFiltered;
		if (page.recordsFiltered !== expectedTotal)
			throw new TautulliEvidenceError("catalog_total_mismatch");
		if (expectedTotal > 0) {
			const currentTimestamp = String(page.last_refreshed ?? "").trim();
			if (!currentTimestamp || (timestamp !== undefined && timestamp !== currentTimestamp))
				throw new TautulliEvidenceError("catalog_changed");
			timestamp = currentTimestamp;
		}
		const expectedPageLength = Math.min(TAUTULLI_CATALOG_PAGE_SIZE, expectedTotal - start);
		if (page.data.length !== expectedPageLength)
			throw new TautulliEvidenceError("catalog_total_mismatch");
		for (const row of page.data) {
			if (
				row.section_id !== section.sectionId ||
				row.media_type !== section.sectionType ||
				!row.rating_key.trim()
			)
				throw new TautulliEvidenceError("metadata_identity_mismatch");
			if (seen.has(row.rating_key)) throw new TautulliEvidenceError("catalog_duplicate_target");
			seen.add(row.rating_key);
			rows.push(row);
		}
		if (rows.length === expectedTotal) return rows;
		if (rows.length > expectedTotal || rows.length >= TAUTULLI_MAX_EXACT_TARGETS)
			throw new TautulliEvidenceError("catalog_total_mismatch");
	}
}

type CatalogPartialReason = {
	code: "metadata_unavailable" | "metadata_tmdb_unmapped" | "observation_count_unavailable";
	count: number;
};
type CatalogMetadataOutcome =
	| { observation: TautulliGenerationObservation }
	| { reasonCode: CatalogPartialReason["code"] };

function catalogDigest(rows: readonly TautulliCatalogRow[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				[...rows]
					.map((row) => [
						row.section_id,
						row.rating_key,
						row.media_type,
						row.play_count,
						row.last_played,
					])
					.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
			),
			"utf8",
		)
		.digest("hex");
}

function parseDeclaredCount(value: unknown): number {
	if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
		throw new TautulliEvidenceError("catalog_total_mismatch");
	}
	const count = Number(value);
	if (!safeTotal(count)) throw new TautulliEvidenceError("catalog_total_mismatch");
	return count;
}

function createSupportedSectionManifest(libraries: readonly TautulliLibrary[]) {
	const supported = libraries
		.filter((library) => library.section_type === "movie" || library.section_type === "show")
		.map((library) =>
			Object.freeze({
				sectionId: library.section_id,
				sectionType: library.section_type as "movie" | "show",
				declaredCount: parseDeclaredCount(library.count),
			}),
		)
		.sort((left, right) => left.sectionId.localeCompare(right.sectionId));
	if (supported.length === 0) throw new TautulliEvidenceError("catalog_unavailable");
	const seen = new Set<string>();
	let total = 0;
	for (const section of supported) {
		if (!section.sectionId.trim() || seen.has(section.sectionId)) {
			throw new TautulliEvidenceError("catalog_changed");
		}
		seen.add(section.sectionId);
		total += section.declaredCount;
		if (!safeTotal(total)) throw new TautulliEvidenceError("catalog_total_mismatch");
	}
	return Object.freeze(supported) as readonly TautulliSupportedSection[];
}

async function readSupportedSectionManifest(
	client: Client,
): Promise<readonly TautulliSupportedSection[]> {
	try {
		return createSupportedSectionManifest(await client.getLibraries());
	} catch (error) {
		if (error instanceof TautulliEvidenceError) throw error;
		throw new TautulliEvidenceError("catalog_unavailable");
	}
}

function manifestsMatch(
	left: readonly TautulliSupportedSection[],
	right: readonly TautulliSupportedSection[],
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function collectPass(
	client: Client,
	scope: Scope,
	sections: readonly TautulliSupportedSection[],
): Promise<{
	observations: TautulliGenerationObservation[];
	partialReasons: CatalogPartialReason[];
	catalogDigest: string;
}> {
	const catalogRows: TautulliCatalogRow[] = [];
	for (const section of sections) {
		catalogRows.push(...(await collectSection(client, section)));
		if (catalogRows.length > TAUTULLI_MAX_EXACT_TARGETS)
			throw new TautulliEvidenceError("catalog_total_mismatch");
	}
	const seen = new Set<string>();
	for (const row of catalogRows) {
		if (seen.has(row.rating_key)) throw new TautulliEvidenceError("catalog_duplicate_target");
		seen.add(row.rating_key);
	}
	const outcomes = await boundedMap<TautulliCatalogRow, CatalogMetadataOutcome>(
		catalogRows,
		TAUTULLI_METADATA_CONCURRENCY,
		async (row) => {
			let metadata: TautulliCatalogMetadata;
			try {
				metadata = await client.getMetadata(row.rating_key);
			} catch {
				return { reasonCode: "metadata_unavailable" as const };
			}
			if (
				metadata.rating_key !== row.rating_key ||
				metadata.section_id !== row.section_id ||
				metadata.media_type !== row.media_type
			)
				throw new TautulliEvidenceError("metadata_identity_mismatch");
			let tmdbId: number;
			try {
				tmdbId = uniqueTmdbId(metadata.guids);
			} catch (error) {
				if (error instanceof TautulliEvidenceError && error.code === "metadata_tmdb_unmapped") {
					return { reasonCode: error.code };
				}
				throw error;
			}
			if (!Number.isSafeInteger(row.play_count) || (row.play_count as number) < 0) {
				return { reasonCode: "observation_count_unavailable" as const };
			}
			return {
				observation: {
					...scope,
					sectionId: row.section_id,
					ratingKey: row.rating_key,
					providerGuidFingerprint: fingerprintProviderGuid(metadata.guid ?? ""),
					mediaType: row.media_type === "show" ? ("series" as const) : ("movie" as const),
					tmdbId,
					observedWatchCount: row.play_count,
					lastWatchedAt: row.last_played == null ? null : new Date(row.last_played * 1000),
				},
			};
		},
	);
	const reasonCounts = new Map<CatalogPartialReason["code"], number>();
	const observations: TautulliGenerationObservation[] = [];
	for (const outcome of outcomes) {
		if ("reasonCode" in outcome) {
			reasonCounts.set(outcome.reasonCode, (reasonCounts.get(outcome.reasonCode) ?? 0) + 1);
		} else {
			observations.push(outcome.observation);
		}
	}
	return {
		observations: normalizeTautulliGenerationObservations(observations, scope),
		partialReasons: [...reasonCounts]
			.map(([code, count]) => ({ code, count }))
			.sort((left, right) => left.code.localeCompare(right.code)),
		catalogDigest: catalogDigest(catalogRows),
	};
}

export async function collectStableTautulliTargetCatalog(
	client: Client,
	scope: Scope,
): Promise<{
	observations: TautulliGenerationObservation[];
	publicationLevel: "authoritative" | "positive-only";
	partialReasons: CatalogPartialReason[];
	targetCatalogRoot: TautulliGenerationRoot;
	observationRoot: TautulliGenerationRoot;
	/** @deprecated compatibility alias for the observation root */
	root: TautulliGenerationRoot;
	sections: readonly TautulliSupportedSection[];
}> {
	const sections = await readSupportedSectionManifest(client);
	const first = await collectPass(client, scope, sections);
	const comparisonSections = await readSupportedSectionManifest(client);
	if (!manifestsMatch(sections, comparisonSections)) {
		throw new TautulliEvidenceError("catalog_changed");
	}
	const second = await collectPass(client, scope, sections);
	if (
		first.catalogDigest !== second.catalogDigest ||
		JSON.stringify(first.partialReasons) !== JSON.stringify(second.partialReasons)
	)
		throw new TautulliEvidenceError("catalog_changed");
	const publicationLevel = second.partialReasons.length === 0 ? "authoritative" : "positive-only";
	const firstRows =
		publicationLevel === "authoritative"
			? first.observations
			: first.observations.filter((row) => (row.observedWatchCount ?? 0) > 0);
	const secondRows =
		publicationLevel === "authoritative"
			? second.observations
			: second.observations.filter((row) => (row.observedWatchCount ?? 0) > 0);
	if (publicationLevel === "positive-only" && secondRows.length === 0) {
		throw new TautulliEvidenceError(second.partialReasons[0]?.code ?? "metadata_unavailable");
	}
	const firstRoot = createTautulliGenerationObservationRoot({ ...scope, rows: firstRows });
	const secondRoot = createTautulliGenerationObservationRoot({ ...scope, rows: secondRows });
	if (firstRoot.count !== secondRoot.count || firstRoot.digest !== secondRoot.digest)
		throw new TautulliEvidenceError("catalog_changed");
	return {
		observations: secondRows,
		publicationLevel,
		partialReasons: second.partialReasons,
		targetCatalogRoot: createTautulliTargetCatalogRoot({ ...scope, rows: secondRows }),
		observationRoot: secondRoot,
		root: secondRoot,
		sections,
	};
}
