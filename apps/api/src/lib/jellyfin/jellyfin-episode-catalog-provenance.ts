import { createHash } from "node:crypto";
import type { ProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import type { JellyfinLibraryRowFingerprintInput } from "./jellyfin-generation-metadata.js";

export interface JellyfinEpisodeCatalogProvenance {
	version: 3;
	bindings: Array<{ libraryId: string; seriesId: string; tmdbId: number }>;
	scopes: Array<{ userId: string; libraryId: string }>;
}

export interface JellyfinEpisodeCatalogScope {
	userId: string;
	libraryId: string;
}

export const JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX = "jellyfin-episode-parent-v3:";
const MAX_BINDINGS = 100_000;
const MAX_SCOPES = 20_000;

function validId(value: unknown): value is string {
	return (
		typeof value === "string" && value.trim() !== "" && value.length <= 500 && !value.includes("\0")
	);
}

function validTmdbId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalScopes(
	scopes: readonly JellyfinEpisodeCatalogScope[],
): Array<{ userId: string; libraryId: string }> | null {
	if (scopes.length > MAX_SCOPES) return null;
	const result: Array<{ userId: string; libraryId: string }> = [];
	const seen = new Set<string>();
	for (const scope of scopes) {
		if (!validId(scope.userId) || !validId(scope.libraryId)) return null;
		const key = `${scope.userId}\u0000${scope.libraryId}`;
		if (seen.has(key)) return null;
		seen.add(key);
		result.push({ userId: scope.userId, libraryId: scope.libraryId });
	}
	result.sort((a, b) => a.userId.localeCompare(b.userId) || a.libraryId.localeCompare(b.libraryId));
	return result;
}

function canonicalBindings(
	rows: readonly JellyfinLibraryRowFingerprintInput[],
): Array<{ libraryId: string; seriesId: string; tmdbId: number }> | null {
	if (rows.length > MAX_BINDINGS) return null;
	const bySource = new Map<string, number>();
	const byCanonical = new Map<string, string>();
	for (const row of rows) {
		if (row.mediaType !== "series") continue;
		if (!validId(row.libraryId) || !validId(row.jellyfinId) || !validTmdbId(row.tmdbId))
			return null;
		const sourceKey = `${row.libraryId}\u0000${row.jellyfinId}`;
		const priorTmdbId = bySource.get(sourceKey);
		if (priorTmdbId !== undefined && priorTmdbId !== row.tmdbId) return null;
		bySource.set(sourceKey, row.tmdbId);
		// Published episode rows are keyed by canonical TMDB coordinates. A
		// second provider series for the same canonical entity is ambiguous even
		// when it came from another Jellyfin library.
		const canonicalKey = String(row.tmdbId);
		const priorSource = byCanonical.get(canonicalKey);
		if (priorSource !== undefined && priorSource !== row.jellyfinId) return null;
		byCanonical.set(canonicalKey, row.jellyfinId);
	}
	const result = [...bySource].map(([key, tmdbId]) => {
		const separator = key.indexOf("\u0000");
		return { libraryId: key.slice(0, separator), seriesId: key.slice(separator + 1), tmdbId };
	});
	result.sort(
		(a, b) =>
			a.libraryId.localeCompare(b.libraryId) ||
			a.seriesId.localeCompare(b.seriesId) ||
			a.tmdbId - b.tmdbId,
	);
	return result;
}

function canonicalValue(value: JellyfinEpisodeCatalogProvenance): string {
	return JSON.stringify({ version: 3, bindings: value.bindings, scopes: value.scopes });
}

function digest(value: JellyfinEpisodeCatalogProvenance): string {
	return createHash("sha256").update(canonicalValue(value)).digest("hex");
}

function isCanonicalProvenance(value: unknown): value is JellyfinEpisodeCatalogProvenance {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<JellyfinEpisodeCatalogProvenance>;
	if (Object.keys(candidate).sort().join("\0") !== "bindings\0scopes\0version") return false;
	if (
		candidate.version !== 3 ||
		!Array.isArray(candidate.bindings) ||
		!Array.isArray(candidate.scopes)
	) {
		return false;
	}
	const bindings = candidate.bindings as unknown[];
	const scopes = candidate.scopes as unknown[];
	if (bindings.length > MAX_BINDINGS || scopes.length > MAX_SCOPES) return false;
	const seenBindings = new Set<string>();
	const seenCanonical = new Set<string>();
	for (const raw of bindings) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
		const binding = raw as Record<string, unknown>;
		if (Object.keys(binding).sort().join("\0") !== "libraryId\0seriesId\0tmdbId") return false;
		if (!validId(binding.libraryId) || !validId(binding.seriesId) || !validTmdbId(binding.tmdbId))
			return false;
		const sourceKey = `${binding.libraryId}\u0000${binding.seriesId}`;
		const canonicalKey = String(binding.tmdbId);
		if (seenBindings.has(sourceKey) || seenCanonical.has(canonicalKey)) return false;
		seenBindings.add(sourceKey);
		seenCanonical.add(canonicalKey);
	}
	const seenScopes = new Set<string>();
	for (const raw of scopes) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
		const scope = raw as Record<string, unknown>;
		if (Object.keys(scope).sort().join("\0") !== "libraryId\0userId") return false;
		if (!validId(scope.userId) || !validId(scope.libraryId)) return false;
		const key = `${scope.userId}\u0000${scope.libraryId}`;
		if (seenScopes.has(key)) return false;
		seenScopes.add(key);
	}
	const canonical = {
		version: 3 as const,
		bindings: [...(candidate.bindings as JellyfinEpisodeCatalogProvenance["bindings"])].sort(
			(a, b) =>
				a.libraryId.localeCompare(b.libraryId) ||
				a.seriesId.localeCompare(b.seriesId) ||
				a.tmdbId - b.tmdbId,
		),
		scopes: [...(candidate.scopes as JellyfinEpisodeCatalogProvenance["scopes"])].sort(
			(a, b) => a.userId.localeCompare(b.userId) || a.libraryId.localeCompare(b.libraryId),
		),
	};
	return (
		canonicalValue({
			version: 3,
			bindings: candidate.bindings as JellyfinEpisodeCatalogProvenance["bindings"],
			scopes: candidate.scopes as JellyfinEpisodeCatalogProvenance["scopes"],
		}) === canonicalValue(canonical)
	);
}

