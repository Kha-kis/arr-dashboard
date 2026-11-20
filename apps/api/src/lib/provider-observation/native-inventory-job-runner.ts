import type { PrismaClient } from "../prisma.js";
import type { NativeInventoryDomain, NativeInventoryRow } from "./native-inventory.js";
import {
	beginNativeInventoryPass,
	claimDueNativeInventoryRun,
	commitNativeInventoryPage,
	completeNativeInventoryPass,
	failNativeInventoryRun,
	isNativeInventoryDatabaseContention,
	type NativeInventoryFailureCategory,
	type NativeInventoryRunClaim,
	publishNativeInventoryRun,
	renewNativeInventoryRunLease,
	yieldNativeInventoryRun,
} from "./native-inventory-job-repository.js";

export type NativeInventoryJobUnavailable = {
	status: "unavailable";
	reason: "deadline-exceeded" | "provider-unavailable" | "coverage-incomplete";
};

export type NativeInventoryJobPage = {
	status: "page";
	domain: NativeInventoryDomain;
	scopeKey: string;
	startIndex: number;
	totalRecordCount: number;
	rawNativeIds: string[];
	comparisonKeys: Array<string | null>;
	rows: NativeInventoryRow[];
};

export type NativeInventoryJobAdapter<
	Scope extends { scopeKey: string; domain?: NativeInventoryDomain },
> = {
	domain: NativeInventoryDomain | "paired";
	discoverScopes(
		deadlineAt: number,
	): Promise<
		{ status: "ready"; catalogIdentity: string; scopes: Scope[] } | NativeInventoryJobUnavailable
	>;
	readPage(
		scope: Scope,
		startIndex: number,
		limit: number,
		deadlineAt: number,
	): Promise<NativeInventoryJobPage | NativeInventoryJobUnavailable>;
};

type NativeInventorySliceStatus =
	| "yielded"
	| "retryable"
	| "pass-complete"
	| "published"
	| "incomplete"
	| "coalesced"
	| "superseded";

export type NativeInventorySlicePhase =
	| "claim"
	| "identity"
	| "scope-discovery"
	| "pass-begin"
	| "lease-renewal"
	| "provider-page"
	| "page-commit"
	| "yield"
	| "pass-complete"
	| "publication"
	| "failure-settlement";

const MAX_INVOCATION_MS = 60_000;

function receiptCursor(
	receipts: Array<{
		startIndex: number;
		expectedRawCount: number;
		rawCount: number;
		nextCursor: string | null;
		isLast: boolean;
	}>,
): { startIndex: number; complete: boolean } | null {
	let cursor = 0;
	let total: number | null = null;
	for (const [index, receipt] of receipts.entries()) {
		if (receipt.startIndex !== cursor || (total !== null && total !== receipt.expectedRawCount)) {
			return null;
		}
		total = receipt.expectedRawCount;
		cursor += receipt.rawCount;
		if (
			cursor > total ||
			(receipt.isLast
				? cursor !== total || index !== receipts.length - 1
				: receipt.nextCursor !== String(cursor))
		) {
			return null;
		}
	}
	return { startIndex: cursor, complete: receipts.at(-1)?.isLast ?? false };
}

export async function runNativeInventoryJobSlice<
	Scope extends { scopeKey: string; domain?: NativeInventoryDomain },
