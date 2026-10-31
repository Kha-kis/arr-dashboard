import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import {
	claimProviderCacheRefreshAttempt,
	finishProviderCacheRefreshAttemptFailure,
} from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { createOwnedJellyfinPublicationSnapshot } from "./jellyfin-cache-refresher.js";
import { JellyfinClient } from "./jellyfin-client.js";
import { collectJellyfinPositiveWatchCandidates } from "./jellyfin-positive-watch-collector.js";
import { publishJellyfinPositiveWatchGeneration } from "./jellyfin-positive-watch-repository.js";

export type JellyfinPositiveWatchRefreshResult =
	| { kind: "published"; itemCount: number; scopeCount: number; durationMs: number }
	| { kind: "skipped"; reason: "running" | "superseded" | "cancelled" }
	| { kind: "failed"; reason: "provider-unavailable" | "coverage-incomplete" };

/** Refresh only stable watched-positive facts; never publish a negative or cleanup evidence. */
export async function refreshOwnedJellyfinPositiveWatch(input: {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	signal?: AbortSignal;
}): Promise<JellyfinPositiveWatchRefreshResult> {
	const startedAt = Date.now();
	const { prisma, instance, log } = input;
	if (instance.service !== "JELLYFIN") return { kind: "skipped", reason: "superseded" };
	if (input.signal?.aborted) return { kind: "skipped", reason: "cancelled" };
	const authority = createProviderPublicationAuthority(instance);
	const claim = await claimProviderCacheRefreshAttempt(
		prisma,
		"jellyfin_episode_positive",
		authority,
	);
	if (claim.status !== "acquired")
		return {
			kind: "skipped",
			reason: claim.status === "already-running" ? "running" : "superseded",
		};
	let failureReason: "provider-unavailable" | "coverage-incomplete" = "provider-unavailable";
	let publicationStarted = false;
	try {
		const snapshot = createOwnedJellyfinPublicationSnapshot(input.encryptor, instance);
		const client = new JellyfinClient(
			snapshot.baseUrl,
			snapshot.apiKey,
			log,
			undefined,
			snapshot.httpAuthHeaders,
			undefined,
			input.signal,
		);
		const result = await withGuardedProviderPublication(
			prisma,
			snapshot,
			log,
			async () => {
				const scopes: Array<{ userId: string; libraryId: string }> = [];
				for (const user of await client.getUsers()) {
					for (const library of await client.getLibraries(user.id)) {
						scopes.push({ userId: user.id, libraryId: library.id });
					}
				}
				if (scopes.length === 0) throw new Error("Jellyfin positive watch has no readable scopes");
				failureReason = "coverage-incomplete";
				return await collectJellyfinPositiveWatchCandidates(client, scopes);
			},
			async (tx, collection) => {
				// Once entered, retain the transaction's actual commit/rollback.
				publicationStarted = true;
				const observedAt = new Date();
				await publishJellyfinPositiveWatchGeneration(tx, {
					instance,
					attempt: claim.attempt,
					generationId: randomUUID(),
					observedAt,
					candidates: collection.candidates,
				});
				return { itemCount: collection.candidates.length, scopeCount: collection.scopeCount };
			},
			{ timeout: 60_000, signal: input.signal },
		);
		return {
			kind: "published",
			...result,
			durationMs: Math.max(0, Date.now() - startedAt),
		};
	} catch (error) {
		const cancelled =
			!publicationStarted &&
			(input.signal?.aborted === true ||
				(error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_CANCELLED"));
		// Settle only our fenced attempt; cancellation is not a provider outage.
		// This bookkeeping is joined even though the read signal is now aborted.
		await finishProviderCacheRefreshAttemptFailure(
			prisma,
			"jellyfin_episode_positive",
			cancelled ? "refresh-cancelled" : failureReason,
			authority,
			claim.attempt,
			log,
		);
		if (cancelled) return { kind: "skipped", reason: "cancelled" };
		if (error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED")
			return { kind: "skipped", reason: "superseded" };
		return { kind: "failed", reason: failureReason };
	}
}
