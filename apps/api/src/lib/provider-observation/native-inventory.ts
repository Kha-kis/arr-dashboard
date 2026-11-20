import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Prisma, type PrismaClient, type ServiceInstance } from "../prisma.js";
import {
	createProviderPublicationAuthority,
	ProviderIdentityGuardError,
	type ProviderPublicationAuthority,
	withCurrentProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const READ_TRANSACTION_MAX_WAIT_MS = 5_000;
const WRITE_CHUNK_SIZE = 500;
const ATTEMPT_TOKEN_PATTERN =
	/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

export type NativeInventoryDomain = "library" | "episode";
export type NativeInventoryMediaType = "movie" | "series" | "episode";

export type NativeInventoryExternalIds = {
	tmdb?: number[];
	tvdb?: number[];
};

export type NativeInventoryRow = {
	nativeId: string;
	mediaType: NativeInventoryMediaType;
	libraryIds: readonly string[];
	parentNativeId: string | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	title: string;
	externalIds?: NativeInventoryExternalIds;
};

export type NativeInventorySnapshotInput = {
	domain: NativeInventoryDomain;
	scopeKeys: readonly string[];
	rows: readonly NativeInventoryRow[];
};

export type NativeInventoryAttempt = {
	attemptedAt: Date;
	resultMarker: string;
	domains: readonly NativeInventoryDomain[];
};

export type NativeInventoryAuthorityInput = ServiceInstance | ProviderPublicationAuthority;

export type NativeInventoryBeginResult =
	| {
			status: "acquired";
			token: string;
			attemptedAt: Date;
			attempt: NativeInventoryAttempt;
			authority: ProviderPublicationAuthority;
			domains: readonly NativeInventoryDomain[];
	  }
	| { status: "superseded" };

export type NativeInventoryPublishResult =
	| {
			status: "published";
			generationId: string;
			observedAt: Date;
			itemCounts: Readonly<Partial<Record<NativeInventoryDomain, number>>>;
	  }
	| { status: "superseded" };

export type NativeInventoryFailureReason =
	| "provider-unavailable"
	| "coverage-incomplete"
	| "identity-changed";

export type NativeInventoryFailureResult = { status: "recorded" | "superseded" };

export type NativeInventoryUnavailableReason =
	| "not-owned"
	| "provider-unavailable"
	| "identity-changed"
	| "no-publication"
	| "snapshot-changed"
	| "filter-limit-exceeded"
	| "unsupported-provider"
	| "malformed-publication";

export type NativeInventoryAttemptProgress = {
	state: "pending" | "running" | "ready" | "published" | "incomplete" | "superseded" | "unknown";
	passOrdinal: number;
	pagesCompleted: number;
	itemsStaged: number;
	failureCount: number;
	reasonCode:
		| "provider-unavailable"
		| "coverage-incomplete"
		| "deadline-exceeded"
		| "database-retryable"
		| "budget-exhausted"
		| null;
};

export type NativeInventoryPage =
	| {
			status: "available";
			generationId: string;
			observedAt: Date;
			itemCount: number;
			scopeCount: number;
			lastAttemptAt: Date | null;
			lastAttemptResult: string;
			lastAttemptReason: string | null;
			freshness: "current" | "last-known";
			complete: boolean;
			/** Display-only positive observations; never authority for absence or cleanup. */
			evidence?: "positive-only";
			rows: NativeInventoryRow[];
			nextNativeId: string | null;
			attempt?: NativeInventoryAttemptProgress;
	  }
	| {
			status: "unavailable";
			reason: NativeInventoryUnavailableReason;
			attempt?: NativeInventoryAttemptProgress;
	  };

const NATIVE_ATTEMPT_STATES = new Set([
	"pending",
	"running",
	"ready",
	"published",
	"incomplete",
	"superseded",
]);
const NATIVE_ATTEMPT_REASONS = new Set([
	"provider-unavailable",
	"coverage-incomplete",
	"deadline-exceeded",
	"database-retryable",
	"budget-exhausted",
]);

async function readNativeAttemptProgress(
	tx: Prisma.TransactionClient,
	instance: { id: string; connectionGeneration: number; identityGeneration: number },
	domain: NativeInventoryDomain,
): Promise<NativeInventoryAttemptProgress | null> {
	const run = await tx.providerNativeInventoryRun.findFirst({
		where: {
			instanceId: instance.id,
			workKey: { in: [domain, "paired"] },
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
		orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
	});
	if (!run) return null;
	const pass = await tx.providerNativeInventoryPass.findUnique({
		where: { runId_ordinal: { runId: run.id, ordinal: run.passOrdinal } },
		select: { id: true },
	});
	const [pagesCompleted, itemsStaged] = pass
		? await Promise.all([
				tx.providerNativeInventoryPageReceipt.count({ where: { passId: pass.id, domain } }),
				tx.providerNativeInventoryStageItem.count({ where: { passId: pass.id, domain } }),
			])
		: [0, 0];
	return {
		state: NATIVE_ATTEMPT_STATES.has(run.state)
			? (run.state as NativeInventoryAttemptProgress["state"])
			: "unknown",
		passOrdinal:
			Number.isSafeInteger(run.passOrdinal) && run.passOrdinal >= 1 && run.passOrdinal <= 3
				? run.passOrdinal
				: 0,
		pagesCompleted,
		itemsStaged,
		failureCount:
			Number.isSafeInteger(run.failureCount) && run.failureCount >= 0 ? run.failureCount : 0,
		reasonCode:
			run.lastFailureCategory && NATIVE_ATTEMPT_REASONS.has(run.lastFailureCategory)
				? (run.lastFailureCategory as NativeInventoryAttemptProgress["reasonCode"])
				: null,
	};
}

function attachNativeAttempt<T extends object>(
	result: T,
	attempt: NativeInventoryAttemptProgress | null,
): T | (T & { attempt: NativeInventoryAttemptProgress }) {
	return attempt ? { ...result, attempt } : result;
}

export class NativeInventoryInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NativeInventoryInputError";
	}
}

