/** Exact-evidence Tautulli cache collection and atomic publication. */

import { createHash, randomUUID } from "node:crypto";
import type { TautulliHistoryItem } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import {
	beginTautulliCacheRefreshAttempt,
	finishTautulliCacheRefreshAttemptFailure,
	type ProviderCacheRefreshAttempt,
} from "../services/provider-cache-status.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import {
	publishAuthoritativeTautulliGeneration,
	TautulliRefreshAttemptSupersededError,
} from "./tautulli-cache-storage.js";
import {
	createTautulliAggregateRoot,
	createTautulliGenerationObservationRoot,
	createTautulliTargetCatalogRoot,
	type TautulliGenerationObservation,
} from "./tautulli-generation-observations.js";
import {
	encodeTautulliGenerationMetadata,
	type TautulliReasonCode,
} from "./tautulli-generation-metadata.js";
import { TautulliClient } from "./tautulli-client.js";
import {
	collectStableTautulliTargetCatalog,
	type TautulliSupportedSection,
	TautulliEvidenceError,
} from "./tautulli-target-catalog.js";

const MAX_HISTORY_RESULTS = 100_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_HISTORY_REQUESTS = 1_000;
export const TAUTULLI_CACHE_PUBLICATION_CHUNK_SIZE = 100;

export interface TautulliCacheSnapshotRow {
	instanceId: string;
	generationId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	connectionGeneration: number;
	identityGeneration: number;
}

export interface TautulliCacheSnapshot {
	rows: TautulliCacheSnapshotRow[];
	exactObservations: TautulliGenerationObservation[];
}

export interface TautulliPublicationContext {
	prisma: PrismaClient;
	instance: OwnedProviderPublicationSnapshot;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
}

export interface OwnedTautulliRefreshContext {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
}

export type TautulliRefreshTerminalKind =
	| "published-authoritative"
	| "published-positive"
	| "unpublished"
	| "superseded";

export interface TautulliCacheRefreshResult {
	kind: TautulliRefreshTerminalKind;
	upserted: number;
	errors: number;
	errorMessages: string[];
	reasonCodes: TautulliReasonCode[];
	complete: boolean;
	completedAt?: Date;
	generationId?: string;
	publicationLevel?: "authoritative" | "positive-only";
	partialReasons?: Array<{ code: TautulliReasonCode; count: number }>;
	superseded?: boolean;
	snapshot?: TautulliCacheSnapshot;
}

export function createOwnedTautulliPublicationSnapshot(
	encryptor: Pick<Encryptor, "decrypt">,
	instance: ServiceInstance,
): OwnedProviderPublicationSnapshot {
	if (instance.service !== "TAUTULLI") {
		throw new Error("Tautulli publication requires a Tautulli service instance");
	}
	return {
		...createProviderPublicationAuthority(instance),
		label: instance.label,
		apiKey: encryptor.decrypt({ value: instance.encryptedApiKey, iv: instance.encryptionIv }),
		httpAuthHeaders: getStoredHttpAuthHeaders(encryptor, instance),
	};
}

function clientFor(
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
): TautulliClient {
	return new TautulliClient(
		instance.baseUrl,
		instance.apiKey,
		log,
		undefined,
		instance.httpAuthHeaders,
	);
}

