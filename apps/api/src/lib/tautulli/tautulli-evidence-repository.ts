import type { PrismaClientInstance } from "../prisma.js";
import { isCanonicalTautulliNonNegativeSafeInteger } from "./tautulli-canonical-numbers.js";
import {
	evaluateTautulliExactPublication,
	evaluateTautulliPositivePublication,
} from "./tautulli-generation-metadata.js";
import {
	createTautulliAggregateRoot,
	createTautulliGenerationObservationRoot,
	createTautulliTargetCatalogRoot,
	normalizeTautulliGenerationObservations,
	TAUTULLI_OBSERVATION_READ_PAGE_SIZE,
	type TautulliAggregateGenerationRow,
	type TautulliGenerationObservation,
	type TautulliGenerationRoot,
} from "./tautulli-generation-observations.js";

type TautulliEvidencePrisma = Pick<
	PrismaClientInstance,
	"tautulliCache" | "tautulliGenerationObservation"
>;

type Scope = Pick<
	TautulliGenerationObservation,
	"instanceId" | "generationId" | "connectionGeneration" | "identityGeneration"
>;

type PersistedRoots = {
	targetCatalog: TautulliGenerationRoot;
	observations: TautulliGenerationRoot;
	aggregate: TautulliGenerationRoot;
};

async function readExactRows(prisma: TautulliEvidencePrisma, instanceId: string) {
	const rows: Array<TautulliGenerationObservation & { id: string }> = [];
	let cursor: string | undefined;
	while (true) {
		const page = await prisma.tautulliGenerationObservation.findMany({
			where: { instanceId },
			select: {
				id: true,
				instanceId: true,
				generationId: true,
				sectionId: true,
				ratingKey: true,
				providerGuidFingerprint: true,
				mediaType: true,
				tmdbId: true,
				observedWatchCount: true,
				lastWatchedAt: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
			orderBy: { id: "asc" },
			take: TAUTULLI_OBSERVATION_READ_PAGE_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
		});
		rows.push(...(page as Array<TautulliGenerationObservation & { id: string }>));
		if (page.length < TAUTULLI_OBSERVATION_READ_PAGE_SIZE) break;
		cursor = page[page.length - 1]!.id;
	}
	return rows;
}

async function readAggregateRows(prisma: TautulliEvidencePrisma, instanceId: string) {
	const rows: Array<TautulliAggregateGenerationRow & { id: string }> = [];
	let cursor: string | undefined;
	while (true) {
		const page = await prisma.tautulliCache.findMany({
			where: { instanceId },
			select: {
				id: true,
				instanceId: true,
				generationId: true,
				tmdbId: true,
				mediaType: true,
				lastWatchedAt: true,
				watchCount: true,
				watchedByUsers: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
			orderBy: { id: "asc" },
			take: TAUTULLI_OBSERVATION_READ_PAGE_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
		});
		rows.push(...(page as unknown as Array<TautulliAggregateGenerationRow & { id: string }>));
		if (page.length < TAUTULLI_OBSERVATION_READ_PAGE_SIZE) break;
		cursor = page[page.length - 1]!.id;
	}
	return rows;
}

function sameRoot(actual: TautulliGenerationRoot, expected: TautulliGenerationRoot): boolean {
	return (
		isCanonicalTautulliNonNegativeSafeInteger(actual.count) &&
		isCanonicalTautulliNonNegativeSafeInteger(expected.count) &&
		actual.version === expected.version &&
		actual.count === expected.count &&
		actual.digest === expected.digest
	);
}

export async function loadPersistedTautulliGeneration(
	prisma: TautulliEvidencePrisma,
	input: Scope & { expected: PersistedRoots },
): Promise<
	| {
			ok: true;
			exactRows: TautulliGenerationObservation[];
			aggregateRows: TautulliAggregateGenerationRow[];
	  }
	| { ok: false; reasonCode: "publication_integrity_mismatch" }
> {
	try {
		const [storedExactRows, storedAggregateRows] = await Promise.all([
			readExactRows(prisma, input.instanceId),
			readAggregateRows(prisma, input.instanceId),
		]);
		const exactRows = normalizeTautulliGenerationObservations(storedExactRows, input);
		const aggregateRows = storedAggregateRows.map(({ id: _id, ...row }) => row);
		const targetCatalog = createTautulliTargetCatalogRoot({ ...input, rows: exactRows });
		const observations = createTautulliGenerationObservationRoot({ ...input, rows: exactRows });
		const aggregate = createTautulliAggregateRoot({ ...input, rows: aggregateRows });
		if (
			!sameRoot(targetCatalog, input.expected.targetCatalog) ||
			!sameRoot(observations, input.expected.observations) ||
			!sameRoot(aggregate, input.expected.aggregate)
		) {
			return { ok: false, reasonCode: "publication_integrity_mismatch" };
		}
		return { ok: true, exactRows, aggregateRows };
	} catch {
		return { ok: false, reasonCode: "publication_integrity_mismatch" };
	}
}

type PublicationStatus = Parameters<typeof evaluateTautulliExactPublication>[0];
type PublicationAuthority = Parameters<typeof evaluateTautulliExactPublication>[1];

export async function loadExactTautulliEvidence(
	prisma: TautulliEvidencePrisma,
	input: { instanceId: string; status: PublicationStatus; authority: PublicationAuthority },
) {
	const publication = evaluateTautulliExactPublication(input.status, input.authority);
	if (!publication.available) return publication;
	const persisted = await loadPersistedTautulliGeneration(prisma, {
		instanceId: input.instanceId,
		generationId: publication.metadata.generationId,
		connectionGeneration: publication.metadata.connectionGeneration,
		identityGeneration: publication.metadata.identityGeneration,
		expected: publication.metadata.completeness,
	});
	return persisted.ok
		? { available: true as const, rows: persisted.exactRows, metadata: publication.metadata }
		: { available: false as const, reasonCode: persisted.reasonCode };
}

export async function loadPositiveTautulliEvidence(
	prisma: TautulliEvidencePrisma,
	input: { instanceId: string; status: PublicationStatus; authority: PublicationAuthority },
) {
	const publication = evaluateTautulliPositivePublication(input.status, input.authority);
	if (!publication.available) return publication;
	const persisted = await loadPersistedTautulliGeneration(prisma, {
		instanceId: input.instanceId,
		generationId: publication.metadata.generationId,
		connectionGeneration: publication.metadata.connectionGeneration,
		identityGeneration: publication.metadata.identityGeneration,
		expected: publication.metadata.completeness,
	});
	if (!persisted.ok) return { available: false as const, reasonCode: persisted.reasonCode };
	return {
		available: true as const,
		rows: persisted.exactRows
			.filter((row) => row.observedWatchCount !== null && row.observedWatchCount > 0)
			.map((row) => ({
				mediaType: row.mediaType,
				tmdbId: row.tmdbId,
				observedWatchCount: row.observedWatchCount!,
				lastWatchedAt: row.lastWatchedAt,
			})),
		metadata: publication.metadata,
	};
}