/** Acquire per-domain attempt markers while preserving every prior publication field. */
export async function beginNativeInventoryAttempt(
	prisma: Pick<PrismaClient, "$transaction">,
	input: {
		userId: string;
		instance: NativeInventoryAuthorityInput;
		domains: readonly NativeInventoryDomain[];
		now?: Date;
	},
): Promise<NativeInventoryBeginResult> {
	const domains = normalizeDomains(input.domains);
	const now = input.now ?? new Date();
	if (!isNonEmptySafeString(input.userId) || input.instance.userId !== input.userId) {
		return { status: "superseded" };
	}
	if (!isValidDate(now)) return { status: "superseded" };
	let authority: ProviderPublicationAuthority;
	try {
		authority = nativeInventoryAuthority(input.instance);
	} catch {
		return { status: "superseded" };
	}
	if (!isCurrentPublishableAuthority(authority)) return { status: "superseded" };

	try {
		const result = await withCurrentProviderPublicationAuthority(prisma, authority, async (tx) => {
			const begun = await beginNativeInventoryAttemptInTransaction(tx, {
				userId: input.userId,
				instance: input.instance,
				domains,
				now,
			});
			return begun;
		});
		return result.matched && result.value ? result.value : { status: "superseded" };
	} catch (error) {
		if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
		throw error;
	}
}

/** Acquire attempt markers inside a caller-owned guarded transaction. */
export async function beginNativeInventoryAttemptInTransaction(
	tx: Prisma.TransactionClient,
	input: {
		userId: string;
		instance: NativeInventoryAuthorityInput;
		domains: readonly NativeInventoryDomain[];
		now?: Date;
	},
): Promise<NativeInventoryBeginResult> {
	const domains = normalizeDomains(input.domains);
	const now = input.now ?? new Date();
	if (!isNonEmptySafeString(input.userId) || input.instance.userId !== input.userId) {
		return { status: "superseded" };
	}
	if (!isValidDate(now)) return { status: "superseded" };
	let authority: ProviderPublicationAuthority;
	try {
		authority = nativeInventoryAuthority(input.instance);
	} catch {
		return { status: "superseded" };
	}
	if (!isCurrentPublishableAuthority(authority)) return { status: "superseded" };
	const current = await tx.serviceInstance.findFirst({
		where: providerPublicationPredicate(authority),
		select: { id: true },
	});
	if (!current) return { status: "superseded" };
	const token = `in_progress:${randomUUID()}`;
	const attempt: NativeInventoryAttempt = { attemptedAt: now, resultMarker: token, domains };
	for (const domain of domains) {
		await tx.providerNativeInventorySnapshot.upsert({
			where: { instanceId_domain: { instanceId: authority.id, domain } },
			create: {
				instanceId: authority.id,
				domain,
				lastAttemptAt: now,
				lastAttemptToken: token,
				lastAttemptResult: "in_progress",
				lastAttemptReason: null,
			},
			update: {
				lastAttemptAt: now,
				lastAttemptToken: token,
				lastAttemptResult: "in_progress",
				lastAttemptReason: null,
			},
		});
	}
	return { status: "acquired", token, attemptedAt: now, attempt, authority, domains };
}

/** Replace all rows and publication metadata atomically inside the caller's guarded transaction. */
export async function publishNativeInventoriesInTransaction(
	tx: Prisma.TransactionClient,
	input: {
		userId: string;
		authority: ProviderPublicationAuthority;
		attempt: NativeInventoryAttempt;
		snapshots: readonly NativeInventorySnapshotInput[];
		now?: Date;
	},
): Promise<NativeInventoryPublishResult> {
	const now = input.now ?? new Date();
	if (!isNonEmptySafeString(input.userId) || input.userId !== input.authority.userId) {
		return { status: "superseded" };
	}
	if (!isCurrentPublishableAuthority(input.authority)) return { status: "superseded" };
	if (!isValidAttempt(input.attempt)) {
		throw new NativeInventoryInputError("Native inventory attempt is invalid");
	}
	const domains = normalizeDomains(input.attempt.domains);
	if (!isValidDate(now) || input.attempt.attemptedAt.getTime() > now.getTime()) {
		throw new NativeInventoryInputError("Native inventory publication timestamp is invalid");
	}
	const snapshots = validateSnapshotInputs(input.snapshots, domains);

	const current = await tx.serviceInstance.findFirst({
		where: providerPublicationPredicate(input.authority),
		select: { id: true },
	});
	if (!current) return { status: "superseded" };

	const existing = await Promise.all(
		snapshots.map(({ domain }) =>
			tx.providerNativeInventorySnapshot.findUnique({
				where: { instanceId_domain: { instanceId: input.authority.id, domain } },
				select: {
					id: true,
					lastAttemptAt: true,
					lastAttemptToken: true,
					lastAttemptResult: true,
				},
			}),
		),
	);
	if (existing.some((row) => !isCurrentAttemptRow(row, input.attempt))) {
		return { status: "superseded" };
	}

	const generationId = randomUUID();
	const itemCounts: Partial<Record<NativeInventoryDomain, number>> = {};
	for (const [index, snapshot] of snapshots.entries()) {
		const row = existing[index];
		const snapshotId = row?.id;
		if (!snapshotId) return { status: "superseded" };
		await tx.providerNativeInventoryItem.deleteMany({ where: { snapshotId } });
		for (let offset = 0; offset < snapshot.rows.length; offset += WRITE_CHUNK_SIZE) {
			const chunk = snapshot.rows.slice(offset, offset + WRITE_CHUNK_SIZE);
			// Keep replacement atomic, but avoid per-row Prisma compilation and
			// microtask starvation with the synchronous SQLite driver. Values stay
			// parameterized; 500 rows also stay below both database bind limits.
			const values = chunk.map(
				(item) => Prisma.sql`(
				${randomUUID()}, ${snapshotId}, ${item.nativeId}, ${item.mediaType},
				${JSON.stringify(item.libraryIds)}, ${item.parentNativeId},
				${item.seasonNumber}, ${item.episodeNumber}, ${item.title},
				${hasNativeInventoryExternalIds(item.externalIds) ? JSON.stringify(item.externalIds) : null}
			)`,
			);
			const inserted = await tx.$executeRaw(Prisma.sql`
				INSERT INTO "provider_native_inventory_items"
				("id", "snapshotId", "nativeId", "mediaType", "libraryIds", "parentNativeId",
				 "seasonNumber", "episodeNumber", "title", "externalIds")
				VALUES ${Prisma.join(values)}
			`);
			if (inserted !== chunk.length) {
				throw new NativeInventoryInputError("Native inventory row insertion was incomplete");
			}
			await yieldToEventLoop();
		}
		const updated = await tx.providerNativeInventorySnapshot.updateMany({
			where: {
				id: snapshotId,
				instanceId: input.authority.id,
				domain: snapshot.domain,
				lastAttemptAt: input.attempt.attemptedAt,
				lastAttemptToken: input.attempt.resultMarker,
				lastAttemptResult: "in_progress",
			},
			data: {
				generationId,
				observedAt: now,
				connectionGeneration: input.authority.connectionGeneration,
				identityGeneration: input.authority.identityGeneration,
				scopeDigest: snapshot.scopeDigest,
				contentDigest: snapshot.contentDigest,
				itemCount: snapshot.rows.length,
				scopeCount: snapshot.scopeKeys.length,
				lastAttemptAt: now,
				lastAttemptToken: null,
				lastAttemptResult: "success",
				lastAttemptReason: null,
			},
		});
		if (updated.count !== 1) {
			throw new NativeInventoryInputError("Native inventory publication was superseded");
		}
		itemCounts[snapshot.domain] = snapshot.rows.length;
	}
	return { status: "published", generationId, observedAt: now, itemCounts };
}

