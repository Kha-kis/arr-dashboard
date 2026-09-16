import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
import { createJellyfinClient, type JellyfinClient } from "../jellyfin/jellyfin-client.js";
import { collectJellyfinNativeLibraryInventory } from "../jellyfin/jellyfin-native-inventory.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import { readCompleteNativeLibrary } from "../provider-observation/inventory-connection-repository.js";
import { readNativeInventoryPage } from "../provider-observation/native-inventory.js";
import type { LabelSyncRuleInput } from "./execute-rule.js";
import {
	createJellyfinMutationRepository,
	type MutationClaimInput,
	type StoredMutationSnapshot,
} from "./jellyfin-mutation-repository.js";
import {
	createJellyfinMutationTargetIndex,
	type JellyfinMutationTarget,
	resolveJellyfinMutationTarget,
} from "./jellyfin-mutation-target.js";
import { isLabelSyncMutationAdmitted } from "./mutation-admission.js";
import { plexProviderLogSink } from "./plex-provider-log-sink.js";
import type { DestWriteResult, MatchCandidate } from "./strategy-types.js";

const MAX_RECONCILIATION_ROWS = 25;
const targetLocks = new Map<string, Promise<void>>();

export type JellyfinMutationExecutorOptions = {
	rule: LabelSyncRuleInput;
	destInstance: ServiceInstance;
	candidates: readonly MatchCandidate[];
	prisma: PrismaClient;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
};

export type JellyfinMutationReconciliationOptions = {
	prisma: PrismaClient;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
	limit?: number;
};

export type JellyfinMutationReconciliationResult = {
	examined: number;
	verified: number;
	failed: number;
	unknown: number;
};