>(
	prisma: PrismaClient,
	runId: string,
	adapter: NativeInventoryJobAdapter<Scope>,
	options: {
		signal?: AbortSignal;
		deadlineAt: number;
		maxPages: number;
		pageSize: number;
		retryDelayMs: number;
		verifyIdentity: () => Promise<"verified" | "unavailable" | "superseded">;
		reportPhase?: (phase: NativeInventorySlicePhase) => void;
	},
): Promise<{ status: NativeInventorySliceStatus; pagesCommitted: number }> {
	let pagesCommitted = 0;
	const startedAt = Date.now();
	const reportPhase = (phase: NativeInventorySlicePhase): void => {
		try {
			options.reportPhase?.(phase);
		} catch {
			// Diagnostics must not change the claim or publication result.
		}
	};
	if (
		!Number.isFinite(options.deadlineAt) ||
		options.deadlineAt - startedAt > MAX_INVOCATION_MS ||
		!Number.isSafeInteger(options.maxPages) ||
		options.maxPages < 1 ||
		options.maxPages > 20 ||
		!Number.isSafeInteger(options.pageSize) ||
		options.pageSize < 1 ||
		options.pageSize > 2_000 ||
		!Number.isSafeInteger(options.retryDelayMs) ||
		options.retryDelayMs < 0 ||
		options.retryDelayMs > 60 * 60_000
	) {
		return { status: "retryable", pagesCommitted };
	}
	if (options.signal?.aborted) return { status: "yielded", pagesCommitted };
	reportPhase("claim");
	if (options.signal?.aborted) return { status: "yielded", pagesCommitted };
	const acquired = await claimDueNativeInventoryRun(prisma, runId, new Date());
	if (acquired.status !== "acquired") return { status: acquired.status, pagesCommitted };
	let claim: NativeInventoryRunClaim = acquired.claim;
	const cancelled = Symbol("native-inventory-cancelled");
	const checkpoint = () => {
		if (options.signal?.aborted) throw cancelled;
	};
	const enterPhase = (phase: NativeInventorySlicePhase) => {
		checkpoint();
		reportPhase(phase);
		checkpoint();
	};
	const yieldClaim = async () => {
		reportPhase("yield");
		const result = await yieldNativeInventoryRun(prisma, claim, new Date());
		return { status: result.status, pagesCommitted };
	};
	const yieldContendedClaim = async () => {
		try {
			return await yieldClaim();
		} catch (error) {
			// A release that cannot acquire the writer leaves this exact bounded
			// lease intact. Only normal expiry may let another slice reclaim it.
			if (isNativeInventoryDatabaseContention(error))
				return { status: "retryable" as const, pagesCommitted };
			throw error;
		}
	};
	if (claim.workKey !== adapter.domain) {
		reportPhase("yield");
		const released = await yieldNativeInventoryRun(prisma, claim, new Date());
		return {
			status: released.status === "yielded" ? "superseded" : released.status,
			pagesCommitted,
		};
	}
	const fail = async (
		reason: NativeInventoryFailureCategory,
		retry: "bounded" | "none" = "bounded",
	): Promise<{
		status: NativeInventorySliceStatus;
		pagesCommitted: number;
	}> => {
		if (
			(reason === "provider-unavailable" || reason === "deadline-exceeded") &&
			Date.now() >= options.deadlineAt
		) {
			return await yieldClaim();
		}
		enterPhase("failure-settlement");
		const now = new Date();
		const current = await prisma.providerNativeInventoryRun.findUnique({
			where: { id: runId },
			select: { failureCount: true },
		});
		const nextAttemptAt =
			retry === "none" || !current || current.failureCount >= 2
				? null
				: new Date(now.getTime() + options.retryDelayMs);
		checkpoint();
		const result = await failNativeInventoryRun(prisma, claim, reason, nextAttemptAt, now);
		return {
			status: result.status === "scheduled" ? "retryable" : result.status,
			pagesCommitted,
		};
	};
	try {
		checkpoint();
		if (typeof options.verifyIdentity !== "function") return await fail("provider-unavailable");
		enterPhase("identity");
		const identity = await options.verifyIdentity().catch(() => "unavailable" as const);
		checkpoint();
		if (identity === "superseded") return { status: "superseded", pagesCommitted };
		if (identity !== "verified") return await fail("provider-unavailable");
		const pass = await prisma.providerNativeInventoryPass.findUnique({
			where: { runId_ordinal: { runId, ordinal: claim.passOrdinal } },
		});
		checkpoint();
		if (pass?.state === "complete") {
			if (claim.passOrdinal < 2) return { status: "superseded", pagesCommitted };
			enterPhase("identity");
			const identity = await options.verifyIdentity().catch(() => "unavailable" as const);
			checkpoint();
			if (identity === "superseded") return { status: "superseded", pagesCommitted };
			if (identity !== "verified") return await fail("provider-unavailable");
			enterPhase("publication");
			const published = await publishNativeInventoryRun(prisma, claim, new Date());
			return { status: published.status, pagesCommitted };
		}
		let discovery: Awaited<ReturnType<typeof adapter.discoverScopes>>;
		try {
			enterPhase("scope-discovery");
			discovery = await adapter.discoverScopes(options.deadlineAt);
			checkpoint();
		} catch {
			return await fail("provider-unavailable");
		}
		if (discovery.status !== "ready") {
			return await fail(
				discovery.reason === "deadline-exceeded" ? "deadline-exceeded" : discovery.reason,
			);
		}
		const domains =
			adapter.domain === "paired" ? (["library", "episode"] as const) : [adapter.domain];
		const manifest = {
			catalogIdentity: discovery.catalogIdentity,
			domains: domains.map((domain) => ({
				domain,
				scopeKeys: discovery.scopes
					.filter((scope) => (scope.domain ?? adapter.domain) === domain)
					.map((scope) => scope.scopeKey),
			})),
		};
		enterPhase("pass-begin");
		const begun = await beginNativeInventoryPass(prisma, claim, manifest, new Date());
		checkpoint();
		if (begun.status === "superseded") return { status: "superseded", pagesCommitted };
		if (begun.status === "contended") return await yieldContendedClaim();
		if (begun.status === "retryable") return await fail("coverage-incomplete");
		const currentPass = await prisma.providerNativeInventoryPass.findUnique({
			where: { runId_ordinal: { runId, ordinal: claim.passOrdinal } },
		});
		checkpoint();
		if (!currentPass || currentPass.state !== "collecting") return await fail("database-retryable");
		for (const scope of discovery.scopes) {
			checkpoint();
			const domain = scope.domain ?? (adapter.domain === "paired" ? null : adapter.domain);
			if (!domain) return await fail("coverage-incomplete");
			const receipts = await prisma.providerNativeInventoryPageReceipt.findMany({
				where: { passId: currentPass.id, domain, scopeKey: scope.scopeKey },
				orderBy: { startIndex: "asc" },
				select: {
					startIndex: true,
					expectedRawCount: true,
					rawCount: true,
					nextCursor: true,
					isLast: true,
				},
			});
			checkpoint();
			const resume = receiptCursor(receipts);
			if (!resume) return await fail("coverage-incomplete");
			let startIndex = resume.startIndex;
			let scopeComplete = resume.complete;
			while (!scopeComplete) {
				if (pagesCommitted >= options.maxPages || Date.now() >= options.deadlineAt) {
					reportPhase("yield");
					const yielded = await yieldNativeInventoryRun(prisma, claim, new Date());
					return { status: yielded.status, pagesCommitted };
				}
				enterPhase("lease-renewal");
				const renewed = await renewNativeInventoryRunLease(prisma, claim, new Date());
				if (renewed.status !== "renewed") return { status: renewed.status, pagesCommitted };
				claim = renewed.claim;
				checkpoint();
				let page: Awaited<ReturnType<typeof adapter.readPage>>;
				try {
					enterPhase("provider-page");
					page = await adapter.readPage(scope, startIndex, options.pageSize, options.deadlineAt);
					checkpoint();
				} catch {
					return await fail("provider-unavailable");
				}
				if (page.status !== "page") {
					return await fail(
						page.reason === "deadline-exceeded" ? "deadline-exceeded" : page.reason,
					);
				}
				if (
					page.domain !== domain ||
					page.scopeKey !== scope.scopeKey ||
					page.startIndex !== startIndex
				) {
					return await fail("coverage-incomplete");
				}
				const nextIndex = startIndex + page.rawNativeIds.length;
				scopeComplete = nextIndex === page.totalRecordCount;
				enterPhase("page-commit");
				const committed = await commitNativeInventoryPage(
					prisma,
					claim,
					{
						domain,
						scopeKey: scope.scopeKey,
						pageKey: String(startIndex),
						nextCursor: scopeComplete ? null : String(nextIndex),
						isLast: scopeComplete,
						expectedRawCount: page.totalRecordCount,
						rawNativeIds: page.rawNativeIds,
						comparisonKeys: page.comparisonKeys,
					},
					page.rows,
					new Date(),
				);
				if (committed.status === "superseded") return { status: "superseded", pagesCommitted };
				if (committed.status === "contended") return await yieldContendedClaim();
				if (committed.status === "drifted") return await fail("coverage-incomplete", "none");
				if (committed.status === "retryable") return await fail("coverage-incomplete");
				if (committed.status === "recorded") pagesCommitted++;
				checkpoint();
				startIndex = nextIndex;
			}
		}
		let end: Awaited<ReturnType<typeof adapter.discoverScopes>>;
		try {
			enterPhase("scope-discovery");
			end = await adapter.discoverScopes(options.deadlineAt);
			checkpoint();
		} catch {
			return await fail("provider-unavailable");
		}
		if (end.status !== "ready") {
			return await fail(end.reason === "deadline-exceeded" ? "deadline-exceeded" : end.reason);
		}
		enterPhase("pass-complete");
		const completed = await completeNativeInventoryPass(
			prisma,
			claim,
			end.catalogIdentity,
			new Date(),
		);
		if (completed.status === "superseded") return { status: "superseded", pagesCommitted };
		if (completed.status === "contended") return await yieldContendedClaim();
		if (completed.status !== "completed") return await fail("coverage-incomplete");
		// First-pass completion has already released this exact claim atomically.
		if (claim.passOrdinal === 1) return { status: "pass-complete", pagesCommitted };
		checkpoint();
		enterPhase("identity");
		const identityBeforePublish = await options
			.verifyIdentity()
			.catch(() => "unavailable" as const);
		checkpoint();
		if (identityBeforePublish === "superseded") return { status: "superseded", pagesCommitted };
		if (identityBeforePublish !== "verified") return await fail("provider-unavailable");
		enterPhase("publication");
		const published = await publishNativeInventoryRun(prisma, claim, new Date());
		return { status: published.status, pagesCommitted };
	} catch (error) {
		if (error === cancelled || options.signal?.aborted) {
			try {
				return await yieldClaim();
			} catch {
				throw new Error("Native inventory cancellation could not be persisted");
			}
		}
		if (isNativeInventoryDatabaseContention(error)) return await yieldContendedClaim();
		try {
			return await fail("database-retryable");
		} catch {
			if (options.signal?.aborted) {
				try {
					return await yieldClaim();
				} catch {
					throw new Error("Native inventory cancellation could not be persisted");
				}
			}
			throw new Error("Native inventory failure state could not be persisted");
		}
	}
}