/** Record a bounded failure for only the still-current attempt; prior rows remain intact. */
export async function failNativeInventoryAttempt(
	prisma: Pick<PrismaClient, "$transaction">,
	input: {
		userId: string;
		authority: ProviderPublicationAuthority;
		attempt: NativeInventoryAttempt;
		reason: NativeInventoryFailureReason;
	},
): Promise<NativeInventoryFailureResult> {
	if (
		!isNonEmptySafeString(input.userId) ||
		input.userId !== input.authority.userId ||
		!isCurrentPublishableAuthority(input.authority) ||
		!isValidAttempt(input.attempt) ||
		!isFailureReason(input.reason)
	)
		return { status: "superseded" };
	try {
		const result = await withCurrentProviderPublicationAuthority(
			prisma,
			input.authority,
			async (tx) => await failNativeInventoryAttemptInTransaction(tx, input),
		);
		return result.matched && result.value ? result.value : { status: "superseded" };
	} catch (error) {
		if (error instanceof ProviderIdentityGuardError) return { status: "superseded" };
		throw error;
	}
}

/** Record a failure inside a caller-owned guarded transaction. */
export async function failNativeInventoryAttemptInTransaction(
	tx: Prisma.TransactionClient,
	input: {
		userId: string;
		authority: ProviderPublicationAuthority;
		attempt: NativeInventoryAttempt;
		reason: NativeInventoryFailureReason;
	},
): Promise<NativeInventoryFailureResult> {
	if (
		!isNonEmptySafeString(input.userId) ||
		input.userId !== input.authority.userId ||
		!isCurrentPublishableAuthority(input.authority) ||
		!isValidAttempt(input.attempt) ||
		!isFailureReason(input.reason)
	)
		return { status: "superseded" };
	const current = await tx.serviceInstance.findFirst({
		where: providerPublicationPredicate(input.authority),
		select: { id: true },
	});
	if (!current) return { status: "superseded" };
	const matches = await tx.providerNativeInventorySnapshot.count({
		where: {
			instanceId: input.authority.id,
			domain: { in: [...input.attempt.domains] },
			lastAttemptAt: input.attempt.attemptedAt,
			lastAttemptToken: input.attempt.resultMarker,
			lastAttemptResult: "in_progress",
		},
	});
	if (matches !== input.attempt.domains.length) return { status: "superseded" };
	const updated = await tx.providerNativeInventorySnapshot.updateMany({
		where: {
			instanceId: input.authority.id,
			domain: { in: [...input.attempt.domains] },
			lastAttemptAt: input.attempt.attemptedAt,
			lastAttemptToken: input.attempt.resultMarker,
			lastAttemptResult: "in_progress",
		},
		data: { lastAttemptResult: "failed", lastAttemptReason: input.reason },
	});
	if (updated.count !== input.attempt.domains.length) {
		throw new NativeInventoryInputError("Native inventory failure was superseded");
	}
	return { status: "recorded" };
}

/** Read one owned, integrity-checked page from the latest generation. */
export async function readNativeInventoryPage(
	prisma: PrismaClient,
	input: {
		userId: string;
		instanceId: string;
		domain: NativeInventoryDomain;
		afterNativeId?: string;
		expectedGenerationId?: string;
		limit?: number;
		now?: Date;
		maxAgeMs?: number;
		/** "unavailable" defers progress work that a successful initial display read will discard. */
		includeAttempt?: boolean | "unavailable";
		/** Internal admission guard: prove the exact authority in the same read transaction. */
		expectedAuthority?: ProviderPublicationAuthority;
	},
): Promise<NativeInventoryPage> {
	return readNativeInventoryPageInternal(prisma, input);
}

