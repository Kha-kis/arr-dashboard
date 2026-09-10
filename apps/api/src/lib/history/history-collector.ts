import { createHash } from "node:crypto";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { normalizeHistoryObservation } from "../dashboard/history-utils.js";
import type { PrismaClientInstance } from "../prisma.js";
import {
	acquireHistoryCollectionLease,
	type HistoryCollectionLeaseClaim,
	type HistoryLeaseDialect,
	heartbeatHistoryCollectionLease,
	releaseHistoryCollectionLease,
} from "./history-collection-lease.js";
import {
	type HistoryObservationPageReceipt,
	type HistoryObservationPublicationResult,
	publishHistoryObservations,
} from "./history-observation-publication-repository.js";
import { fetchHistoryProviderPage } from "./history-provider-adapters.js";
import {
	beginHistorySourceAttempt,
	deferHistorySourceAttemptBeforeProvider,
	finishHistorySourceAttemptFailure,
	HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS,
	type HistorySourceProviderPreparedAttempt,
	type HistorySourceProviderStartedAttempt,
	markHistorySourceAttemptProviderStarted,
	parseHistorySourceAttemptMarker,
} from "./history-source-attempt.js";
import {
	HISTORY_COLLECTION_MAX_DURATION_MS,
	HISTORY_COLLECTION_MAX_RAW_ROWS,
	HISTORY_COLLECTION_MAX_REQUESTS,
	HISTORY_COLLECTION_MAX_SOURCE_TURNS,
	HISTORY_COLLECTION_MAX_TURNS_PER_SOURCE,
	HISTORY_COLLECTION_PAGE_SIZE,
	HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS,
	HISTORY_SERVICE_TYPES,
	historyServiceTypeToService,
	isHistoryServiceType,
} from "./history-source-contract.js";
import {
	deriveHistorySourceFailureSuccessor,
	deriveHistorySourcePageResult,
	type HistorySourcePageReceipt,
	type HistorySourcePhase,
} from "./history-source-schedule.js";

export type HistoryCollectorRunResult = {
	status: "completed" | "lease-unavailable" | "superseded" | "failed";
	candidateSourceCount: number;
	sourceTurnCount: number;
	providerRequestCount: number;
	rawRecordCount: number;
	publishedTurnCount: number;
	preservedTurnCount: number;
	supersededTurnCount: number;
	failedTurnCount: number;
	sourceSetTruncated: boolean;
	limitReason: null | "request-limit" | "row-limit" | "turn-limit" | "time-limit";
	leaseReleased: boolean;
	durationMs: number;
};
type Options = { dialect?: HistoryLeaseDialect };
type FinishResult = "recorded" | "superseded" | "failed";
type Entry = { id: string; turns: number; phases: Set<HistorySourcePhase> };
type ExecInstance = {
	id: string;
	service: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials: string | null;
	httpAuthEncryptionIv: string | null;
	connectionGeneration: number;
};
type Counters = Omit<HistoryCollectorRunResult, "status" | "leaseReleased" | "durationMs">;
type Fn<T extends (...args: never[]) => unknown> = T;

export type HistoryCollectorDependencies = {
	prisma: PrismaClientInstance;
	clientFactory: Pick<ArrClientFactory, "createAnyClient">;
	acquireLease?: Fn<typeof acquireHistoryCollectionLease>;
	heartbeatLease?: Fn<typeof heartbeatHistoryCollectionLease>;
	releaseLease?: Fn<typeof releaseHistoryCollectionLease>;
	beginAttempt?: Fn<typeof beginHistorySourceAttempt>;
	markProviderStarted?: Fn<typeof markHistorySourceAttemptProviderStarted>;
	deferAttempt?: Fn<typeof deferHistorySourceAttemptBeforeProvider>;
	finishAttemptFailure?: Fn<typeof finishHistorySourceAttemptFailure>;
	fetchProviderPage?: Fn<typeof fetchHistoryProviderPage>;
	normalizeObservation?: Fn<typeof normalizeHistoryObservation>;
	publishObservations?: Fn<typeof publishHistoryObservations>;
	monotonicNow?: () => number;
	dialect?: HistoryLeaseDialect;
};