function reasonFor(error: unknown): TautulliReasonCode {
	if (error instanceof TautulliEvidenceError) return error.code;
	if (
		error instanceof TautulliRefreshAttemptSupersededError ||
		(error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED")
	)
		return "publication_superseded";
	if (error instanceof ProviderIdentityGuardError) return "provider_identity_changed";
	return "unknown_failure";
}

function unpublished(reasonCode: TautulliReasonCode): TautulliCacheRefreshResult {
	return {
		kind: reasonCode === "publication_superseded" ? "superseded" : "unpublished",
		upserted: 0,
		errors: reasonCode === "publication_superseded" ? 0 : 1,
		errorMessages: [reasonCode],
		reasonCodes: [reasonCode],
		complete: false,
		...(reasonCode === "publication_superseded" ? { superseded: true } : {}),
	};
}

export function summarizeTautulliRefreshResultForLog(result: TautulliCacheRefreshResult) {
	return {
		terminalKind: result.kind,
		publicationLevel: result.publicationLevel ?? null,
		complete: result.complete,
		upserted: result.upserted,
		errors: result.errors,
		reasonCodes: [...(result.reasonCodes ?? [])],
		partialReasonCount: result.partialReasons?.reduce((sum, reason) => sum + reason.count, 0) ?? 0,
		publishedObservationCount: result.snapshot?.exactObservations.length ?? 0,
		aggregateObservedCount: result.snapshot?.rows.length ?? 0,
		superseded: result.kind === "superseded",
	};
}

export async function refreshTautulliCache(
	context: TautulliPublicationContext,
): Promise<TautulliCacheRefreshResult> {
	let attempt: ProviderCacheRefreshAttempt | null = null;
	try {
		attempt = await beginTautulliCacheRefreshAttempt(context.prisma, context.instance, {
			cleanupRunClaimToken: context.cleanupRunClaimToken,
		});
		if (!attempt) return unpublished("publication_superseded");
		return await refreshTautulliCacheWithAttempt(context, attempt);
	} catch (error) {
		return await rejectTautulliCacheRefresh(context, attempt, error);
	}
}

/** Acquire attempt ownership before decrypting credentials, then execute with that exact token. */
export async function refreshOwnedTautulliCache(
	context: OwnedTautulliRefreshContext,
): Promise<TautulliCacheRefreshResult> {
	const { prisma, instance, log } = context;
	const authority = createProviderPublicationAuthority(instance);
	let attempt: ProviderCacheRefreshAttempt | null = null;
	try {
		attempt = await beginTautulliCacheRefreshAttempt(prisma, authority, {
			cleanupRunClaimToken: context.cleanupRunClaimToken,
		});
		if (!attempt) return unpublished("publication_superseded");
	} catch (error) {
		log.error(
			{ instanceId: instance.id, reasonCode: reasonFor(error) },
			"Tautulli cache attempt could not be started",
		);
		return unpublished(reasonFor(error));
	}

	let publicationInstance: OwnedProviderPublicationSnapshot;
	try {
		publicationInstance = createOwnedTautulliPublicationSnapshot(context.encryptor, instance);
	} catch (error) {
		const finished = await finishTautulliCacheRefreshAttemptFailure(
			prisma,
			"credential_unavailable",
			authority,
			attempt,
			boundedAttemptLogger(log, instance.id),
			{ cleanupRunClaimToken: context.cleanupRunClaimToken },
		);
		if (finished === "superseded") return unpublished("publication_superseded");
		log.error(
			{ instanceId: instance.id, reasonCode: "credential_unavailable" },
			"Tautulli cache credential preparation failed",
		);
		return unpublished("credential_unavailable");
	}

	return await refreshTautulliCacheWithAttempt(
		{
			prisma,
			instance: publicationInstance,
			log,
			cleanupRunClaimToken: context.cleanupRunClaimToken,
		},
		attempt,
	);
}

async function refreshTautulliCacheWithAttempt(
	context: TautulliPublicationContext,
	attempt: ProviderCacheRefreshAttempt,
): Promise<TautulliCacheRefreshResult> {
	const { prisma, instance, log } = context;
	try {
		const generationId = randomUUID();
		return await withGuardedProviderPublication(
			prisma,
			instance,
			log,
			async () =>
				await collectTautulliCacheLiveEvidence(clientFor(instance, log), instance.id, log, {
					generationId,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
				}),
			async (tx, collected) =>
				await publishSnapshot(tx, instance, attempt, generationId, collected),
			{ cleanupRunClaimToken: context.cleanupRunClaimToken },
		);
	} catch (error) {
		return await rejectTautulliCacheRefresh(context, attempt, error);
	}
}

async function rejectTautulliCacheRefresh(
	context: TautulliPublicationContext,
	attempt: ProviderCacheRefreshAttempt | null,
	error: unknown,
): Promise<TautulliCacheRefreshResult> {
	const reasonCode = reasonFor(error);
	if (attempt && reasonCode !== "publication_superseded") {
		const finished = await finishTautulliCacheRefreshAttemptFailure(
			context.prisma,
			reasonCode,
			context.instance,
			attempt,
			context.log,
			{ cleanupRunClaimToken: context.cleanupRunClaimToken },
		);
		if (finished === "superseded") return unpublished("publication_superseded");
	}
	context.log.error(
		{ instanceId: context.instance.id, reasonCode },
		"Tautulli cache publication rejected",
	);
	return unpublished(reasonCode);
}

function boundedAttemptLogger(
	log: FastifyBaseLogger,
	instanceId: string,
): Pick<FastifyBaseLogger, "warn"> {
	return {
		warn: () =>
			log.warn(
				{ instanceId, reasonCode: "status_record_failed" },
				"Tautulli cache attempt status could not be finalized",
			),
	} as Pick<FastifyBaseLogger, "warn">;
}

async function publishSnapshot(
	tx: Prisma.TransactionClient,
	instance: OwnedProviderPublicationSnapshot,
	attempt: ProviderCacheRefreshAttempt,
	generationId: string,
	collected: TautulliCacheRefreshResult,
): Promise<TautulliCacheRefreshResult> {
	if (!collected.completedAt || !collected.snapshot || !collected.publicationLevel) {
		throw new TautulliEvidenceError(collected.reasonCodes[0] ?? "unknown_failure");
	}
	const scope = {
		instanceId: instance.id,
		generationId,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	};
	const targetCatalog = createTautulliTargetCatalogRoot({
		...scope,
		rows: collected.snapshot.exactObservations,
	});
	const observations = createTautulliGenerationObservationRoot({
		...scope,
		rows: collected.snapshot.exactObservations,
	});
	const aggregate = createTautulliAggregateRoot({ ...scope, rows: collected.snapshot.rows });
	const partialReasons = collected.partialReasons ?? [];
	const generationMetadata = encodeTautulliGenerationMetadata({
		version: 1,
		provider: "tautulli",
		generationId,
		publicationLevel: collected.publicationLevel,
		completeness: { targetCatalog, observations, aggregate },
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
		capabilities:
			collected.publicationLevel === "authoritative"
				? ["exact-target-observations"]
				: ["positive-watch-count"],
		partialReasons,
	});
	await publishAuthoritativeTautulliGeneration(tx as never, {
		instance,
		attempt,
		completedAt: collected.completedAt,
		generationId,
		generationMetadata,
		aggregateRows: collected.snapshot.rows,
		exactRows: collected.snapshot.exactObservations,
		publicationLevel: collected.publicationLevel,
		reasonCode: partialReasons[0]?.code,
	});
	return { ...collected, upserted: collected.snapshot.rows.length, generationId };
}

type HistoryUserMap = Map<string, Set<string>>;

function historySignature(item: TautulliHistoryItem): string {
	return JSON.stringify([
		item.row_id,
		item.rating_key,
		item.parent_rating_key,
		item.grandparent_rating_key,
		item.media_type,
		item.user,
		item.date,
		item.play_count ?? null,
	]);
}

function historyTargetRatingKey(item: TautulliHistoryItem): string {
	if (item.media_type === "movie") {
		if (!item.rating_key.trim()) throw new TautulliEvidenceError("history_partial");
		return item.rating_key;
	}
	if (item.media_type === "episode") {
		if (!item.parent_rating_key.trim() || !item.grandparent_rating_key.trim()) {
			throw new TautulliEvidenceError("history_partial");
		}
		return item.grandparent_rating_key;
	}
	throw new TautulliEvidenceError("history_partial");
}

async function collectHistoryPass(
	client: TautulliClient,
	targetRatingKeys: ReadonlySet<string>,
	sections: readonly TautulliSupportedSection[],
): Promise<{ users: HistoryUserMap; digest: string }> {
	const users: HistoryUserMap = new Map();
	const signatures: string[] = [];
	let totalRows = 0;
	let requests = 0;
	for (const section of sections) {
		let start = 0;
		let expectedTotal: number | undefined;
		let previousRowId = -1;
		const seen = new Set<number>();
		while (expectedTotal === undefined || start < expectedTotal) {
			if (++requests > MAX_HISTORY_REQUESTS) throw new TautulliEvidenceError("history_partial");
			let result;
			try {
				result = await client.getHistory({
					section_id: section.sectionId,
					start,
					length: HISTORY_PAGE_SIZE,
					order_column: "row_id",
					order_dir: "asc",
					grouping: 0,
					include_activity: 0,
				});
			} catch {
				throw new TautulliEvidenceError("history_partial");
			}
			if (
				!Number.isSafeInteger(result.recordsFiltered) ||
				result.recordsFiltered < 0 ||
				!Number.isSafeInteger(result.recordsTotal) ||
				result.recordsTotal < result.recordsFiltered
			)
				throw new TautulliEvidenceError("history_partial");
			if (expectedTotal === undefined) {
				expectedTotal = result.recordsFiltered;
				totalRows += expectedTotal;
				if (totalRows > MAX_HISTORY_RESULTS) throw new TautulliEvidenceError("history_partial");
			}
			if (result.recordsFiltered !== expectedTotal)
				throw new TautulliEvidenceError("history_changed");
			const expectedPage = Math.min(HISTORY_PAGE_SIZE, expectedTotal - start);
			if (result.data.length !== expectedPage) throw new TautulliEvidenceError("history_partial");
			for (const item of result.data) {
				if (
					(item.section_id !== undefined && item.section_id !== section.sectionId) ||
					(section.sectionType === "movie" && item.media_type !== "movie") ||
					(section.sectionType === "show" && item.media_type !== "episode")
				) {
					throw new TautulliEvidenceError("history_partial");
				}
				if (
					!Number.isSafeInteger(item.row_id) ||
					item.row_id === undefined ||
					item.row_id <= previousRowId ||
					seen.has(item.row_id)
				)
					throw new TautulliEvidenceError("history_changed");
				previousRowId = item.row_id;
				seen.add(item.row_id);
				signatures.push(historySignature(item));
				const ratingKey = historyTargetRatingKey(item);
				if (!targetRatingKeys.has(ratingKey)) continue;
				const values = users.get(ratingKey) ?? new Set<string>();
				values.add(item.user);
				users.set(ratingKey, values);
			}
			start += result.data.length;
		}
	}
	return {
		users,
		digest: createHash("sha256").update(JSON.stringify(signatures.sort()), "utf8").digest("hex"),
	};
}

function aggregateObservations(
	observations: TautulliGenerationObservation[],
	usersByRatingKey: HistoryUserMap,
): TautulliCacheSnapshotRow[] {
	const rows = new Map<string, TautulliCacheSnapshotRow & { users: Set<string> }>();
	for (const observation of observations) {
		if (observation.observedWatchCount === null) continue;
		const key = `${observation.mediaType}:${observation.tmdbId}`;
		const existing = rows.get(key);
		const users = usersByRatingKey.get(observation.ratingKey) ?? new Set<string>();
		if (existing) {
			existing.watchCount += observation.observedWatchCount ?? 0;
			if (
				observation.lastWatchedAt &&
				(!existing.lastWatchedAt || observation.lastWatchedAt > existing.lastWatchedAt)
			)
				existing.lastWatchedAt = observation.lastWatchedAt;
			for (const user of users) existing.users.add(user);
		} else {
			rows.set(key, {
				instanceId: observation.instanceId,
				generationId: observation.generationId,
				tmdbId: observation.tmdbId,
				mediaType: observation.mediaType,
				lastWatchedAt: observation.lastWatchedAt,
				watchCount: observation.observedWatchCount ?? 0,
				watchedByUsers: "[]",
				connectionGeneration: observation.connectionGeneration,
				identityGeneration: observation.identityGeneration,
				users: new Set(users),
			});
		}
	}
	return [...rows.values()]
		.map(({ users, ...row }) => ({ ...row, watchedByUsers: JSON.stringify([...users].sort()) }))
		.sort(
			(left, right) => left.mediaType.localeCompare(right.mediaType) || left.tmdbId - right.tmdbId,
		);
}

export async function collectTautulliCacheLiveEvidence(
	client: TautulliClient,
	instanceId: string,
	log: FastifyBaseLogger,
	scope: { generationId: string; connectionGeneration: number; identityGeneration: number } = {
		generationId: randomUUID(),
		connectionGeneration: 0,
		identityGeneration: 0,
	},
): Promise<TautulliCacheRefreshResult> {
	try {
		const catalog = await collectStableTautulliTargetCatalog(client, { instanceId, ...scope });
		const ratingKeys = new Set(catalog.observations.map((row) => row.ratingKey));
		const firstHistory = await collectHistoryPass(client, ratingKeys, catalog.sections);
		const secondHistory = await collectHistoryPass(client, ratingKeys, catalog.sections);
		if (firstHistory.digest !== secondHistory.digest) {
			throw new TautulliEvidenceError("history_changed");
		}
		const rows = aggregateObservations(catalog.observations, secondHistory.users);
		return {
			kind:
				catalog.publicationLevel === "authoritative"
					? "published-authoritative"
					: "published-positive",
			upserted: 0,
			errors: catalog.partialReasons.reduce((sum, reason) => sum + reason.count, 0),
			errorMessages: catalog.partialReasons.map((reason) => reason.code),
			reasonCodes: catalog.partialReasons.map((reason) => reason.code),
			complete: catalog.publicationLevel === "authoritative",
			completedAt: new Date(),
			generationId: scope.generationId,
			publicationLevel: catalog.publicationLevel,
			partialReasons: catalog.partialReasons,
			snapshot: { rows, exactObservations: catalog.observations },
		};
	} catch (error) {
		const reasonCode = reasonFor(error);
		log.warn({ instanceId, reasonCode }, "Tautulli exact evidence collection failed closed");
		return unpublished(reasonCode);
	}
}