/** Selected display evidence only; missing rows never establish catalog absence. */
export async function readNativeInventoryDisplayTargets(
	prisma: PrismaClient,
	input: Pick<
		Parameters<typeof readNativeInventoryPage>[1],
		"userId" | "instanceId" | "expectedGenerationId" | "now" | "maxAgeMs" | "expectedAuthority"
	> & { nativeIds: readonly string[] },
): Promise<
	| {
			status: "available";
			generationId: string;
			observedAt: Date;
			freshness: "current" | "last-known";
			publicationItemCount: number;
			rows: NativeInventoryRow[];
	  }
	| { status: "unavailable"; reason: NativeInventoryUnavailableReason }
> {
	if (
		!Array.isArray(input.nativeIds) ||
		input.nativeIds.length < 1 ||
		input.nativeIds.length > MAX_LIMIT ||
		input.nativeIds.some((id) => !isNonEmptySafeString(id)) ||
		new Set(input.nativeIds).size !== input.nativeIds.length
	) {
		throw new NativeInventoryInputError("Native inventory display selection is invalid");
	}
	// Copy before awaiting so caller mutation cannot change the selected query.
	const nativeIds = [...input.nativeIds];
	const page = await readNativeInventoryPageInternal(
		prisma,
		{
			userId: input.userId,
			instanceId: input.instanceId,
			expectedGenerationId: input.expectedGenerationId,
			expectedAuthority: input.expectedAuthority,
			now: input.now,
			maxAgeMs: input.maxAgeMs,
			domain: "library",
			limit: MAX_LIMIT,
		},
		nativeIds,
	);
	if (page.status !== "available") return page;
	return {
		status: "available",
		generationId: page.generationId,
		observedAt: page.observedAt,
		freshness: page.freshness,
		publicationItemCount: page.itemCount,
		rows: page.rows,
	};
}