/** Execute admitted Jellyfin tag mutations under the durable physical gate. */
export async function executeJellyfinMutations(
	opts: JellyfinMutationExecutorOptions,
): Promise<DestWriteResult> {
	if (opts.candidates.length === 0) return { matchesFound: 0, labelsApplied: 0, failures: 0 };
	if (!isLabelSyncMutationAdmitted(opts.prisma)) {
		return { matchesFound: 0, labelsApplied: 0, failures: opts.candidates.length };
	}

	let authority: ServiceInstance | undefined;
	try {
		authority = await readCurrentAuthority(opts.prisma, opts.rule, opts.destInstance.id);
	} catch {
		return { matchesFound: 0, labelsApplied: 0, failures: opts.candidates.length };
	}
	if (!authority) return { matchesFound: 0, labelsApplied: 0, failures: opts.candidates.length };
	let initialCatalog: Awaited<ReturnType<typeof readCompleteNativeLibrary>>;
	try {
		initialCatalog = await readCompleteNativeLibrary(opts.prisma, {
			userId: opts.rule.userId,
			instanceId: authority.id,
		});
	} catch {
		return { matchesFound: 0, labelsApplied: 0, failures: opts.candidates.length };
	}
	const index = createJellyfinMutationTargetIndex(initialCatalog);
	if (!index || !authority.expectedIdentity) {
		return { matchesFound: 0, labelsApplied: 0, failures: opts.candidates.length };
	}

	let client: JellyfinClient;
	try {
		client = createJellyfinClient(opts.encryptor, authority, plexProviderLogSink);
	} catch {
		return { matchesFound: 0, labelsApplied: 0, failures: opts.candidates.length };
	}
	const seen = new Set<string>();
	let matchesFound = 0;
	let labelsApplied = 0;
	let failures = 0;
	for (const candidate of opts.candidates) {
		const target = resolveJellyfinMutationTarget(index, candidate);
		if (!target.available) {
			failures++;
			continue;
		}
		const key = `${target.mediaType}:${target.tmdbId}:${target.nativeId}:${target.libraryId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		matchesFound++;
		let result: "applied" | "failed" | "noop";
		try {
			result = await withPhysicalTargetLock(
				`${authority.expectedIdentity}\0${target.nativeId}`,
				() => executeOne({ ...opts, authority, client, target }),
			);
		} catch {
			// A claim may remain active; startup recovery will classify it before
			// another provider request can be attempted.
			result = "failed";
		}
		if (result === "applied") labelsApplied++;
		if (result === "failed") failures++;
	}
	return { matchesFound, labelsApplied, failures };
}

async function executeOne(input: {
	rule: LabelSyncRuleInput;
	authority: ServiceInstance;
	client: JellyfinClient;
	target: JellyfinMutationTarget;
	prisma: PrismaClient;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}): Promise<"applied" | "failed" | "noop"> {
	const { rule, authority, target, prisma, client } = input;
	if (!authority.expectedIdentity) return "failed";
	const ruleFingerprint = fingerprintRule(rule);
	let currentRule: LabelSyncRuleInput | undefined;
	try {
		currentRule = (await prisma.labelSyncRule.findFirst({
			where: { id: rule.id, userId: rule.userId },
		})) as LabelSyncRuleInput | undefined;
	} catch {
		return "failed";
	}
	if (
		!currentRule ||
		(currentRule as LabelSyncRuleInput & { enabled?: boolean }).enabled !== true ||
		fingerprintRule(currentRule) !== ruleFingerprint
	)
		return "failed";
	const intentFingerprint = evidenceFingerprint({
		ruleFingerprint,
		provider: "jellyfin",
		connectionGeneration: authority.connectionGeneration,
		identityGeneration: authority.identityGeneration,
		serverIdentity: authority.expectedIdentity,
		mediaType: target.mediaType,
		tmdbId: target.tmdbId,
		nativeId: target.nativeId,
		libraryId: target.libraryId,
		destinationTag: rule.destTagName,
	});
	const claimInput: MutationClaimInput = {
		userId: rule.userId,
		ruleId: rule.id,
		destinationInstanceId: authority.id,
		provider: "jellyfin",
		mediaType: target.mediaType,
		tmdbId: target.tmdbId,
		connectionGeneration: authority.connectionGeneration,
		identityGeneration: authority.identityGeneration,
		targetItemId: target.nativeId,
		libraryId: target.libraryId,
		intentFingerprint,
		ruleFingerprint,
		destinationTag: rule.destTagName,
	};
	const repository = createJellyfinMutationRepository(prisma);
	let claim: Awaited<ReturnType<typeof repository.claimPhysicalTarget>>;
	try {
		claim = await repository.claimPhysicalTarget(claimInput, authority.expectedIdentity);
	} catch {
		return "failed";
	}
	if (claim.kind !== "acquired") return "failed";
	const envelope = {
		id: claim.id,
		userId: rule.userId,
		ruleId: rule.id,
		destinationInstanceId: authority.id,
		activeOperationKey: claim.activeOperationKey,
		claimToken: claim.claimToken,
	};
	let claimedRule: LabelSyncRuleInput | undefined;
	try {
		claimedRule = (await prisma.labelSyncRule.findFirst({
			where: { id: rule.id, userId: rule.userId },
		})) as LabelSyncRuleInput | undefined;
	} catch {
		claimedRule = undefined;
	}
	if (
		!claimedRule ||
		(claimedRule as LabelSyncRuleInput & { enabled?: boolean }).enabled !== true ||
		fingerprintRule(claimedRule) !== ruleFingerprint
	) {
		try {
			await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: "blocked",
				reasonCode: "rule_changed",
			});
		} catch {
			// Preserve the active claim for startup recovery.
		}
		return "failed";
	}

	const preSend = await readAndValidateTarget(client, authority, target);
	if (!preSend.ok) {
		try {
			await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: preSend.reason === "provider_unavailable" ? "failed" : "blocked",
				reasonCode: preSend.reason,
			});
		} catch {
			// The claim remains durable and recovery will classify it before any retry.
		}
		return "failed";
	}
	if (preSend.snapshot.tags.includes(rule.destTagName)) {
		let stillCurrent = false;
		try {
			const current = await readCurrentAuthority(prisma, rule, authority.id);
			stillCurrent = sameAuthority(current, authority);
		} catch {
			stillCurrent = false;
		}
		if (!stillCurrent) {
			try {
				await repository.completePreSend({
					...envelope,
					sendAttemptCount: 0,
					status: "blocked",
					reasonCode: "generation_changed",
				});
			} catch {
				// Preserve the active claim for startup recovery.
			}
			return "failed";
		}
		try {
			const transition = await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: "noop",
				reasonCode: "already_applied",
				lastObservedAt: new Date(),
			});
			if (transition.kind !== "applied") return "failed";
		} catch {
			return "failed";
		}
		return "noop";
	}

	if (!isLabelSyncMutationAdmitted(prisma)) {
		try {
			await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: "failed",
				reasonCode: "internal_failure",
			});
		} catch {
			// Preserve the active claim for startup recovery.
		}
		return "failed";
	}
	// A cached unique identity can gain another copy upstream. Reuse the
	// complete native collector under the physical claim before a real write.
	// No-op paths above do not mutate and need no extra catalog scan.
	const live = await collectJellyfinNativeLibraryInventory(
		{
			getNativeMediaFolders: () => client.getNativeMediaFolders({ mutationValidation: true }),
			getNativeLibraryItemsWithCoverage: (libraryId, options) =>
				client.getNativeLibraryItemsWithCoverage(libraryId, {
					...options,
					mutationValidation: true,
				}),
		},
		{ requireStableIdentifiers: true },
	);
	const liveRows = live.complete ? live.snapshots[0].rows : undefined;
	const liveTarget = resolveJellyfinMutationTarget(
		createJellyfinMutationTargetIndex(
			liveRows
				? {
						generationId: "live-read",
						freshness: "current",
						complete: true,
						itemCount: liveRows.length,
						rows: liveRows,
					}
				: undefined,
		),
		target,
	);
	if (
		!liveTarget.available ||
		liveTarget.nativeId !== target.nativeId ||
		liveTarget.libraryId !== target.libraryId
	) {
		try {
			await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: "blocked",
				reasonCode: "target_changed",
			});
		} catch {
			// Preserve the active claim for startup recovery.
		}
		return "failed";
	}
	let current: ServiceInstance | undefined;
	let currentPage: Awaited<ReturnType<typeof readNativeInventoryPage>>;
	try {
		current = await readCurrentAuthority(prisma, rule, authority.id);
		currentPage = current
			? await readNativeInventoryPage(prisma, {
					userId: rule.userId,
					instanceId: authority.id,
					domain: "library",
					expectedGenerationId: target.generationId,
					limit: 1,
				})
			: { status: "unavailable", reason: "not-owned" };
	} catch {
		current = undefined;
		currentPage = { status: "unavailable", reason: "provider-unavailable" };
	}
	if (
		!current?.expectedIdentity ||
		current.expectedIdentity !== authority.expectedIdentity ||
		current.connectionGeneration !== authority.connectionGeneration ||
		current.identityGeneration !== authority.identityGeneration ||
		currentPage.status !== "available" ||
		!currentPage.complete ||
		currentPage.freshness !== "current" ||
		currentPage.generationId !== target.generationId
	) {
		try {
			await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: "blocked",
				reasonCode: "generation_changed",
			});
		} catch {
			// Preserve the active claim for startup recovery.
		}
		return "failed";
	}
	const finalRead = await readAndValidateTarget(client, authority, target);
	if (!finalRead.ok) {
		try {
			await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: finalRead.reason === "provider_unavailable" ? "failed" : "blocked",
				reasonCode: finalRead.reason,
			});
		} catch {
			// Preserve the active claim for startup recovery.
		}
		return "failed";
	}
	if (finalRead.snapshot.tags.includes(rule.destTagName)) {
		try {
			const transition = await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: "noop",
				reasonCode: "already_applied",
				lastObservedAt: new Date(),
			});
			if (transition.kind !== "applied") return "failed";
		} catch {
			return "failed";
		}
		return "noop";
	}
	if (!isLabelSyncMutationAdmitted(prisma)) {
		try {
			await repository.completePreSend({
				...envelope,
				sendAttemptCount: 0,
				status: "failed",
				reasonCode: "internal_failure",
			});
		} catch {
			// Preserve the active claim for startup recovery.
		}
		return "failed";
	}

	let sending: Awaited<ReturnType<typeof repository.markSending>>;
	try {
		sending = await repository.markSending({ ...envelope, sendAttemptCount: 0 });
	} catch {
		return "failed";
	}
	if (sending.kind !== "applied") return "failed";
	try {
		await client.addMutationTargetTag(finalRead.snapshot, rule.destTagName);
		const readback = await client.readMutationTarget(target.nativeId);
		if (
			readback.serverId !== authority.expectedIdentity ||
			readback.itemId !== target.nativeId ||
			readback.mediaType !== target.mediaType ||
			readback.tmdbId !== target.tmdbId ||
			!readback.ancestorIds.includes(target.libraryId) ||
			!readback.tags.includes(rule.destTagName)
		) {
			await repository.completeSend({
				...envelope,
				sendAttemptCount: sending.sendAttemptCount ?? 1,
				status: "unknown",
			});
			return "failed";
		}
		const transition = await repository.completeSend({
			...envelope,
			sendAttemptCount: sending.sendAttemptCount ?? 1,
			status: "verified",
			reasonCode: "applied",
			lastObservedAt: new Date(),
		});
		return transition.kind === "applied" ? "applied" : "failed";
	} catch {
		try {
			await repository.completeSend({
				...envelope,
				sendAttemptCount: sending.sendAttemptCount ?? 1,
				status: "unknown",
			});
		} catch {
			// A send or terminal persistence failure is never retried in this call.
		}
		return "failed";
	}
}

function sameAuthority(left: ServiceInstance | undefined, right: ServiceInstance): boolean {
	return Boolean(
		left?.expectedIdentity &&
			left.expectedIdentity === right.expectedIdentity &&
			left.connectionGeneration === right.connectionGeneration &&
			left.identityGeneration === right.identityGeneration,
	);
}

async function readAndValidateTarget(
	client: JellyfinClient,
	authority: ServiceInstance,
	target: JellyfinMutationTarget,
): Promise<
	| { ok: true; snapshot: Awaited<ReturnType<JellyfinClient["readMutationTarget"]>> }
	| { ok: false; reason: "provider_unavailable" | "target_changed" | "library_ancestry_changed" }
> {
	try {
		const snapshot = await client.readMutationTarget(target.nativeId);
		if (
			snapshot.serverId !== authority.expectedIdentity ||
			snapshot.itemId !== target.nativeId ||
			snapshot.mediaType !== target.mediaType ||
			snapshot.tmdbId !== target.tmdbId
		)
			return { ok: false, reason: "target_changed" };
		if (!snapshot.ancestorIds.includes(target.libraryId))
			return { ok: false, reason: "library_ancestry_changed" };
		return { ok: true, snapshot };
	} catch {
		return { ok: false, reason: "provider_unavailable" };
	}
}

async function readCurrentAuthority(
	prisma: PrismaClient,
	rule: LabelSyncRuleInput,
	instanceId: string,
): Promise<ServiceInstance | undefined> {
	const instance = await prisma.serviceInstance.findFirst({
		where: { id: instanceId, userId: rule.userId, service: "JELLYFIN", enabled: true },
	});
	if (
		instance?.identityStatus !== "VERIFIED" ||
		typeof instance.expectedIdentity !== "string" ||
		instance.expectedIdentity.trim().length === 0
	)
		return undefined;
	if (rule.destService !== "jellyfin" || rule.destInstanceId !== instance.id) return undefined;
	return instance;
}

function fingerprintRule(rule: LabelSyncRuleInput): string {
	return evidenceFingerprint({
		id: rule.id,
		userId: rule.userId,
		sourceService: rule.sourceService,
		sourceInstanceId: rule.sourceInstanceId,
		sourceTagName: rule.sourceTagName,
		destService: rule.destService,
		destInstanceId: rule.destInstanceId,
		destTagName: rule.destTagName,
	});
}

async function withPhysicalTargetLock<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = targetLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	targetLocks.set(key, current);
	await previous;
	try {
		return await work();
	} finally {
		release();
		if (targetLocks.get(key) === current) targetLocks.delete(key);
	}
}

/** Bounded, read-only reconciliation for unknown Jellyfin mutation attempts. */
export async function reconcileJellyfinMutationAttempts(
	opts: JellyfinMutationReconciliationOptions,
): Promise<JellyfinMutationReconciliationResult> {
	const requestedLimit = opts.limit ?? MAX_RECONCILIATION_ROWS;
	const limit = Number.isSafeInteger(requestedLimit)
		? Math.min(Math.max(requestedLimit, 1), MAX_RECONCILIATION_ROWS)
		: MAX_RECONCILIATION_ROWS;
	if (!isLabelSyncMutationAdmitted(opts.prisma))
		return { examined: 0, verified: 0, failed: 0, unknown: 0 };
	const rows = await opts.prisma.labelSyncMutationAttempt.findMany({
		where: { provider: "jellyfin", status: "unknown" },
		orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
		take: limit,
	});
	const result: JellyfinMutationReconciliationResult = {
		examined: 0,
		verified: 0,
		failed: 0,
		unknown: 0,
	};
	for (const raw of rows) {
		result.examined++;
		const row = raw as StoredMutationSnapshot;
		const repository = createJellyfinMutationRepository(opts.prisma);
		let acquired: Awaited<ReturnType<typeof repository.acquireReconciliation>>;
		try {
			acquired = await repository.acquireReconciliation({
				id: row.id,
				userId: row.userId,
				ruleId: row.ruleId,
				destinationInstanceId: row.destinationInstanceId,
				activeOperationKey: row.activeOperationKey,
			});
		} catch {
			result.unknown++;
			continue;
		}
		if (acquired.kind !== "acquired") continue;
		const snapshot = acquired.snapshot;
		let outcome: "verified" | "unknown" = "unknown";
		try {
			const rule = await opts.prisma.labelSyncRule.findFirst({
				where: { id: snapshot.ruleId, userId: snapshot.userId },
			});
			const authority = rule
				? await opts.prisma.serviceInstance.findFirst({
						where: {
							id: snapshot.destinationInstanceId,
							userId: snapshot.userId,
							service: "JELLYFIN",
							enabled: true,
						},
					})
				: undefined;
			if (
				rule?.enabled !== true ||
				rule.destService !== "jellyfin" ||
				rule.destInstanceId !== snapshot.destinationInstanceId ||
				fingerprintRule(rule) !== snapshot.ruleFingerprint ||
				!authority ||
				authority.identityStatus !== "VERIFIED" ||
				authority.expectedIdentity === null ||
				authority.connectionGeneration !== snapshot.connectionGeneration ||
				authority.identityGeneration !== snapshot.identityGeneration
			) {
				outcome = "unknown";
			} else {
				const catalog = await readCompleteNativeLibrary(opts.prisma, {
					userId: snapshot.userId,
					instanceId: authority.id,
				});
				const target = resolveJellyfinMutationTarget(createJellyfinMutationTargetIndex(catalog), {
					mediaType: snapshot.mediaType,
					tmdbId: snapshot.tmdbId,
				});
				if (
					!target.available ||
					target.nativeId !== snapshot.targetItemId ||
					target.libraryId !== snapshot.libraryId
				) {
					outcome = "unknown";
				} else {
					const client = createJellyfinClient(opts.encryptor, authority, plexProviderLogSink);
					const live = await client.readMutationTarget(snapshot.targetItemId);
					if (
						live.serverId !== authority.expectedIdentity ||
						live.itemId !== snapshot.targetItemId ||
						live.mediaType !== snapshot.mediaType ||
						live.tmdbId !== snapshot.tmdbId ||
						!live.ancestorIds.includes(snapshot.libraryId)
					)
						outcome = "unknown";
					else {
						// An absent tag cannot prove that an in-flight or timed-out
						// overwrite will not arrive later. Keep the physical target
						// blocked until a later read observes the desired tag.
						outcome = live.tags.includes(snapshot.destinationTag) ? "verified" : "unknown";
					}
				}
			}
		} catch {
			outcome = "unknown";
		}
		try {
			const transition = await repository.completeReconciliation({
				id: snapshot.id,
				userId: snapshot.userId,
				ruleId: snapshot.ruleId,
				destinationInstanceId: snapshot.destinationInstanceId,
				activeOperationKey: snapshot.activeOperationKey,
				claimToken: acquired.claimToken,
				reconcileAttemptCount: acquired.reconcileAttemptCount,
				outcome:
					outcome === "verified"
						? { status: "verified", reasonCode: "applied" }
						: { status: "unknown", reasonCode: "reconciliation_unavailable" },
				lastObservedAt: new Date(),
			});
			if (transition.kind !== "applied") outcome = "unknown";
		} catch {
			outcome = "unknown";
		}
		if (outcome === "verified") result.verified++;
		else result.unknown++;
	}
	return result;
}