export function decodeJellyfinEpisodeCatalogProvenance(
	value: unknown,
): JellyfinEpisodeCatalogProvenance | null {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return null;
		}
	}
	return isCanonicalProvenance(parsed) ? parsed : null;
}

export function buildJellyfinEpisodeCatalogProvenance(
	rows: readonly JellyfinLibraryRowFingerprintInput[],
	scopes: readonly JellyfinEpisodeCatalogScope[],
): JellyfinEpisodeCatalogProvenance | null {
	const bindings = canonicalBindings(rows);
	const canonical = canonicalScopes(scopes);
	if (!bindings || !canonical || bindings.length === 0 || canonical.length === 0) return null;
	return { version: 3, bindings, scopes: canonical };
}

/**
 * Derives the immutable user/library scope set from the V2 parent receipt.
 * V1 receipts have no domain-qualified inventory scopes and are intentionally
 * not admitted to the V3 contract.
 */
export function jellyfinEpisodeCatalogScopesFromReceipt(
	receipt: ProviderCoverageReceipt,
): Array<{ userId: string; libraryId: string }> | null {
	if (receipt.version !== 2) return null;
	const inventory = receipt.domains.filter((domain) => domain.domain === "library-inventory");
	if (inventory.length !== 1) return null;
	const scopes: JellyfinEpisodeCatalogScope[] = [];
	for (const unit of inventory[0]!.units) {
		const match = /^user:([^/]+)\/library:([^/]+)\/inventory$/.exec(unit.scopeKey);
		if (!match) return null;
		scopes.push({ userId: match[1]!, libraryId: match[2]! });
	}
	return canonicalScopes(scopes);
}

export function isJellyfinEpisodeCatalogCompatible(
	provenance: unknown,
	currentRows: readonly JellyfinLibraryRowFingerprintInput[],
	currentScopes: readonly JellyfinEpisodeCatalogScope[],
): boolean {
	const decoded = decodeJellyfinEpisodeCatalogProvenance(provenance);
	if (!decoded) return false;
	const current = buildJellyfinEpisodeCatalogProvenance(currentRows, currentScopes);
	if (!current) return false;
	const currentBindings = new Map(
		current.bindings.map((binding) => [
			`${binding.libraryId}\u0000${binding.seriesId}`,
			binding.tmdbId,
		]),
	);
	for (const binding of decoded.bindings) {
		if (currentBindings.get(`${binding.libraryId}\u0000${binding.seriesId}`) !== binding.tmdbId)
			return false;
	}
	const expectedScopes = new Set(
		decoded.scopes.map((scope) => `${scope.userId}\u0000${scope.libraryId}`),
	);
	const actualScopes = new Set(
		current.scopes.map((scope) => `${scope.userId}\u0000${scope.libraryId}`),
	);
	return (
		expectedScopes.size === actualScopes.size &&
		[...expectedScopes].every((scope) => actualScopes.has(scope))
	);
}

export function jellyfinEpisodeCatalogGenerationKey(provenance: unknown): string | null {
	const decoded = decodeJellyfinEpisodeCatalogProvenance(provenance);
	return decoded ? `${JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX}${digest(decoded)}` : null;
}
