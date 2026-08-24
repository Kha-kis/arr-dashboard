import { createHash } from "node:crypto";
import type { PrismaClientInstance } from "../prisma.js";

export const PLEX_TARGET_LEDGER_VERSION = 1 as const;
export const PLEX_TARGET_LEDGER_WRITE_CHUNK_SIZE = 100;
export const PLEX_TARGET_LEDGER_READ_PAGE_SIZE = 500;

export type PlexGenerationTarget = {
	instanceId: string;
	generationId: string;
	sectionId: string;
	sectionUuid: string;
	mediaType: "movie" | "series";
	tmdbId: number;
	tvdbId: number | null;
	ratingKey: string;
};

export type PlexTargetLedgerBinding = {
	targetLedgerVersion: typeof PLEX_TARGET_LEDGER_VERSION;
	targetCount: number;
	targetDigest: string;
};

type Scope = Pick<PlexGenerationTarget, "instanceId" | "generationId">;
type DigestContext = Scope & { connectionGeneration: number; identityGeneration: number };

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegative(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compare(left: PlexGenerationTarget, right: PlexGenerationTarget): number {
	return (
		left.sectionId.localeCompare(right.sectionId) ||
		left.sectionUuid.localeCompare(right.sectionUuid) ||
		left.mediaType.localeCompare(right.mediaType) ||
		left.tmdbId - right.tmdbId ||
		(left.tvdbId ?? -1) - (right.tvdbId ?? -1) ||
		left.ratingKey.localeCompare(right.ratingKey)
	);
}

function digestTarget(target: PlexGenerationTarget) {
	return {
		sectionId: target.sectionId,
		sectionUuid: target.sectionUuid,
		mediaType: target.mediaType,
		tmdbId: target.tmdbId,
		tvdbId: target.tvdbId,
		ratingKey: target.ratingKey,
	};
}

/** Validates exact provider identity without ever collapsing duplicate TMDB IDs. */
export function normalizePlexGenerationTargets(
	targets: readonly (
		| PlexGenerationTarget
		| (Omit<PlexGenerationTarget, "tvdbId"> & { tvdbId?: number | null })
	)[],
	scope?: Scope,
): PlexGenerationTarget[] {
	const seenRatingKeys = new Set<string>();
	const normalized: PlexGenerationTarget[] = [];
	for (const raw of targets) {
		const target = { ...raw, tvdbId: raw.tvdbId ?? null };
		if (
			!nonempty(target.instanceId) ||
			!nonempty(target.generationId) ||
			!nonempty(target.sectionId) ||
			!nonempty(target.sectionUuid) ||
			(target.mediaType !== "movie" && target.mediaType !== "series") ||
			!positive(target.tmdbId) ||
			(target.tvdbId !== null && !positive(target.tvdbId)) ||
			!nonempty(target.ratingKey)
		) {
			throw new Error("Invalid Plex generation target");
		}
		if (
			scope &&
			(target.instanceId !== scope.instanceId || target.generationId !== scope.generationId)
		) {
			throw new Error("Plex generation target did not match its publication scope");
		}
		if (seenRatingKeys.has(target.ratingKey))
			throw new Error("Duplicate Plex generation target rating key");
		seenRatingKeys.add(target.ratingKey);
		normalized.push(target);
	}
	return normalized.sort(compare);
}

export function calculatePlexGenerationTargetDigest(
	input: DigestContext & { targets: readonly PlexGenerationTarget[] },
): string {
	if (
		!nonempty(input.instanceId) ||
		!nonempty(input.generationId) ||
		!nonnegative(input.connectionGeneration) ||
		!nonnegative(input.identityGeneration)
	) {
		throw new Error("Invalid Plex generation target digest binding");
	}
	const targets = normalizePlexGenerationTargets(input.targets, input);
	return createHash("sha256")
		.update(
			JSON.stringify({
				ledgerVersion: PLEX_TARGET_LEDGER_VERSION,
				instanceId: input.instanceId,
				generationId: input.generationId,
				connectionGeneration: input.connectionGeneration,
				identityGeneration: input.identityGeneration,
				targets: targets.map(digestTarget),
			}),
			"utf8",
		)
		.digest("hex");
}

export function createPlexTargetLedgerBinding(
	input: DigestContext & { targets: readonly PlexGenerationTarget[] },
): PlexTargetLedgerBinding {
	const targets = normalizePlexGenerationTargets(input.targets, input);
	return {
		targetLedgerVersion: PLEX_TARGET_LEDGER_VERSION,
		targetCount: targets.length,
		targetDigest: calculatePlexGenerationTargetDigest({ ...input, targets }),
	};
}

export function decodePlexTargetLedgerBinding(
	value: unknown,
): { ok: true; binding: PlexTargetLedgerBinding | null } | { ok: false } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
	const record = value as Record<string, unknown>;
	const fields = [record.targetLedgerVersion, record.targetCount, record.targetDigest];
	if (fields.every((field) => field === undefined)) return { ok: true, binding: null };
	if (fields.some((field) => field === undefined)) return { ok: false };
	if (
		record.targetLedgerVersion !== PLEX_TARGET_LEDGER_VERSION ||
		!nonnegative(record.targetCount) ||
		typeof record.targetDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.targetDigest)
	)
		return { ok: false };
	return {
		ok: true,
		binding: {
			targetLedgerVersion: 1,
			targetCount: record.targetCount,
			targetDigest: record.targetDigest,
		},
	};
}

