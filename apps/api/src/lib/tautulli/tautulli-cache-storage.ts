import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "../services/provider-identity-guard.js";
import { TAUTULLI_OBSERVATION_WRITE_CHUNK_SIZE } from "./tautulli-generation-observations.js";

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

export async function publishAuthoritativeTautulliGeneration<AggregateRow, ExactRow>(
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
			lastResult: partial ? "partial" : "success",
			lastErrorMessage: partial ? input.reasonCode : null,
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
