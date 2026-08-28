import { createHash } from "node:crypto";
import { isCanonicalTautulliNonNegativeSafeInteger } from "./tautulli-canonical-numbers.js";

export const TAUTULLI_GENERATION_ROOT_VERSION = 1 as const;
export const TAUTULLI_OBSERVATION_WRITE_CHUNK_SIZE = 100;
export const TAUTULLI_OBSERVATION_READ_PAGE_SIZE = 500;

export type TautulliGenerationRoot = {
	version: typeof TAUTULLI_GENERATION_ROOT_VERSION;
	count: number;
	digest: string;
};

export type TautulliGenerationObservation = {
	instanceId: string;
	generationId: string;
	sectionId: string;
	ratingKey: string;
	providerGuidFingerprint: string;
	mediaType: "movie" | "series";
	tmdbId: number;
	observedWatchCount: number | null;
	lastWatchedAt: Date | null;
	connectionGeneration: number;
	identityGeneration: number;
};

export type TautulliAggregateGenerationRow = {
	instanceId: string;
	generationId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	connectionGeneration: number;
	identityGeneration: number;
};

type Scope = Pick<
	TautulliGenerationObservation,
	"instanceId" | "generationId" | "connectionGeneration" | "identityGeneration"
>;

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function nonnegative(value: unknown): value is number {
	return isCanonicalTautulliNonNegativeSafeInteger(value);
}

function positive(value: unknown): value is number {
	return isCanonicalTautulliNonNegativeSafeInteger(value) && value > 0;
}

function validScope(scope: Scope): boolean {
	return (
		nonempty(scope.instanceId) &&
		nonempty(scope.generationId) &&
		nonnegative(scope.connectionGeneration) &&
		nonnegative(scope.identityGeneration)
	);
}

function compare(
	left: TautulliGenerationObservation,
	right: TautulliGenerationObservation,
): number {
	return (
		left.sectionId.localeCompare(right.sectionId) ||
		left.ratingKey.localeCompare(right.ratingKey) ||
		left.mediaType.localeCompare(right.mediaType) ||
		left.tmdbId - right.tmdbId ||
		left.providerGuidFingerprint.localeCompare(right.providerGuidFingerprint)
	);
}

function canonical(row: TautulliGenerationObservation) {
	return {
		sectionId: row.sectionId,
		ratingKey: row.ratingKey,
		providerGuidFingerprint: row.providerGuidFingerprint,
		mediaType: row.mediaType,
		tmdbId: row.tmdbId,
		observedWatchCount: row.observedWatchCount,
		lastWatchedAt: row.lastWatchedAt?.toISOString() ?? null,
	};
}

export function normalizeTautulliGenerationObservations(
	rows: readonly TautulliGenerationObservation[],
	scope?: Scope,
): TautulliGenerationObservation[] {
	const seen = new Set<string>();
	const normalized: TautulliGenerationObservation[] = [];
	for (const row of rows) {
		if (
			!nonempty(row.instanceId) ||
			!nonempty(row.generationId) ||
			!nonempty(row.sectionId) ||
			!nonempty(row.ratingKey) ||
			!/^[a-f0-9]{64}$/.test(row.providerGuidFingerprint) ||
			(row.mediaType !== "movie" && row.mediaType !== "series") ||
			!positive(row.tmdbId) ||
			(row.observedWatchCount !== null && !nonnegative(row.observedWatchCount)) ||
			(row.lastWatchedAt !== null && !Number.isFinite(row.lastWatchedAt.getTime())) ||
			!nonnegative(row.connectionGeneration) ||
			!nonnegative(row.identityGeneration)
		) {
			throw new Error("Invalid Tautulli generation observation");
		}
		if (
			scope &&
			(row.instanceId !== scope.instanceId ||
				row.generationId !== scope.generationId ||
				row.connectionGeneration !== scope.connectionGeneration ||
				row.identityGeneration !== scope.identityGeneration)
		) {
			throw new Error("Tautulli generation observation did not match its publication scope");
		}
		if (seen.has(row.ratingKey)) {
			throw new Error("Tautulli generation observation contained a duplicate rating key");
		}
		seen.add(row.ratingKey);
		normalized.push({ ...row });
	}
	return normalized.sort(compare);
}