async function readNativeInventoryPageInternal(
	prisma: PrismaClient,
	input: Parameters<typeof readNativeInventoryPage>[1],
	displayNativeIds?: readonly string[],
): Promise<NativeInventoryPage> {
	if (!isNonEmptySafeString(input.userId) || !isNonEmptySafeString(input.instanceId)) {
		throw new NativeInventoryInputError("Native inventory owner or instance is invalid");
	}
	if (
		input.expectedAuthority &&
		(input.expectedAuthority.id !== input.instanceId ||
			input.expectedAuthority.userId !== input.userId)
	) {
		throw new NativeInventoryInputError("Native inventory authority does not match the owner");
	}
	if (!isDomain(input.domain))
		throw new NativeInventoryInputError("Native inventory domain is invalid");
	if (input.afterNativeId !== undefined && !isNonEmptySafeString(input.afterNativeId)) {
		throw new NativeInventoryInputError("Native inventory cursor is invalid");
	}
	if (input.afterNativeId !== undefined && input.expectedGenerationId === undefined) {
		throw new NativeInventoryInputError("Native inventory cursor requires a generation");
	}
	if (
		input.expectedGenerationId !== undefined &&
		(input.expectedGenerationId.length > 500 || !isNonEmptySafeString(input.expectedGenerationId))
	) {
		throw new NativeInventoryInputError("Native inventory generation is invalid");
	}
	const limit = input.limit ?? DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new NativeInventoryInputError("Native inventory limit is invalid");
	}
	const now = input.now ?? new Date();
	const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	if (!isValidDate(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
		throw new NativeInventoryInputError("Native inventory freshness input is invalid");
	}

	return await prisma.$transaction(
		async (tx) => {
			const instance = await tx.serviceInstance.findFirst({
				where: input.expectedAuthority
					? providerPublicationPredicate(input.expectedAuthority)
					: { id: input.instanceId, userId: input.userId },
				select: {
					id: true,
					userId: true,
					service: true,
					baseUrl: true,
					enabled: true,
					encryptedApiKey: true,
					encryptionIv: true,
					encryptedHttpAuthCredentials: true,
					httpAuthEncryptionIv: true,
					expectedIdentity: true,
					identityStatus: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			});
			if (!instance)
				return {
					status: "unavailable",
					reason: input.expectedAuthority ? "identity-changed" : "not-owned",
				} as const;
			if (!isCurrentPublishableAuthority(instance)) {
				return {
					status: "unavailable",
					reason: instance.enabled ? "identity-changed" : "provider-unavailable",
				} as const;
			}
			const [attempt, snapshot] = await Promise.all([
				input.includeAttempt === true
					? readNativeAttemptProgress(tx, instance, input.domain)
					: null,
				tx.providerNativeInventorySnapshot.findUnique({
					where: { instanceId_domain: { instanceId: instance.id, domain: input.domain } },
				}),
			]);
			const attachAttempt = async <T extends { status: "available" | "unavailable" }>(result: T) =>
				attachNativeAttempt(
					result,
					input.includeAttempt === "unavailable" && result.status === "unavailable"
						? await readNativeAttemptProgress(tx, instance, input.domain)
						: attempt,
				);
			if (!snapshot?.generationId) {
				return attachAttempt({ status: "unavailable", reason: "no-publication" } as const);
			}
			if (
				input.expectedGenerationId !== undefined &&
				snapshot.generationId !== input.expectedGenerationId
			) {
				return attachAttempt({ status: "unavailable", reason: "snapshot-changed" } as const);
			}
			if (!isValidSnapshotMetadata(snapshot, instance, now)) {
				return attachAttempt({ status: "unavailable", reason: "malformed-publication" } as const);
			}
			const observedAt = snapshot.observedAt;
			if (!observedAt)
				return attachAttempt({ status: "unavailable", reason: "malformed-publication" } as const);
			const publishedPass = snapshot.publishedPassId
				? await tx.providerNativeInventoryPass.findUnique({
						where: { id: snapshot.publishedPassId },
						include: { run: true },
					})
				: null;
			if (
				snapshot.publishedPassId &&
				(!publishedPass ||
					publishedPass.state !== "complete" ||
					publishedPass.run.instanceId !== instance.id ||
					publishedPass.run.connectionGeneration !== instance.connectionGeneration ||
					publishedPass.run.identityGeneration !== instance.identityGeneration ||
					!(publishedPass.run.workKey === input.domain || publishedPass.run.workKey === "paired"))
			) {
				return attachAttempt({ status: "unavailable", reason: "malformed-publication" } as const);
			}
			// Ownership and pass authority are established before overlapping these reads.
			// Keep every count, prior-pass and row check inside the same snapshot transaction.
			const [itemCount, items, prior, newerUnpublishedRun] = await Promise.all([
				snapshot.publishedPassId
					? tx.providerNativeInventoryStageItem.count({
							where: { passId: snapshot.publishedPassId, domain: input.domain },
						})
					: tx.providerNativeInventoryItem.count({ where: { snapshotId: snapshot.id } }),
				snapshot.publishedPassId
					? tx.providerNativeInventoryStageItem.findMany({
							where: {
								passId: snapshot.publishedPassId,
								domain: input.domain,
								...(displayNativeIds ? { nativeId: { in: [...displayNativeIds] } } : {}),
								...(input.afterNativeId ? { nativeId: { gt: input.afterNativeId } } : {}),
							},
							orderBy: { nativeId: "asc" },
							take: limit + 1,
						})
					: tx.providerNativeInventoryItem.findMany({
							where: {
								snapshotId: snapshot.id,
								...(displayNativeIds ? { nativeId: { in: [...displayNativeIds] } } : {}),
								...(input.afterNativeId ? { nativeId: { gt: input.afterNativeId } } : {}),
							},
							orderBy: { nativeId: "asc" },
							take: limit + 1,
						}),
				publishedPass
					? tx.providerNativeInventoryPass.findUnique({
							where: {
								runId_ordinal: {
									runId: publishedPass.runId,
									ordinal: publishedPass.ordinal - 1,
								},
							},
						})
					: null,
				tx.providerNativeInventoryRun.findFirst({
					where: {
						instanceId: instance.id,
						workKey: { in: [input.domain, "paired"] },
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
						createdAt: { gte: observedAt },
						state: { not: "published" },
					},
					select: { id: true },
				}),
			]);
			if (itemCount !== snapshot.itemCount) {
				return attachAttempt({ status: "unavailable", reason: "malformed-publication" } as const);
			}
			const parsedRows = items.map((item) => parseStoredItem(item, input.domain));
			if (parsedRows.some((row) => row === null)) {
				return attachAttempt({ status: "unavailable", reason: "malformed-publication" } as const);
			}
			let rows = parsedRows as NativeInventoryRow[];
			if (publishedPass) {
				if (
					!prior ||
					prior.state !== "complete" ||
					prior.scopeDigest !== publishedPass.scopeDigest ||
					prior.comparisonDigest !== publishedPass.comparisonDigest
				) {
					return attachAttempt({ status: "unavailable", reason: "malformed-publication" } as const);
				}
				const priorItems = await tx.providerNativeInventoryStageItem.findMany({
					where: {
						passId: prior.id,
						domain: input.domain,
						nativeId: { in: rows.map((row) => row.nativeId) },
					},
				});
				const priorRows = priorItems.map((item) => parseStoredItem(item, input.domain));
				if (priorRows.some((row) => row === null) || priorRows.length !== rows.length) {
					return attachAttempt({ status: "unavailable", reason: "malformed-publication" } as const);
				}
				rows = reconcileNativeInventoryIdentifiers(priorRows as NativeInventoryRow[], rows);
			}
			const hasNext = rows.length > limit;
			const selected = rows.slice(0, limit);
			const freshness =
				snapshot.lastAttemptResult === "success" &&
				!newerUnpublishedRun &&
				now.getTime() - observedAt.getTime() <= maxAgeMs
					? "current"
					: "last-known";
			return attachAttempt({
				status: "available",
				generationId: snapshot.generationId,
				observedAt,
				itemCount: snapshot.itemCount,
				scopeCount: snapshot.scopeCount,
				lastAttemptAt: snapshot.lastAttemptAt,
				lastAttemptResult: snapshot.lastAttemptResult,
				lastAttemptReason: snapshot.lastAttemptReason,
				freshness,
				complete: freshness === "current",
				rows: selected,
				nextNativeId: hasNext ? (selected[selected.length - 1]?.nativeId ?? null) : null,
			} as const);
		},
		{ isolationLevel: "Serializable", maxWait: READ_TRANSACTION_MAX_WAIT_MS, timeout: 10_000 },
	);
}

/**
 * The exact publication reader above remains the only authority for absence.
 * A completed Jellyfin episode pass can still supply observed rows for display
 * when a moving catalog prevents two whole-library passes from agreeing.
 */
export async function readNativeInventoryDisplayPage(
	prisma: PrismaClient,
	input: Parameters<typeof readNativeInventoryPage>[1],
): Promise<NativeInventoryPage> {
	const authoritative = await readNativeInventoryPage(prisma, input);
	if (input.domain !== "episode") return authoritative;
	if (
		authoritative.status === "unavailable" &&
		["not-owned", "identity-changed", "provider-unavailable"].includes(authoritative.reason)
	) {
		return authoritative;
	}
	const pinnedPositive = input.expectedGenerationId?.startsWith("positive:") ?? false;
	if (input.expectedGenerationId && !pinnedPositive) return authoritative;
	const limit = input.limit ?? DEFAULT_LIMIT;
	const now = input.now ?? new Date();
	const positive = await prisma.$transaction(
		async (tx): Promise<NativeInventoryPage | null> => {
			const instance = await tx.serviceInstance.findFirst({
				where: input.expectedAuthority
					? providerPublicationPredicate(input.expectedAuthority)
					: { id: input.instanceId, userId: input.userId },
				select: {
					id: true,
					service: true,
					enabled: true,
					expectedIdentity: true,
					identityStatus: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			});
			if (
				!instance ||
				instance.service !== "JELLYFIN" ||
				!isCurrentPublishableAuthority(instance)
			) {
				return null;
			}
			const pass = await tx.providerNativeInventoryPass.findFirst({
				where: {
					state: "complete",
					completedAt: { not: null },
					episodeItemCount: { not: null },
					run: {
						instanceId: instance.id,
						workKey: "episode",
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
						state: { in: ["pending", "running", "ready", "incomplete"] },
					},
				},
				include: { run: true },
				orderBy: [{ completedAt: "desc" }, { id: "desc" }],
			});
			if (!pass) return null;
			const generationId = `positive:${pass.id}`;
			if (input.expectedGenerationId && input.expectedGenerationId !== generationId) {
				return { status: "unavailable", reason: "snapshot-changed" };
			}
			let manifest: unknown;
			try {
				manifest = JSON.parse(pass.scopeManifest ?? "");
			} catch {
				return { status: "unavailable", reason: "malformed-publication" };
			}
			const scopeKeys =
				Array.isArray(manifest) && manifest.length === 1 && manifest[0]?.domain === "episode"
					? manifest[0].scopeKeys
					: null;
			if (
				!isValidDate(pass.completedAt) ||
				pass.completedAt > now ||
				!isDigest(pass.scopeDigest) ||
				!isDigest(pass.comparisonDigest) ||
				!isSafeCount(pass.episodeItemCount) ||
				!Array.isArray(scopeKeys) ||
				scopeKeys.length > 10_000 ||
				scopeKeys.some((key: unknown) => !isNonEmptySafeString(key) || key.length > 512) ||
				new Set(scopeKeys).size !== scopeKeys.length
			) {
				return { status: "unavailable", reason: "malformed-publication" };
			}
			const itemCount = await tx.providerNativeInventoryStageItem.count({
				where: { passId: pass.id, domain: "episode" },
			});
			if (itemCount !== pass.episodeItemCount) {
				return { status: "unavailable", reason: "malformed-publication" };
			}
			const items = await tx.providerNativeInventoryStageItem.findMany({
				where: {
					passId: pass.id,
					domain: "episode",
					...(input.afterNativeId ? { nativeId: { gt: input.afterNativeId } } : {}),
				},
				orderBy: { nativeId: "asc" },
				take: limit + 1,
			});
			const parsed = items.map((item) => parseStoredItem(item, "episode"));
			if (parsed.some((row) => row === null)) {
				return { status: "unavailable", reason: "malformed-publication" };
			}
			const rows = (parsed as NativeInventoryRow[]).slice(0, limit);
			const attemptResult = pass.run.state === "incomplete" ? "failed" : "in_progress";
			const reason = attemptResult === "failed" ? pass.run.lastFailureCategory : null;
			return {
				status: "available",
				generationId,
				observedAt: pass.completedAt,
				itemCount,
				scopeCount: scopeKeys.length,
				lastAttemptAt: pass.run.updatedAt,
				lastAttemptResult: attemptResult,
				lastAttemptReason:
					reason === "provider-unavailable" || reason === "coverage-incomplete" ? reason : null,
				freshness: "last-known",
				complete: false,
				evidence: "positive-only",
				rows,
				nextNativeId: items.length > limit ? (rows[rows.length - 1]?.nativeId ?? null) : null,
			};
		},
		{ isolationLevel: "Serializable", maxWait: READ_TRANSACTION_MAX_WAIT_MS, timeout: 10_000 },
	);
	if (!positive) {
		return pinnedPositive ? { status: "unavailable", reason: "snapshot-changed" } : authoritative;
	}
	if (positive.status === "unavailable") {
		return pinnedPositive || authoritative.status === "unavailable" ? positive : authoritative;
	}
	if (
		!pinnedPositive &&
		authoritative.status === "available" &&
		authoritative.observedAt >= positive.observedAt
	) {
		return authoritative;
	}
	return authoritative.attempt ? { ...positive, attempt: authoritative.attempt } : positive;
}

function validateSnapshotInputs(
	snapshots: readonly NativeInventorySnapshotInput[],
	domains: readonly NativeInventoryDomain[],
): Array<NativeInventorySnapshotInput & { scopeDigest: string; contentDigest: string }> {
	if (!Array.isArray(snapshots) || snapshots.length !== domains.length) {
		throw new NativeInventoryInputError("Native inventory domains are incomplete");
	}
	const seen = new Set<NativeInventoryDomain>();
	return snapshots.map((snapshot) => {
		if (
			!isDomain(snapshot.domain) ||
			seen.has(snapshot.domain) ||
			!domains.includes(snapshot.domain)
		) {
			throw new NativeInventoryInputError("Native inventory domain is invalid or duplicated");
		}
		seen.add(snapshot.domain);
		if (!Array.isArray(snapshot.scopeKeys) || !Array.isArray(snapshot.rows)) {
			throw new NativeInventoryInputError("Native inventory snapshot input is invalid");
		}
		const scopeKeys = (snapshot.scopeKeys as readonly unknown[]).map((scopeKey: unknown) =>
			validateString(scopeKey, "scope key"),
		);
		if (new Set(scopeKeys).size !== scopeKeys.length) {
			throw new NativeInventoryInputError("Native inventory scope keys are duplicated");
		}
		const rows = (snapshot.rows as readonly NativeInventoryRow[]).map((row: NativeInventoryRow) =>
			validateRow(row, snapshot.domain),
		);
		if (new Set(rows.map((row) => row.nativeId)).size !== rows.length) {
			throw new NativeInventoryInputError("Native inventory native ids are duplicated");
		}
		return {
			domain: snapshot.domain,
			scopeKeys,
			rows,
			scopeDigest: digest(JSON.stringify([...scopeKeys].sort())),
			contentDigest: digestRows(rows),
		};
	});
}

export function validateNativeInventoryRow(
	value: NativeInventoryRow,
	domain: NativeInventoryDomain,
): NativeInventoryRow {
	if (!value || typeof value !== "object")
		throw new NativeInventoryInputError("Native inventory row is invalid");
	const nativeId = validateString(value.nativeId, "native id");
	const title = validateString(value.title, "title", true);
	if (
		!isMediaType(value.mediaType) ||
		(domain === "episode" ? value.mediaType !== "episode" : value.mediaType === "episode")
	) {
		throw new NativeInventoryInputError("Native inventory media type is invalid for its domain");
	}
	if (!Array.isArray(value.libraryIds) || value.libraryIds.length === 0) {
		throw new NativeInventoryInputError("Native inventory library ids are invalid");
	}
	const libraryIds = value.libraryIds.map((libraryId) => validateString(libraryId, "library id"));
	if (new Set(libraryIds).size !== libraryIds.length) {
		throw new NativeInventoryInputError("Native inventory library ids are duplicated");
	}
	const parentNativeId =
		value.parentNativeId === null ? null : validateString(value.parentNativeId, "parent native id");
	const seasonNumber = validateNumber(value.seasonNumber, "season number");
	const episodeNumber = validateNumber(value.episodeNumber, "episode number");
	const externalIds = normalizeNativeInventoryExternalIds(value.externalIds);
	return {
		nativeId,
		mediaType: value.mediaType,
		libraryIds,
		parentNativeId,
		seasonNumber,
		episodeNumber,
		title,
		...(hasNativeInventoryExternalIds(externalIds) ? { externalIds } : {}),
	};
}

const validateRow = validateNativeInventoryRow;

export function parseStoredItem(
	item: {
		nativeId: string;
		mediaType: string;
		libraryIds: string;
		parentNativeId: string | null;
		seasonNumber: number | null;
		episodeNumber: number | null;
		title: string;
		externalIds: string | null;
	},
	domain: NativeInventoryDomain,
): NativeInventoryRow | null {
	try {
		if (!isMediaType(item.mediaType)) return null;
		const externalIds = item.externalIds === null ? {} : JSON.parse(item.externalIds);
		const row = validateRow(
			{
				...item,
				mediaType: item.mediaType,
				libraryIds: JSON.parse(item.libraryIds),
				externalIds,
			},
			domain,
		);
		return item.externalIds === null ? { ...row, externalIds: {} } : row;
	} catch {
		return null;
	}
}

function digestRows(rows: readonly NativeInventoryRow[]): string {
	return digest(
		JSON.stringify(
			rows
				.map((row) => ({
					nativeId: row.nativeId,
					mediaType: row.mediaType,
					libraryIds: [...row.libraryIds],
					parentNativeId: row.parentNativeId,
					seasonNumber: row.seasonNumber,
					episodeNumber: row.episodeNumber,
					externalIds: row.externalIds ?? {},
				}))
				.sort((left, right) => left.nativeId.localeCompare(right.nativeId)),
		),
	);
}

export function normalizeNativeExternalId(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeNativeInventoryExternalIds(value: unknown): NativeInventoryExternalIds {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as { tmdb?: unknown; tvdb?: unknown };
	const normalizeList = (candidate: unknown): number[] | undefined => {
		if (!Array.isArray(candidate)) return undefined;
		const values = [
			...new Set(
				candidate
					.map((entry) => normalizeNativeExternalId(entry))
					.filter((entry): entry is number => entry !== undefined),
			),
		].sort((left, right) => left - right);
		return values.length > 0 ? values : undefined;
	};
	const tmdb = normalizeList(input.tmdb);
	const tvdb = normalizeList(input.tvdb);
	return {
		...(tmdb ? { tmdb } : {}),
		...(tvdb ? { tvdb } : {}),
	};
}

export function mergeNativeInventoryExternalIds(
	left: NativeInventoryExternalIds | undefined,
	right: NativeInventoryExternalIds | undefined,
): NativeInventoryExternalIds {
	return normalizeNativeInventoryExternalIds({
		tmdb: [...(left?.tmdb ?? []), ...(right?.tmdb ?? [])],
		tvdb: [...(left?.tvdb ?? []), ...(right?.tvdb ?? [])],
	});
}

/** Metadata drift must not invalidate complete native membership. Keep disagreements
 * ambiguous, and omit a family missing from either accepted observation pass. */
export function reconcileNativeInventoryIdentifiers(
	previous: readonly NativeInventoryRow[],
	current: readonly NativeInventoryRow[],
): NativeInventoryRow[] {
	const priorById = new Map(previous.map((row) => [row.nativeId, row]));
	return current.map((row) => {
		if (row.mediaType === "episode") {
			const prior = priorById.get(row.nativeId);
			const sameCoordinate =
				prior?.mediaType === "episode" &&
				prior.parentNativeId === row.parentNativeId &&
				prior.seasonNumber === row.seasonNumber &&
				prior.episodeNumber === row.episodeNumber;
			return sameCoordinate
				? row
				: { ...row, parentNativeId: null, seasonNumber: null, episodeNumber: null };
		}
		const prior = priorById.get(row.nativeId)?.externalIds;
		const merged = mergeNativeInventoryExternalIds(prior, row.externalIds);
		for (const family of ["tmdb", "tvdb"] as const) {
			if (!prior?.[family]?.length || !row.externalIds?.[family]?.length) delete merged[family];
		}
		const reconciled = { ...row };
		delete reconciled.externalIds;
		if (hasNativeInventoryExternalIds(merged)) reconciled.externalIds = merged;
		return reconciled;
	});
}

export function hasNativeInventoryExternalIds(
	value: NativeInventoryExternalIds | undefined,
): value is NativeInventoryExternalIds {
	return Boolean(value?.tmdb?.length || value?.tvdb?.length);
}

function isValidSnapshotMetadata(
	snapshot: {
		observedAt: Date | null;
		connectionGeneration: number | null;
		identityGeneration: number | null;
		scopeDigest: string | null;
		contentDigest: string | null;
		itemCount: number;
		scopeCount: number;
		lastAttemptAt: Date | null;
		lastAttemptToken: string | null;
		lastAttemptResult: string;
		lastAttemptReason: string | null;
	},
	instance: { connectionGeneration: number; identityGeneration: number },
	now: Date,
): boolean {
	return (
		isValidDate(snapshot.observedAt) &&
		snapshot.observedAt.getTime() <= now.getTime() &&
		snapshot.connectionGeneration === instance.connectionGeneration &&
		snapshot.identityGeneration === instance.identityGeneration &&
		isDigest(snapshot.scopeDigest) &&
		isDigest(snapshot.contentDigest) &&
		isSafeCount(snapshot.itemCount) &&
		isSafeCount(snapshot.scopeCount) &&
		isValidDate(snapshot.lastAttemptAt) &&
		snapshot.lastAttemptAt.getTime() <= now.getTime() &&
		(snapshot.lastAttemptResult === "success" ||
			snapshot.lastAttemptResult === "failed" ||
			snapshot.lastAttemptResult === "in_progress") &&
		(snapshot.lastAttemptResult === "success"
			? snapshot.lastAttemptToken === null && snapshot.lastAttemptReason === null
			: ATTEMPT_TOKEN_PATTERN.test(snapshot.lastAttemptToken ?? "") &&
				(snapshot.lastAttemptResult === "in_progress"
					? snapshot.lastAttemptReason === null
					: isFailureReason(snapshot.lastAttemptReason ?? "")))
	);
}

function providerPublicationPredicate(authority: ProviderPublicationAuthority) {
	return {
		id: authority.id,
		userId: authority.userId,
		service: authority.service,
		enabled: true,
		expectedIdentity: authority.expectedIdentity,
		identityStatus: "VERIFIED" as const,
		connectionGeneration: authority.connectionGeneration,
		identityGeneration: authority.identityGeneration,
		baseUrl: authority.baseUrl,
		encryptedApiKey: authority.encryptedApiKey,
		encryptionIv: authority.encryptionIv,
		encryptedHttpAuthCredentials: authority.encryptedHttpAuthCredentials,
		httpAuthEncryptionIv: authority.httpAuthEncryptionIv,
	};
}

function nativeInventoryAuthority(
	instance: NativeInventoryAuthorityInput,
): ProviderPublicationAuthority {
	return "identityKind" in instance ? createProviderPublicationAuthority(instance) : instance;
}

function isCurrentPublishableAuthority(authority: {
	service: string;
	enabled: boolean;
	expectedIdentity: string | null;
	identityStatus: string;
}): boolean {
	return (
		(authority.service === "PLEX" ||
			authority.service === "JELLYFIN" ||
			authority.service === "EMBY") &&
		authority.enabled &&
		authority.identityStatus === "VERIFIED" &&
		isNonEmptySafeString(authority.expectedIdentity)
	);
}

function normalizeDomains(
	domains: readonly NativeInventoryDomain[],
): readonly NativeInventoryDomain[] {
	if (!Array.isArray(domains) || domains.length === 0 || new Set(domains).size !== domains.length) {
		throw new NativeInventoryInputError("Native inventory domains are invalid");
	}
	for (const domain of domains)
		if (!isDomain(domain))
			throw new NativeInventoryInputError("Native inventory domain is invalid");
	return [...domains];
}

function validateString(value: unknown, field: string, allowEmpty = false): string {
	if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && value.trim() === "")) {
		throw new NativeInventoryInputError(`Native inventory ${field} is invalid`);
	}
	return value.trim();
}

function validateNumber(value: unknown, field: string): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new NativeInventoryInputError(`Native inventory ${field} is invalid`);
	}
	return value as number;
}