export function requirePlexTargetLedgerBinding(
	value: unknown,
): { ok: true; binding: PlexTargetLedgerBinding } | { ok: false } {
	const decoded = decodePlexTargetLedgerBinding(value);
	return decoded.ok && decoded.binding ? { ok: true, binding: decoded.binding } : { ok: false };
}

export function validatePlexGenerationTargetSections(
	targets: readonly PlexGenerationTarget[],
	sections: readonly { key: string; uuid: string; type: "movie" | "show" }[],
): { ok: true } | { ok: false } {
	const catalog = new Map(sections.map((section) => [section.key, section]));
	for (const target of targets) {
		const section = catalog.get(target.sectionId);
		if (
			!section ||
			section.uuid !== target.sectionUuid ||
			(section.type === "movie" ? "movie" : "series") !== target.mediaType
		)
			return { ok: false };
	}
	return { ok: true };
}

export function verifyPlexGenerationTargetIntegrity(input: {
	targets: readonly PlexGenerationTarget[];
	expected: DigestContext & PlexTargetLedgerBinding;
	sections?: readonly { key: string; uuid: string; type: "movie" | "show" }[];
}): { ok: true; targets: PlexGenerationTarget[] } | { ok: false; reason: string } {
	try {
		const targets = normalizePlexGenerationTargets(input.targets, input.expected);
		if (targets.length !== input.expected.targetCount)
			return { ok: false, reason: "target_count_mismatch" };
		if (
			calculatePlexGenerationTargetDigest({ ...input.expected, targets }) !==
			input.expected.targetDigest
		)
			return { ok: false, reason: "target_digest_mismatch" };
		if (input.sections && !validatePlexGenerationTargetSections(targets, input.sections).ok)
			return { ok: false, reason: "target_section_mismatch" };
		return { ok: true, targets };
	} catch {
		return { ok: false, reason: "target_ledger_invalid" };
	}
}

export function samePlexGenerationTargetSet(
	left: readonly PlexGenerationTarget[],
	right: readonly PlexGenerationTarget[],
): boolean {
	try {
		return (
			JSON.stringify(normalizePlexGenerationTargets(left).map(digestTarget)) ===
			JSON.stringify(normalizePlexGenerationTargets(right).map(digestTarget))
		);
	} catch {
		return false;
	}
}

export function selectSinglePlexGenerationTarget(
	targets: readonly PlexGenerationTarget[],
): { ok: true; target: PlexGenerationTarget } | { ok: false } {
	try {
		const normalized = normalizePlexGenerationTargets(targets);
		return normalized.length === 1 ? { ok: true, target: normalized[0]! } : { ok: false };
	} catch {
		return { ok: false };
	}
}

export function samePlexGenerationBinding(
	left: Pick<DigestContext, "connectionGeneration" | "identityGeneration">,
	right: Pick<DigestContext, "connectionGeneration" | "identityGeneration">,
): boolean {
	return (
		left.connectionGeneration === right.connectionGeneration &&
		left.identityGeneration === right.identityGeneration
	);
}

export async function replacePlexGenerationTargets(
	tx: Pick<PrismaClientInstance, "plexGenerationTarget">,
	input: Scope & { targets: readonly PlexGenerationTarget[] },
): Promise<void> {
	const targets = normalizePlexGenerationTargets(input.targets, input);
	await tx.plexGenerationTarget.deleteMany({ where: { instanceId: input.instanceId } });
	for (let offset = 0; offset < targets.length; offset += PLEX_TARGET_LEDGER_WRITE_CHUNK_SIZE) {
		await tx.plexGenerationTarget.createMany({
			data: targets.slice(offset, offset + PLEX_TARGET_LEDGER_WRITE_CHUNK_SIZE),
		});
	}
}

export async function readPlexGenerationTargets(
	prisma: Pick<PrismaClientInstance, "plexGenerationTarget">,
	scope: Scope,
): Promise<PlexGenerationTarget[]> {
	return await readPlexGenerationTargetsForSelection(prisma, scope);
}