const blank = (): Counters => ({
	candidateSourceCount: 0,
	sourceTurnCount: 0,
	providerRequestCount: 0,
	rawRecordCount: 0,
	publishedTurnCount: 0,
	preservedTurnCount: 0,
	supersededTurnCount: 0,
	failedTurnCount: 0,
	sourceSetTruncated: false,
	limitReason: null,
});

export async function collectHistoryObservationsForOwner(
	d: HistoryCollectorDependencies,
	userId: string,
): Promise<HistoryCollectorRunResult> {
	const c = blank();
	let status: HistoryCollectorRunResult["status"] = "completed";
	let leaseReleased = false;
	const readClock = d.monotonicNow ?? (() => performance.now());
	let first: number | null = null;
	let previous: number | null = null;
	let badClock = false;
	const clock = (): number | null => {
		try {
			const n = readClock();
			if (!Number.isFinite(n) || n < 0 || (previous !== null && n < previous)) {
				badClock = true;
				return null;
			}
			previous = n;
			return n;
		} catch {
			badClock = true;
			return null;
		}
	};
	const initial = clock();
	if (initial === null) return output("failed", c, false, 240_001);
	first = initial;
	const options: Options = d.dialect ? { dialect: d.dialect } : {};
	const finishOutput = (): HistoryCollectorRunResult => {
		const end = clock();
		if (end === null || first === null || badClock) {
			status = "failed";
			return output(status, c, leaseReleased, 240_001);
		}
		return output(
			status,
			c,
			leaseReleased,
			Math.min(240_001, Math.max(0, Math.floor(end - first))),
		);
	};
	const acquire = d.acquireLease ?? acquireHistoryCollectionLease;
	const beat = d.heartbeatLease ?? heartbeatHistoryCollectionLease;
	const release = d.releaseLease ?? releaseHistoryCollectionLease;
	let claim: HistoryCollectionLeaseClaim;
	try {
		const value: unknown = await acquire(d.prisma, userId, options);
		if (value === null) return withStatus("lease-unavailable", finishOutput());
		if (!validClaim(value, userId)) return withStatus("failed", finishOutput());
		claim = value;
	} catch {
		return withStatus("failed", finishOutput());
	}
	const setStatus = (s: "failed" | "superseded") => {
		if (s === "failed" || status === "completed") status = s;
	};
	const persist = async (cursor: string | null): Promise<boolean> => {
		try {
			const value: unknown = await beat(d.prisma, claim, cursor, options);
			if (value === true) return true;
			setStatus(value === false ? "superseded" : "failed");
			return false;
		} catch {
			setStatus("failed");
			return false;
		}
	};
	const begin = d.beginAttempt ?? beginHistorySourceAttempt;
	const start = d.markProviderStarted ?? markHistorySourceAttemptProviderStarted;
	const defer = d.deferAttempt ?? deferHistorySourceAttemptBeforeProvider;
	const fail = d.finishAttemptFailure ?? finishHistorySourceAttemptFailure;
	const fetch = d.fetchProviderPage ?? fetchHistoryProviderPage;
	const normalize = d.normalizeObservation ?? normalizeHistoryObservation;
	const publish = d.publishObservations ?? publishHistoryObservations;
	let classifyCurrent: (() => void) | null = null;
	try {
		const all = await discover(d.prisma, userId, claim.nextSourceCursor);
		c.candidateSourceCount = all.length;
		c.sourceSetTruncated = all.length === 101;
		const ids = all.slice(0, 100);
		const sentinel = all[100];
		const queue: Entry[] = ids.map((id) => ({ id, turns: 0, phases: new Set() }));
		const nextCursor = (current?: string): string | null => {
			if (queue.length) return queue[0]!.id;
			if (sentinel !== undefined && c.sourceTurnCount >= 100) return sentinel;
			if (!ids.length) return null;
			if (current === undefined) return ids[0]!;
			const i = ids.indexOf(current);
			return ids[(i + 1 + ids.length) % ids.length]!;
		};
		if (!queue.length) await persist(null);
		while (queue.length && status === "completed") {
			const admission = check(c, clock(), first);
			if (admission.invalid) {
				status = "failed";
				break;
			}
			if (admission.reason) {
				c.limitReason = admission.reason;
				await persist(sentinel !== undefined && c.sourceTurnCount >= 100 ? sentinel : nextCursor());
				break;
			}
			const entry = queue.shift()!;
			entry.turns += 1;
			c.sourceTurnCount += 1;
			const cursor = nextCursor(entry.id);
			let classified = false;
			const count = (kind: "published" | "preserved" | "superseded" | "failed") => {
				if (classified) return;
				classified = true;
				if (kind === "published") c.publishedTurnCount++;
				else if (kind === "preserved") c.preservedTurnCount++;
				else if (kind === "superseded") c.supersededTurnCount++;
				else c.failedTurnCount++;
			};
			classifyCurrent = () => count("failed");
			let prepared: HistorySourceProviderPreparedAttempt | null;
			try {
				prepared = await begin(
					d.prisma,
					{ userId, instanceId: entry.id, leaseClaim: claim },
					options,
				);
			} catch {
				count("failed");
				status = "failed";
				break;
			}
			if (prepared === null) {
				count("superseded");
				if (!(await persist(cursor))) break;
				continue;
			}
			if (!validPrepared(prepared, userId, entry.id, claim.claimToken)) {
				count("failed");
				status = "failed";
				break;
			}
			if (entry.phases.has(prepared.phase)) {
				const r = await finishAttempt(d.prisma, fail, prepared, claim, "unknown-failure", options);
				count(map(r));
				if (r === "failed") status = "failed";
				else if (!(await persist(cursor))) break;
				continue;
			}
			entry.phases.add(prepared.phase);
			let instance: ExecInstance | null = null;
			try {
				instance = (await d.prisma.serviceInstance.findFirst({
					where: {
						id: entry.id,
						userId,
						enabled: true,
						service: { in: [...HISTORY_SERVICE_TYPES] },
						connectionGeneration: prepared.connectionGeneration,
					},
					select: {
						id: true,
						service: true,
						baseUrl: true,
						encryptedApiKey: true,
						encryptionIv: true,
						encryptedHttpAuthCredentials: true,
						httpAuthEncryptionIv: true,
						connectionGeneration: true,
					},
				})) as ExecInstance | null;
			} catch {
				instance = null;
			}
			if (!instance || !validInstance(instance, prepared)) {
				const r = await finishAttempt(d.prisma, fail, prepared, claim, "unknown-failure", options);
				count(map(r));
				if (r === "failed") status = "failed";
				if (r === "recorded" && requeue(entry, deriveHistorySourceFailureSuccessor(prepared).phase))
					queue.push(entry);
				if (!(await persist(nextCursor(entry.id)))) break;
				if (r === "failed") break;
				continue;
			}
			let client: ReturnType<ArrClientFactory["createAnyClient"]>;
			try {
				client = d.clientFactory.createAnyClient(instance as never, {
					timeout: HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS,
				});
			} catch {
				const r = await finishAttempt(d.prisma, fail, prepared, claim, "unknown-failure", options);
				count(map(r));
				if (r === "failed") status = "failed";
				if (r === "recorded" && requeue(entry, deriveHistorySourceFailureSuccessor(prepared).phase))
					queue.push(entry);
				if (!(await persist(nextCursor(entry.id)))) break;
				if (r === "failed") break;
				continue;
			}
			const before = check(c, clock(), first, false);
			if (before.invalid) {
				const r = await finishAttempt(d.prisma, fail, prepared, claim, "unknown-failure", options);
				count(map(r));
				status = "failed";
				await persist(cursor);
				break;
			}
			if (before.reason) {
				c.limitReason = before.reason;
				let r: FinishResult;
				try {
					const x: unknown = await defer(d.prisma, { ...prepared, leaseClaim: claim }, options);
					r = isFinish(x) ? x : "failed";
				} catch {
					r = "failed";
				}
				count(map(r));
				if (r === "failed") status = "failed";
				else await persist(cursor);
				break;
			}
			let started: HistorySourceProviderStartedAttempt;
			try {
				const x: unknown = await start(d.prisma, { ...prepared, leaseClaim: claim }, options);
				if (!isStart(x, prepared, claim.claimToken)) {
					count("failed");
					status = "failed";
					break;
				}
				if (x.kind !== "started") {
					count(x.kind);
					if (x.kind === "failed") status = "failed";
					else if (!(await persist(cursor))) break;
					continue;
				}
				started = x.attempt;
			} catch {
				count("failed");
				status = "failed";
				break;
			}
			const after = clock();
			if (
				after === null ||
				first === null ||
				after - first >= HISTORY_COLLECTION_MAX_DURATION_MS - HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS
			) {
				if (after !== null) c.limitReason = "time-limit";
				const r = await finishAttempt(d.prisma, fail, started, claim, "unknown-failure", options);
				count(map(r));
				if (r === "failed" || after === null) status = "failed";
				else await persist(cursor);
				break;
			}
			c.providerRequestCount++;
			let page: unknown;
			let rejected = false;
			try {
				page = await fetch({
					service: historyServiceTypeToService(instance.service as never),
					client,
					page: started.collectionPage,
				});
			} catch {
				rejected = true;
			}
			const rawCount = rejected ? 0 : pageCount(page);
			c.rawRecordCount =
				rawCount >= HISTORY_COLLECTION_MAX_RAW_ROWS + 1 - c.rawRecordCount
					? HISTORY_COLLECTION_MAX_RAW_ROWS + 1
					: c.rawRecordCount + rawCount;
			if (!(await persist(cursor))) {
				count(
					(status as HistoryCollectorRunResult["status"]) === "failed" ? "failed" : "superseded",
				);
				break;
			}
			if (rejected) {
				const r = await finishAttempt(
					d.prisma,
					fail,
					started,
					claim,
					"provider-unavailable",
					options,
				);
				count(map(r));
				if (r === "failed") {
					status = "failed";
					break;
				}
				if (r === "recorded" && requeue(entry, deriveHistorySourceFailureSuccessor(started).phase))
					queue.push(entry);
				if (!(await persist(nextCursor(entry.id)))) break;
				continue;
			}
			const receipt = receiptFor(page, rawCount, normalize, instance.service);
			let publication: HistoryObservationPublicationResult;
			try {
				const x: unknown = await publish(
					{ attempt: started, leaseClaim: claim, receipt },
					d.prisma,
				);
				publication = validPublication(x) ? x : { kind: "failed" };
			} catch {
				publication = { kind: "failed" };
			}
			if (publication.kind === "published") {
				count("published");
				if (receipt.kind === "completed") {
					const p = deriveHistorySourcePageResult(started, receipt);
					if (p.result === "success" && requeue(entry, p.successor.phase)) queue.push(entry);
				}
			} else if (publication.kind === "preserved") {
				count("preserved");
				if (requeue(entry, deriveHistorySourceFailureSuccessor(started).phase)) queue.push(entry);
			} else if (publication.kind === "superseded") count("superseded");
			else {
				count("failed");
				status = "failed";
				try {
					await fail(
						d.prisma,
						{ ...started, leaseClaim: claim, reason: "unknown-failure" },
						options,
					);
				} catch {
					/* sanitized cleanup */
				}
			}
			if (!(await persist(nextCursor(entry.id)))) break;
		}
		if (
			status === "completed" &&
			c.sourceTurnCount >= HISTORY_COLLECTION_MAX_SOURCE_TURNS &&
			sentinel !== undefined
		) {
			c.limitReason = "turn-limit";
			await persist(sentinel);
		} else if (status === "completed" && ids.length > 0 && queue.length === 0)
			await persist(nextCursor());
	} catch {
		classifyCurrent?.();
		status = "failed";
	} finally {
		try {
			const x: unknown = await release(d.prisma, claim!, options);
			if (x === true) leaseReleased = true;
			else if (x === false) {
				if (status === "completed") status = "superseded";
			} else status = "failed";
		} catch {
			status = "failed";
		}
	}
	return finishOutput();
}

