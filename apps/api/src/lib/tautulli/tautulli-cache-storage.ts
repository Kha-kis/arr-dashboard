import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "../services/provider-identity-guard.js";
import { decodeTautulliGenerationMetadata } from "./tautulli-generation-metadata.js";
import {
	createTautulliAggregateRoot,
	createTautulliGenerationObservationRoot,
	createTautulliTargetCatalogRoot,
	TAUTULLI_OBSERVATION_WRITE_CHUNK_SIZE,
	type TautulliAggregateGenerationRow,
	type TautulliGenerationObservation,
	type TautulliGenerationRoot,
} from "./tautulli-generation-observations.js";

export class TautulliRefreshAttemptSupersededError extends Error {
	constructor() {
		super("Tautulli cache refresh attempt was superseded");
		this.name = "TautulliRefreshAttemptSupersededError";
	}
}

type CreateManyTable<Row> = {
	deleteMany(input: { where: { instanceId: string } }): Promise<unknown>;
	createMany(input: { data: Row[] }): Promise<unknown>;
};

type TautulliPublicationTransaction<AggregateRow, ExactRow> = {
	cacheRefreshStatus: {
		updateMany(input: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}): Promise<{ count: number }>;
	};
	tautulliCache: CreateManyTable<AggregateRow>;
	tautulliGenerationObservation: CreateManyTable<ExactRow>;
};

function sameRoot(left: TautulliGenerationRoot, right: TautulliGenerationRoot): boolean {
	return (
		left.version === right.version && left.count === right.count && left.digest === right.digest
	);
}

function validatePublication(input: {
	instance: Pick<
		OwnedProviderPublicationSnapshot,
		"id" | "connectionGeneration" | "identityGeneration"
	>;
	generationId: string;
	generationMetadata: string;
	aggregateRows: readonly TautulliAggregateGenerationRow[];
	exactRows: readonly TautulliGenerationObservation[];
}): void {
	const decoded = decodeTautulliGenerationMetadata(input.generationMetadata);
	if (!decoded.ok) throw new Error("Invalid Tautulli generation publication");
	const metadata = decoded.metadata;
	const scope = {
		instanceId: input.instance.id,
		generationId: input.generationId,
		connectionGeneration: input.instance.connectionGeneration,
		identityGeneration: input.instance.identityGeneration,
	};
	try {
		const targetCatalog = createTautulliTargetCatalogRoot({ ...scope, rows: input.exactRows });
		const observations = createTautulliGenerationObservationRoot({
			...scope,
			rows: input.exactRows,
		});
		const aggregate = createTautulliAggregateRoot({ ...scope, rows: input.aggregateRows });
		if (
			metadata.generationId !== input.generationId ||
			metadata.connectionGeneration !== input.instance.connectionGeneration ||
			metadata.identityGeneration !== input.instance.identityGeneration ||
			!sameRoot(metadata.completeness.targetCatalog, targetCatalog) ||
			!sameRoot(metadata.completeness.observations, observations) ||
			!sameRoot(metadata.completeness.aggregate, aggregate)
		)
			throw new Error("Invalid Tautulli generation publication");
	} catch {
		throw new Error("Invalid Tautulli generation publication");
	}
}

export async function publishAuthoritativeTautulliGeneration<
	AggregateRow extends TautulliAggregateGenerationRow,
	ExactRow extends TautulliGenerationObservation,
>(
	tx: TautulliPublicationTransaction<AggregateRow, ExactRow>,
	input: {
		instance: Pick<
			OwnedProviderPublicationSnapshot,
			"id" | "connectionGeneration" | "identityGeneration"
		>;
		attempt: ProviderCacheRefreshAttempt;
		completedAt: Date;
		generationId: string;
		generationMetadata: string;
		aggregateRows: AggregateRow[];
		exactRows: ExactRow[];
		publicationLevel?: "authoritative" | "positive-only";
		reasonCode?: string;
	},
): Promise<void> {
	validatePublication(input);
	const partial = input.publicationLevel === "positive-only";
	const published = await tx.cacheRefreshStatus.updateMany({
		where: {
			instanceId: input.instance.id,
			cacheType: "tautulli",
			lastAttemptAt: input.attempt.attemptedAt,
			lastAttemptResult: input.attempt.resultMarker,
			connectionGeneration: input.instance.connectionGeneration,
			identityGeneration: input.instance.identityGeneration,
		},
		data: {
			lastRefreshedAt: input.completedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: input.aggregateRows.length,
			generationId: input.generationId,
			generationMetadata: input.generationMetadata,
			lastAttemptAt: input.completedAt,
			lastAttemptResult: partial ? "partial" : "success",
			lastAttemptErrorMessage: partial ? input.reasonCode : null,
			connectionGeneration: input.instance.connectionGeneration,
			identityGeneration: input.instance.identityGeneration,
		},
	});
	if (published.count !== 1) throw new TautulliRefreshAttemptSupersededError();

	await tx.tautulliCache.deleteMany({ where: { instanceId: input.instance.id } });
	await tx.tautulliGenerationObservation.deleteMany({ where: { instanceId: input.instance.id } });
	for (
		let start = 0;
		start < input.aggregateRows.length;
		start += TAUTULLI_OBSERVATION_WRITE_CHUNK_SIZE
	) {
		await tx.tautulliCache.createMany({
			data: input.aggregateRows.slice(start, start + TAUTULLI_OBSERVATION_WRITE_CHUNK_SIZE),
		});
	}
	for (
		let start = 0;
		start < input.exactRows.length;
		start += TAUTULLI_OBSERVATION_WRITE_CHUNK_SIZE
	) {
		await tx.tautulliGenerationObservation.createMany({
			data: input.exactRows.slice(start, start + TAUTULLI_OBSERVATION_WRITE_CHUNK_SIZE),
		});
	}
}