export function createTautulliGenerationObservationRoot(
	input: Scope & { rows: readonly TautulliGenerationObservation[] },
): TautulliGenerationRoot {
	if (!validScope(input)) {
		throw new Error("Invalid Tautulli observation digest scope");
	}
	const rows = normalizeTautulliGenerationObservations(input.rows, input);
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				version: TAUTULLI_GENERATION_ROOT_VERSION,
				instanceId: input.instanceId,
				generationId: input.generationId,
				connectionGeneration: input.connectionGeneration,
				identityGeneration: input.identityGeneration,
				rows: rows.map(canonical),
			}),
			"utf8",
		)
		.digest("hex");
	return { version: TAUTULLI_GENERATION_ROOT_VERSION, count: rows.length, digest };
}

function createScopedRoot(input: Scope, rows: readonly unknown[]): TautulliGenerationRoot {
	if (!validScope(input)) throw new Error("Invalid Tautulli generation root scope");
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				version: TAUTULLI_GENERATION_ROOT_VERSION,
				instanceId: input.instanceId,
				generationId: input.generationId,
				connectionGeneration: input.connectionGeneration,
				identityGeneration: input.identityGeneration,
				rows,
			}),
			"utf8",
		)
		.digest("hex");
	return { version: TAUTULLI_GENERATION_ROOT_VERSION, count: rows.length, digest };
}

export function createTautulliTargetCatalogRoot(
	input: Scope & { rows: readonly TautulliGenerationObservation[] },
): TautulliGenerationRoot {
	const rows = normalizeTautulliGenerationObservations(input.rows, input).map((row) => ({
		sectionId: row.sectionId,
		ratingKey: row.ratingKey,
		providerGuidFingerprint: row.providerGuidFingerprint,
		mediaType: row.mediaType,
		tmdbId: row.tmdbId,
	}));
	return createScopedRoot(input, rows);
}

export function createTautulliAggregateRoot(
	input: Scope & { rows: readonly TautulliAggregateGenerationRow[] },
): TautulliGenerationRoot {
	const seen = new Set<string>();
	const rows = [...input.rows]
		.map((row) => {
			if (
				row.instanceId !== input.instanceId ||
				row.generationId !== input.generationId ||
				row.connectionGeneration !== input.connectionGeneration ||
				row.identityGeneration !== input.identityGeneration ||
				(row.mediaType !== "movie" && row.mediaType !== "series") ||
				!positive(row.tmdbId) ||
				!nonnegative(row.watchCount) ||
				(row.lastWatchedAt !== null && !Number.isFinite(row.lastWatchedAt.getTime()))
			)
				throw new Error("Invalid Tautulli aggregate generation row");
			const key = `${row.mediaType}:${row.tmdbId}`;
			if (seen.has(key)) throw new Error("Duplicate Tautulli aggregate generation row");
			seen.add(key);
			let users: unknown;
			try {
				users = JSON.parse(row.watchedByUsers);
			} catch {
				throw new Error("Invalid Tautulli aggregate users");
			}
			if (!Array.isArray(users) || users.some((user) => typeof user !== "string"))
				throw new Error("Invalid Tautulli aggregate users");
			return {
				mediaType: row.mediaType,
				tmdbId: row.tmdbId,
				lastWatchedAt: row.lastWatchedAt?.toISOString() ?? null,
				watchCount: row.watchCount,
				watchedByUsers: [...new Set(users)].sort(),
			};
		})
		.sort(
			(left, right) => left.mediaType.localeCompare(right.mediaType) || left.tmdbId - right.tmdbId,
		);
	return createScopedRoot(input, rows);
}

export function verifyTautulliGenerationObservationIntegrity(
	input: Scope & {
		expected: TautulliGenerationRoot;
		rows: readonly TautulliGenerationObservation[];
	},
): { ok: true; rows: TautulliGenerationObservation[] } | { ok: false } {
	try {
		const rows = normalizeTautulliGenerationObservations(input.rows, input);
		if (rows.length !== input.expected.count) return { ok: false };
		const root = createTautulliGenerationObservationRoot({ ...input, rows });
		return root.version === input.expected.version && root.digest === input.expected.digest
			? { ok: true, rows }
			: { ok: false };
	} catch {
		return { ok: false };
	}
}
