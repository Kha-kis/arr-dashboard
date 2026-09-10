/** Publish bounded, positive-only Tautulli watch observations. */

import type { ProviderCoverageReceiptV1, ProviderObservationReasonCode } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import {
	type ProviderObservationAttemptInput,
	type ProviderObservationAttemptPublication,
	ProviderObservationCoordinatorError,
	runClaimedProviderObservationAttempt,
	runProviderObservationAttempt,
} from "../provider-observation/coordinator.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	type ProviderIdentityGuardOptions,
	type ProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";
import { TautulliClient } from "./tautulli-client.js";
import { encodeTautulliObservationMetadata } from "./tautulli-observation-metadata.js";
import {
	collectTautulliPositiveObservations,
	type TautulliPositiveObservationCollection,
	TautulliPositiveObservationError,
	type TautulliPositiveObservationRow,
} from "./tautulli-positive-observation-collector.js";

export const TAUTULLI_CACHE_PUBLICATION_CHUNK_SIZE = 100;
export const TAUTULLI_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS = 60_000;

export interface OwnedTautulliCacheRefreshContext {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
}

export type TautulliCacheRefreshResult =
	| {
			kind: "positive-observation";
			complete: false;
			upserted: number;
			errors: 0;
			errorMessages: [];
			completedAt: Date;
			receipt: ProviderCoverageReceiptV1;
			superseded?: false;
	  }
	| {
			kind: "unpublished";
			complete: false;
			upserted: 0;
			errors: 0 | 1;
			errorMessages: ProviderObservationReasonCode[];
			completedAt?: never;
			receipt?: never;
			superseded?: boolean;
	  };

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

function tautulliClientForSnapshot(
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

/** Own the durable attempt before decrypting credentials or contacting Tautulli. */
export async function refreshOwnedTautulliCache(
	context: OwnedTautulliCacheRefreshContext,
): Promise<TautulliCacheRefreshResult> {
	return await runOwnedTautulliCacheAttempt(context);
}

/** Continue a Tautulli refresh with the caller's exact durable claim. */
export async function refreshOwnedTautulliCacheWithAttempt(
	context: OwnedTautulliCacheRefreshContext,
	attempt: ProviderCacheRefreshAttempt,
): Promise<TautulliCacheRefreshResult> {
	return await runOwnedTautulliCacheAttempt(context, attempt);
}

async function runOwnedTautulliCacheAttempt(
	context: OwnedTautulliCacheRefreshContext,
	claimedAttempt?: ProviderCacheRefreshAttempt,
): Promise<TautulliCacheRefreshResult> {
	const authority = createProviderPublicationAuthority(context.instance);
	const options: ProviderIdentityGuardOptions = {
		cleanupRunClaimToken: context.cleanupRunClaimToken,
		timeout: TAUTULLI_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
	};
	try {
		const input: ProviderObservationAttemptInput<
			OwnedProviderPublicationSnapshot,
			TautulliPositiveObservationCollection,
			TautulliCacheRefreshResult
		> = {
			prisma: context.prisma,
			authority,
			cacheType: "tautulli",
			log: context.log,
			prepare: () => createOwnedTautulliPublicationSnapshot(context.encryptor, context.instance),
			collect: async (prepared, attempt) =>
				await collectTautulliPositiveObservations(
					tautulliClientForSnapshot(prepared, context.log),
					{
						instanceId: prepared.id,
						attemptStartedAt: attempt.attemptedAt,
					},
				),
			publish: async (
				tx,
				collected,
				attempt,
			): Promise<ProviderObservationAttemptPublication<TautulliCacheRefreshResult>> =>
				await publishTautulliObservation(tx, authority, attempt, collected),
			failureReason: mapTautulliFailureReason,
			options,
		};
		return claimedAttempt
			? await runClaimedProviderObservationAttempt(input, claimedAttempt)
			: await runProviderObservationAttempt(input);
	} catch (error) {
		const reason = mapTautulliFailureReason(error);
		context.log.warn(
			{ provider: "tautulli", reasonCode: reason },
			"Tautulli positive observation was not published",
		);
		if (reason === "publication-superseded") {
			return {
				kind: "unpublished",
				complete: false,
				upserted: 0,
				errors: 0,
				errorMessages: ["publication-superseded"],
				superseded: true,
			};
		}
		return {
			kind: "unpublished",
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: [reason],
		};
	}
}

async function publishTautulliObservation(
	tx: Prisma.TransactionClient,
	authority: ProviderPublicationAuthority,
	_attempt: ProviderCacheRefreshAttempt,
	collected: TautulliPositiveObservationCollection,
): Promise<ProviderObservationAttemptPublication<TautulliCacheRefreshResult>> {
	const rows = collected.rows;
	const metadata = encodeTautulliObservationMetadata({
		version: 1,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount: rows.length,
		windowStartedAt: collected.windowStartedAt.toISOString(),
		windowEndedAt: collected.windowEndedAt.toISOString(),
		coverageReceipt: collected.receipt,
	});

	await tx.tautulliCache.deleteMany({ where: { instanceId: authority.id } });
	for (let start = 0; start < rows.length; start += TAUTULLI_CACHE_PUBLICATION_CHUNK_SIZE) {
		await tx.tautulliCache.createMany({
			data: rows
				.slice(start, start + TAUTULLI_CACHE_PUBLICATION_CHUNK_SIZE)
				.map((row) => storedObservationRow(row, authority)),
		});
	}

	return {
		result: {
			kind: "positive-observation",
			complete: false,
			upserted: rows.length,
			errors: 0,
			errorMessages: [],
			completedAt: collected.windowEndedAt,
			receipt: collected.receipt,
		},
		publication: {
			observedAt: collected.windowEndedAt,
			itemCount: rows.length,
			generationId: null,
			generationMetadata: metadata,
			receipt: collected.receipt,
		},
	};
}

function storedObservationRow(
	row: TautulliPositiveObservationRow,
	authority: ProviderPublicationAuthority,
) {
	return {
		instanceId: row.instanceId,
		tmdbId: row.tmdbId,
		mediaType: row.mediaType,
		lastWatchedAt: row.lastWatchedAt,
		watchCount: row.watchCount,
		watchedByUsers: row.watchedByUsers,
		connectionGeneration: authority.connectionGeneration,
		identityGeneration: authority.identityGeneration,
	};
}

function mapTautulliFailureReason(error: unknown): ProviderObservationReasonCode {
	if (error instanceof TautulliPositiveObservationError) return error.code;
	if (error instanceof ProviderObservationCoordinatorError) return error.code;
	if (error instanceof ProviderIdentityGuardError) {
		return error.code === "PUBLICATION_SUPERSEDED"
			? "publication-superseded"
			: "provider-unavailable";
	}
	return "provider-unavailable";
}