function output(
	status: HistoryCollectorRunResult["status"],
	c: Counters,
	leaseReleased: boolean,
	durationMs: number,
): HistoryCollectorRunResult {
	return { status, ...c, leaseReleased, durationMs };
}
function withStatus(
	status: HistoryCollectorRunResult["status"],
	value: HistoryCollectorRunResult,
): HistoryCollectorRunResult {
	return { ...value, status };
}
async function discover(
	prisma: PrismaClientInstance,
	userId: string,
	cursor: string | null,
): Promise<string[]> {
	const base = { userId, enabled: true, service: { in: [...HISTORY_SERVICE_TYPES] } };
	const first = await prisma.serviceInstance.findMany({
		where: cursor === null ? base : { ...base, id: { gte: cursor } },
		orderBy: { id: "asc" },
		select: { id: true },
		take: 101,
	});
	const parse = (x: unknown): string[] => {
		if (!Array.isArray(x)) throw new Error("discovery");
		return x.map((r) => {
			if (!isRecord(r) || Object.keys(r).length !== 1 || !safeText(r.id, 256))
				throw new Error("discovery");
			return r.id;
		});
	};
	const ids = parse(first);
	if (cursor === null || ids.length === 101) return ids.slice(0, 101);
	const second = await prisma.serviceInstance.findMany({
		where: { ...base, id: { lt: cursor } },
		orderBy: { id: "asc" },
		select: { id: true },
		take: 101 - ids.length,
	});
	return [...ids, ...parse(second)].slice(0, 101);
}
async function finishAttempt(
	prisma: PrismaClientInstance,
	fn: typeof finishHistorySourceAttemptFailure,
	attempt: HistorySourceProviderPreparedAttempt | HistorySourceProviderStartedAttempt,
	claim: HistoryCollectionLeaseClaim,
	reason: "provider-unavailable" | "unknown-failure",
	options: Options,
): Promise<FinishResult> {
	try {
		const x: unknown = await fn(prisma, { ...attempt, leaseClaim: claim, reason }, options);
		return isFinish(x) ? x : "failed";
	} catch {
		return "failed";
	}
}
function validClaim(x: unknown, userId: string): x is HistoryCollectionLeaseClaim {
	if (
		!isExact(x, [
			"claimToken",
			"claimedAt",
			"expiresAt",
			"heartbeatAt",
			"nextSourceCursor",
			"userId",
		])
	)
		return false;
	const c = x as Record<string, unknown>;
	return (
		c.userId === userId &&
		safeText(c.claimToken, 128) &&
		isDate(c.claimedAt) &&
		isDate(c.heartbeatAt) &&
		isDate(c.expiresAt) &&
		(c.nextSourceCursor === null || safeText(c.nextSourceCursor, 256))
	);
}
function validPrepared(
	x: unknown,
	userId: string,
	id: string,
	token: string,
): x is HistorySourceProviderPreparedAttempt {
	if (
		!isExact(x, [
			"attemptedAt",
			"backfillPage",
			"collectionPage",
			"connectionGeneration",
			"instanceId",
			"phase",
			"resultMarker",
			"userId",
		])
	)
		return false;
	const a = x as Record<string, unknown>;
	const marker = parseHistorySourceAttemptMarker(a.resultMarker);
	return (
		a.userId === userId &&
		a.instanceId === id &&
		isDate(a.attemptedAt) &&
		safeGeneration(a.connectionGeneration) &&
		((a.phase === "head" && a.collectionPage === 1 && safePage(a.backfillPage)) ||
			(a.phase === "backfill" &&
				safePage(a.collectionPage) &&
				a.collectionPage === a.backfillPage)) &&
		marker?.stage === "prepared" &&
		marker.fingerprint === hash(token)
	);
}
function validInstance(x: ExecInstance, a: HistorySourceProviderPreparedAttempt): boolean {
	return (
		isExact(x, [
			"baseUrl",
			"connectionGeneration",
			"encryptedApiKey",
			"encryptedHttpAuthCredentials",
			"encryptionIv",
			"httpAuthEncryptionIv",
			"id",
			"service",
		]) &&
		x.id === a.instanceId &&
		x.connectionGeneration === a.connectionGeneration &&
		isHistoryServiceType(x.service) &&
		typeof x.baseUrl === "string" &&
		typeof x.encryptedApiKey === "string" &&
		typeof x.encryptionIv === "string" &&
		(x.encryptedHttpAuthCredentials === null ||
			typeof x.encryptedHttpAuthCredentials === "string") &&
		(x.httpAuthEncryptionIv === null || typeof x.httpAuthEncryptionIv === "string")
	);
}
function isStart(
	x: unknown,
	p: HistorySourceProviderPreparedAttempt,
	token: string,
): x is
	| { kind: "started"; attempt: HistorySourceProviderStartedAttempt }
	| { kind: "superseded" | "failed" } {
	if (!isRecord(x) || !["started", "superseded", "failed"].includes(String(x.kind))) return false;
	if (x.kind !== "started") return Object.keys(x).length === 1;
	return isExact(x, ["attempt", "kind"]) && validStarted(x.attempt, p, token);
}
function validStarted(
	x: unknown,
	p: HistorySourceProviderPreparedAttempt,
	token: string,
): x is HistorySourceProviderStartedAttempt {
	if (
		!isExact(x, [
			"attemptedAt",
			"backfillPage",
			"collectionPage",
			"connectionGeneration",
			"instanceId",
			"phase",
			"resultMarker",
			"userId",
		])
	)
		return false;
	const a = x as Record<string, unknown>;
	const pm = parseHistorySourceAttemptMarker(p.resultMarker);
	const m = parseHistorySourceAttemptMarker(a.resultMarker);
	return (
		a.userId === p.userId &&
		a.instanceId === p.instanceId &&
		a.connectionGeneration === p.connectionGeneration &&
		isDate(a.attemptedAt) &&
		a.attemptedAt.getTime() === p.attemptedAt.getTime() &&
		a.phase === p.phase &&
		a.collectionPage === p.collectionPage &&
		a.backfillPage === p.backfillPage &&
		m?.stage === "started" &&
		m.fingerprint === hash(token) &&
		m.uuid === pm?.uuid
	);
}
function pageCount(x: unknown): number {
	return isRecord(x) &&
		typeof x.rawRecordCount === "number" &&
		Number.isSafeInteger(x.rawRecordCount) &&
		x.rawRecordCount >= 0
		? x.rawRecordCount
		: 0;
}
function receiptFor(
	x: unknown,
	count: number,
	normalize: typeof normalizeHistoryObservation,
	service: string,
): HistoryObservationPageReceipt {
	if (count > HISTORY_COLLECTION_PAGE_SIZE)
		return { kind: "adapter-invalid", rawRecordCount: count };
	if (
		!isRecord(x) ||
		x.kind !== "page" ||
		!Array.isArray(x.records) ||
		x.records.length !== count ||
		x.rawRecordCount !== count ||
		!("totalRecordsHint" in x)
	)
		return { kind: "adapter-invalid", rawRecordCount: count };
	const hint: unknown = x.totalRecordsHint;
	if (hint !== null && (typeof hint !== "number" || !Number.isSafeInteger(hint) || hint < 0))
		return { kind: "adapter-invalid", rawRecordCount: count };
	const rows: Array<HistorySourcePageReceipt["normalizedRows"][number]> = [];
	for (const raw of x.records) {
		try {
			const n: unknown = normalize(raw, historyServiceTypeToService(service as never));
			const observation = isRecord(n) && isRecord(n.observation) ? n.observation : undefined;
			if (
				isRecord(n) &&
				n.ok === true &&
				observation !== undefined &&
				isExact(observation, ["normalizedPayload", "payload", "searchText"]) &&
				typeof observation.normalizedPayload === "string" &&
				typeof observation.searchText === "string" &&
				isRecord(observation.payload)
			)
				rows.push(observation as never);
		} catch {
			/* malformed row */
		}
	}
	return {
		kind: "completed",
		rawRecordCount: count,
		normalizedRows: rows,
		totalRecordsHint: hint as number | null,
	};
}
function validPublication(x: unknown): x is HistoryObservationPublicationResult {
	if (!isRecord(x) || typeof x.kind !== "string") return false;
	if (x.kind === "failed" || x.kind === "superseded") return isExact(x, ["kind"]);
	if (x.kind === "preserved")
		return (
			isExact(x, ["finish", "kind", "reason"]) &&
			x.finish === "recorded" &&
			typeof x.reason === "string" &&
			(HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS as readonly string[]).includes(x.reason)
		);
	if (
		x.kind !== "published" ||
		!isExact(x, [
			"deletedObservationCount",
			"finish",
			"kind",
			"publishedObservationCount",
			"retainedObservationCount",
		])
	)
		return false;
	if (
		!safeCount(x.publishedObservationCount) ||
		!safeCount(x.retainedObservationCount) ||
		!safeCount(x.deletedObservationCount) ||
		!isRecord(x.finish) ||
		!isExact(x.finish, ["reason", "result"])
	)
		return false;
	return (
		(x.finish.result === "success" && x.finish.reason === null) ||
		(x.finish.result === "error" &&
			typeof x.finish.reason === "string" &&
			["provider-unavailable", "provider-limit"].includes(x.finish.reason))
	);
}
function check(
	c: Counters,
	n: number | null,
	first: number | null,
	includeTurn = true,
): { invalid: boolean; reason: HistoryCollectorRunResult["limitReason"] } {
	if (n === null || first === null) return { invalid: true, reason: null };
	if (includeTurn && c.sourceTurnCount >= HISTORY_COLLECTION_MAX_SOURCE_TURNS)
		return { invalid: false, reason: "turn-limit" };
	if (c.providerRequestCount >= HISTORY_COLLECTION_MAX_REQUESTS)
		return { invalid: false, reason: "request-limit" };
	if (c.rawRecordCount > HISTORY_COLLECTION_MAX_RAW_ROWS - HISTORY_COLLECTION_PAGE_SIZE)
		return { invalid: false, reason: "row-limit" };
	if (n - first >= HISTORY_COLLECTION_MAX_DURATION_MS - HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS)
		return { invalid: false, reason: "time-limit" };
	return { invalid: false, reason: null };
}
function requeue(e: Entry, phase: HistorySourcePhase): boolean {
	return e.turns < HISTORY_COLLECTION_MAX_TURNS_PER_SOURCE && !e.phases.has(phase);
}
function isFinish(x: unknown): x is FinishResult {
	return x === "recorded" || x === "superseded" || x === "failed";
}
function map(x: FinishResult): "preserved" | "superseded" | "failed" {
	return x === "recorded" ? "preserved" : x;
}
function isDate(x: unknown): x is Date {
	return x instanceof Date && Number.isFinite(x.getTime());
}
function safeGeneration(x: unknown): x is number {
	return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}
function safeCount(x: unknown): x is number {
	return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}
function safePage(x: unknown): x is number {
	return safeGeneration(x) && x >= 2 && x <= HISTORY_COLLECTION_MAX_REQUESTS;
}
function safeText(x: unknown, max: number): x is string {
	return (
		typeof x === "string" &&
		x.length > 0 &&
		new TextEncoder().encode(x).byteLength <= max &&
		[...x].every((ch) => {
			const code = ch.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
	);
}
function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isExact(x: unknown, keys: readonly string[]): boolean {
	return isRecord(x) && Object.keys(x).sort().join(",") === [...keys].sort().join(",");
}
function hash(x: string): string {
	return createHash("sha256").update(x, "utf8").digest("hex");
}