/** Reads only the exact logical targets a caller needs, in bounded pages. */
export async function readPlexGenerationTargetsForSelection(
	prisma: Pick<PrismaClientInstance, "plexGenerationTarget">,
	scope: Scope,
	selection?: readonly Pick<PlexGenerationTarget, "mediaType" | "tmdbId">[],
): Promise<PlexGenerationTarget[]> {
	const targets: PlexGenerationTarget[] = [];
	const requested = selection
		? [
				...new Map(
					selection.map((target) => [`${target.mediaType}:${target.tmdbId}`, target]),
				).values(),
			]
		: undefined;
	if (requested?.length === 0) return targets;
	let cursor: string | undefined;
	while (true) {
		const page = await prisma.plexGenerationTarget.findMany({
			where: requested ? { ...scope, OR: requested } : scope,
			select: {
				id: true,
				instanceId: true,
				generationId: true,
				sectionId: true,
				sectionUuid: true,
				mediaType: true,
				tmdbId: true,
				tvdbId: true,
				ratingKey: true,
			},
			take: PLEX_TARGET_LEDGER_READ_PAGE_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: [
				{ sectionId: "asc" },
				{ sectionUuid: "asc" },
				{ mediaType: "asc" },
				{ tmdbId: "asc" },
				{ tvdbId: { sort: "asc", nulls: "first" } },
				{ ratingKey: "asc" },
				{ id: "asc" },
			],
		});
		if (page.length === 0) return normalizePlexGenerationTargets(targets, scope);
		if (page.length > PLEX_TARGET_LEDGER_READ_PAGE_SIZE)
			throw new Error("Plex generation target page exceeded its bound");
		targets.push(...page.map(({ id: _id, ...target }) => target as PlexGenerationTarget));
		cursor = page.at(-1)!.id;
		if (page.length < PLEX_TARGET_LEDGER_READ_PAGE_SIZE)
			return normalizePlexGenerationTargets(targets, scope);
	}
}

export async function verifyPersistedPlexGenerationTargets(
	prisma: Pick<PrismaClientInstance, "plexGenerationTarget">,
	input: {
		expected: DigestContext & PlexTargetLedgerBinding;
		sections: readonly { key: string; uuid: string; type: "movie" | "show" }[];
	},
) {
	try {
		const seenRatingKeys = new Set<string>();
		const digest = createHash("sha256");
		const envelope = JSON.stringify({
			ledgerVersion: PLEX_TARGET_LEDGER_VERSION,
			instanceId: input.expected.instanceId,
			generationId: input.expected.generationId,
			connectionGeneration: input.expected.connectionGeneration,
			identityGeneration: input.expected.identityGeneration,
			targets: [],
		});
		digest.update(envelope.slice(0, -2), "utf8");
		let count = 0;
		let first = true;
		let previous: PlexGenerationTarget | undefined;
		let cursor: string | undefined;
		while (true) {
			const page = await prisma.plexGenerationTarget.findMany({
				where: { instanceId: input.expected.instanceId },
				select: {
					id: true,
					instanceId: true,
					generationId: true,
					sectionId: true,
					sectionUuid: true,
					mediaType: true,
					tmdbId: true,
					tvdbId: true,
					ratingKey: true,
				},
				take: PLEX_TARGET_LEDGER_READ_PAGE_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: [
					{ sectionId: "asc" },
					{ sectionUuid: "asc" },
					{ mediaType: "asc" },
					{ tmdbId: "asc" },
					{ tvdbId: { sort: "asc", nulls: "first" } },
					{ ratingKey: "asc" },
					{ id: "asc" },
				],
			});
			if (page.length === 0) break;
			if (page.length > PLEX_TARGET_LEDGER_READ_PAGE_SIZE)
				return { ok: false as const, reason: "target_ledger_invalid" };
			for (const { id: _id, ...raw } of page) {
				const target = normalizePlexGenerationTargets(
					[raw as PlexGenerationTarget],
					input.expected,
				)[0]!;
				if (previous && compare(previous, target) > 0)
					return { ok: false as const, reason: "target_ledger_invalid" };
				if (seenRatingKeys.has(target.ratingKey))
					return { ok: false as const, reason: "target_ledger_invalid" };
				if (!validatePlexGenerationTargetSections([target], input.sections).ok)
					return { ok: false as const, reason: "target_section_mismatch" };
				if (!first) digest.update(",", "utf8");
				digest.update(JSON.stringify(digestTarget(target)), "utf8");
				first = false;
				previous = target;
				seenRatingKeys.add(target.ratingKey);
				count++;
			}
			cursor = page.at(-1)!.id;
			if (page.length < PLEX_TARGET_LEDGER_READ_PAGE_SIZE) break;
		}
		digest.update("]}", "utf8");
		if (count !== input.expected.targetCount)
			return { ok: false as const, reason: "target_count_mismatch" };
		return digest.digest("hex") === input.expected.targetDigest
			? { ok: true as const }
			: { ok: false as const, reason: "target_digest_mismatch" };
	} catch {
		return { ok: false as const, reason: "target_ledger_unavailable" };
	}
}