function isValidAttempt(attempt: NativeInventoryAttempt): boolean {
	return (
		!!attempt &&
		isValidDate(attempt.attemptedAt) &&
		ATTEMPT_TOKEN_PATTERN.test(attempt.resultMarker) &&
		Array.isArray(attempt.domains) &&
		attempt.domains.length > 0 &&
		new Set(attempt.domains).size === attempt.domains.length &&
		attempt.domains.every(isDomain)
	);
}

function isFailureReason(reason: string): reason is NativeInventoryFailureReason {
	return (
		reason === "provider-unavailable" ||
		reason === "coverage-incomplete" ||
		reason === "identity-changed"
	);
}

function isDomain(value: unknown): value is NativeInventoryDomain {
	return value === "library" || value === "episode";
}

function isMediaType(value: unknown): value is NativeInventoryMediaType {
	return value === "movie" || value === "series" || value === "episode";
}

function isNonEmptySafeString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isSafeCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDigest(value: string | null): value is string {
	return value !== null && DIGEST_PATTERN.test(value);
}

function sameDate(left: Date | null, right: Date): boolean {
	return left !== null && left.getTime() === right.getTime();
}

function isCurrentAttemptRow(
	row: {
		lastAttemptAt: Date | null;
		lastAttemptToken: string | null;
		lastAttemptResult: string;
	} | null,
	attempt: NativeInventoryAttempt,
): boolean {
	return (
		row?.lastAttemptResult === "in_progress" &&
		row.lastAttemptToken === attempt.resultMarker &&
		sameDate(row.lastAttemptAt, attempt.attemptedAt)
	);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
