import type { ProviderCoverageReceiptV1, ProviderSkipReasonCode } from "@arr/shared";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";

export const TAUTULLI_OBSERVATION_WINDOW_MS = 15 * 60 * 1000;
export const TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE = 200;
export const TAUTULLI_OBSERVATION_MAX_RAW_ROWS = 10_000;
export const TAUTULLI_OBSERVATION_MAX_HISTORY_REQUESTS = 100;
export const TAUTULLI_OBSERVATION_METADATA_BATCH_SIZE = 25;
export const TAUTULLI_OBSERVATION_METADATA_DEADLINE_MS = 10_000;

const MAX_CANONICAL_LENGTH = 500;
const MAX_SAFE_MEDIA_ID = 2_147_483_647;
const SAFE_JSON_LENGTH = 100_000;
const MAX_SIGNATURE_LENGTH = 10_000;
const FIXED_ERROR_MESSAGE = "Tautulli positive observation collection failed";

export type TautulliPositiveObservationErrorCode =
	| "provider-unavailable"
	| "provider-limit"
	| "rows-inconsistent";

export class TautulliPositiveObservationError extends Error {
	readonly code: TautulliPositiveObservationErrorCode;

	constructor(code: TautulliPositiveObservationErrorCode) {
		super(FIXED_ERROR_MESSAGE);
		this.name = "TautulliPositiveObservationError";
		this.code = code;
	}
}

export interface TautulliPositiveObservationClient {
	getLibraries(): Promise<unknown>;
	getHistory(params: {
		section_id: string;
		length: number;
		start: number;
		order_column: "row_id";
		order_dir: "desc";
		grouping: 0;
		include_activity: 0;
	}): Promise<unknown>;
	getMetadata(ratingKey: string, signal: AbortSignal): Promise<unknown>;
}

export interface TautulliPositiveObservationRow {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	lastWatchedAt: Date;
	watchCount: number;
	watchedByUsers: string;
}

export interface TautulliPositiveObservationCollection {
	rows: TautulliPositiveObservationRow[];
	receipt: ProviderCoverageReceiptV1;
	windowStartedAt: Date;
	windowEndedAt: Date;
}

export interface TautulliPositiveObservationOptions {
	metadataBatchSize?: number;
	metadataDeadlineMs?: number;
	monotonicNow?: () => number;
}

interface CollectionInput extends TautulliPositiveObservationOptions {
	instanceId: string;
	attemptStartedAt: Date;
	now?: () => Date;
}

interface UnitState {
	scopeKey: string;
	expectedRawCount: null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	sourceBindings: number;
	canonicalEntities: number;
	acceptedSkips: Map<ProviderSkipReasonCode, number>;
	fatalCount: 0;
	canonicalKeys: Set<string>;
}

interface Candidate {
	unit: UnitState;
	sectionId: string;
	rowId: number;
	ratingKey: string;
	mediaType: "movie" | "series";
	user: string;
	occurredAt: Date;
	signature: string;
}

interface Aggregate {
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	lastWatchedAt: Date;
	watchCount: number;
	users: Set<string>;
}

interface HistoryResponse {
	data: unknown[];
	recordsTotal: number;
}

const fail = (code: TautulliPositiveObservationErrorCode): never => {
	throw new TautulliPositiveObservationError(code);
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return value.length > 0 && value.length <= MAX_CANONICAL_LENGTH && value.trim() === value
		? value
		: null;
}

function safeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalDate(value: unknown): Date | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const milliseconds = value * 1000;
	if (!Number.isSafeInteger(milliseconds)) return null;
	const date = new Date(milliseconds);
	return Number.isFinite(date.getTime()) ? date : null;
}

function canonicalAttempt(value: unknown): Date | null {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
	return new Date(value.getTime());
}

function parseHistory(value: unknown): HistoryResponse {
	if (!isRecord(value) || !Array.isArray(value.data)) fail("rows-inconsistent");
	const record = value as Record<string, unknown>;
	const data = record.data as unknown[];
	if (data.length > TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE) fail("rows-inconsistent");
	if (!safeCount(record.recordsFiltered) || !safeCount(record.recordsTotal))
		fail("rows-inconsistent");
	if ((record.recordsTotal as number) < (record.recordsFiltered as number))
		fail("rows-inconsistent");
	return {
		data,
		recordsTotal: record.recordsTotal as number,
	};
}

function rowId(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function typedSignature(
	value: unknown,
	seen: WeakSet<object>,
	state: { length: number },
	depth = 0,
): string {
	if (depth > 20) fail("rows-inconsistent");
	let encoded = "";
	switch (typeof value) {
		case "undefined":
			encoded = "u";
			break;
		case "boolean":
			encoded = value ? "b1" : "b0";
			break;
		case "string":
			encoded = `s${value.length}:${value}`;
			break;
		case "number":
			if (Number.isNaN(value)) encoded = "nNaN";
			else if (value === Number.POSITIVE_INFINITY) encoded = "n+Inf";
			else if (value === Number.NEGATIVE_INFINITY) encoded = "n-Inf";
			else if (Object.is(value, -0)) encoded = "n-0";
			else encoded = `n${value}`;
			break;
		case "bigint":
			encoded = `i${value}`;
			break;
		case "object": {
			if (value === null) {
				encoded = "null";
				break;
			}
			if (seen.has(value)) fail("rows-inconsistent");
			seen.add(value);
			if (Array.isArray(value)) {
				encoded = `a[${value.map((item) => typedSignature(item, seen, state, depth + 1)).join(",")}]`;
			} else {
				const objectValue = value as Record<string, unknown>;
				encoded = `o{${Object.keys(value)
					.sort(compareText)
					.map(
						(key) =>
							`${typedSignature(key, seen, state, depth + 1)}=${typedSignature(objectValue[key], seen, state, depth + 1)}`,
					)
					.join(",")}}`;
			}
			seen.delete(value);
			break;
		}
		default:
			fail("rows-inconsistent");
	}
	state.length += encoded.length;
	if (state.length > MAX_SIGNATURE_LENGTH) fail("rows-inconsistent");
	return encoded;
}

function signatureFor(row: Record<string, unknown>): string {
	const fields = [
		row.rating_key,
		row.parent_rating_key,
		row.grandparent_rating_key,
		row.media_type,
		row.user,
		row.date,
		row.play_count,
		row.group_count,
	];
	return typedSignature(fields, new WeakSet(), { length: 0 });
}

function addSkip(unit: UnitState, reason: ProviderSkipReasonCode, count = 1): void {
	unit.acceptedSkips.set(reason, (unit.acceptedSkips.get(reason) ?? 0) + count);
}

function compareCandidate(left: Candidate, right: Candidate): number {
	const byDate = left.occurredAt.getTime() - right.occurredAt.getTime();
	if (byDate !== 0) return byDate;
	const bySection = compareText(left.sectionId, right.sectionId);
	if (bySection !== 0) return bySection;
	return left.rowId - right.rowId;
}

function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function parseTmdbId(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = /^tmdb:\/\/(\d+)$/.exec(value);
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_SAFE_MEDIA_ID ? parsed : null;
}

function safeJson(value: unknown): string {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		fail("rows-inconsistent");
	}
	if (typeof encoded !== "string") fail("rows-inconsistent");
	const json = encoded as string;
	if (json.length > SAFE_JSON_LENGTH) fail("rows-inconsistent");
	return json;
}

export async function collectTautulliPositiveObservations(
	client: TautulliPositiveObservationClient,
	input: CollectionInput,
): Promise<TautulliPositiveObservationCollection> {
	const instanceId = canonicalText(input.instanceId);
	const parsedAttempt = canonicalAttempt(input.attemptStartedAt);
	if (!instanceId || !parsedAttempt) fail("rows-inconsistent");
	const canonicalInstanceId = instanceId as string;
	const attemptStartedAt = parsedAttempt as Date;
	const metadataBatchSize = input.metadataBatchSize ?? TAUTULLI_OBSERVATION_METADATA_BATCH_SIZE;
	const metadataDeadlineMs = input.metadataDeadlineMs ?? TAUTULLI_OBSERVATION_METADATA_DEADLINE_MS;
	if (
		!safeCount(metadataBatchSize) ||
		metadataBatchSize < 1 ||
		metadataBatchSize > TAUTULLI_OBSERVATION_METADATA_BATCH_SIZE ||
		typeof metadataDeadlineMs !== "number" ||
		!Number.isFinite(metadataDeadlineMs) ||
		metadataDeadlineMs < 0 ||
		metadataDeadlineMs > TAUTULLI_OBSERVATION_METADATA_DEADLINE_MS
	) {
		fail("rows-inconsistent");
	}
	const monotonicClock = input.monotonicNow ?? (() => performance.now());
	let previousMonotonicTime: number | null = null;
	const readMonotonicTime = (): number => {
		let value = Number.NaN;
		try {
			value = monotonicClock();
		} catch {
			fail("rows-inconsistent");
		}
		if (
			!Number.isFinite(value) ||
			(previousMonotonicTime !== null && value < previousMonotonicTime)
		) {
			fail("rows-inconsistent");
		}
		previousMonotonicTime = value;
		return value;
	};
	const workStartedAt = readMonotonicTime();
	const workDeadline = workStartedAt + metadataDeadlineMs;
	if (!Number.isFinite(workDeadline)) fail("rows-inconsistent");

	let libraries: unknown;
	try {
		libraries = await client.getLibraries();
	} catch {
		fail("provider-unavailable");
	}
	if (!Array.isArray(libraries)) fail("rows-inconsistent");

	const supported = new Map<string, string>();
	for (const library of libraries as unknown[]) {
		if (!isRecord(library)) continue;
		if (library.section_type !== "movie" && library.section_type !== "show") continue;
		if (typeof library.section_id !== "string") fail("rows-inconsistent");
		const sectionId = library.section_id as string;
		if (sectionId.trim() !== sectionId || canonicalText(sectionId) === null)
			fail("rows-inconsistent");
		if (supported.has(sectionId)) fail("rows-inconsistent");
		supported.set(sectionId, library.section_type);
	}
	if (supported.size === 0) fail("provider-unavailable");
	if (supported.size > TAUTULLI_OBSERVATION_MAX_HISTORY_REQUESTS) fail("provider-limit");

	const now = input.now ?? (() => new Date());
	let capturedNow: unknown;
	try {
		capturedNow = now();
	} catch {
		fail("rows-inconsistent");
	}
	const parsedWindowEndedAt = canonicalAttempt(capturedNow);
	if (!parsedWindowEndedAt) fail("rows-inconsistent");
	const windowEndedAt = parsedWindowEndedAt as Date;
	const windowStartedAt = new Date(windowEndedAt.getTime() - TAUTULLI_OBSERVATION_WINDOW_MS);
	if (attemptStartedAt.getTime() > windowEndedAt.getTime()) fail("rows-inconsistent");

	const units = [...supported.keys()].sort(compareText).map<UnitState>((sectionId) => ({
		scopeKey: `library:${sectionId}`,
		expectedRawCount: null,
		pagesAttempted: 0,
		pagesCompleted: 0,
		rawObserved: 0,
		sourceBindings: 0,
		canonicalEntities: 0,
		acceptedSkips: new Map(),
		fatalCount: 0,
		canonicalKeys: new Set(),
	}));
	const candidates: Candidate[] = [];
	const keyMediaTypes = new Map<string, "movie" | "series">();
	const seenStableRows = new Map<string, string>();
	let historyRequests = 0;
	let rawTotal = 0;
	let stopAll = false;
	const observeRaw = (unit: UnitState): void => {
		rawTotal += 1;
		unit.rawObserved += 1;
	};

	const truncateOldest = (): boolean => {
		if (candidates.length === 0) return false;
		candidates.sort(compareCandidate);
		const removed = candidates.shift();
		if (!removed) return false;
		addSkip(removed.unit, "bounded-window-truncation");
		return true;
	};

	for (const unit of units) {
		let start = 0;
		let firstPage = true;
		let highWater: number | null = null;
		while (!stopAll) {
			if (historyRequests >= TAUTULLI_OBSERVATION_MAX_HISTORY_REQUESTS) {
				if (!truncateOldest()) fail("provider-limit");
				stopAll = true;
				break;
			}
			historyRequests += 1;
			unit.pagesAttempted += 1;
			let response: unknown;
			try {
				response = await client.getHistory({
					section_id: unit.scopeKey.slice("library:".length),
					length: TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE,
					start,
					order_column: "row_id",
					order_dir: "desc",
					grouping: 0,
					include_activity: 0,
				});
			} catch {
				fail("provider-unavailable");
			}
			const page = parseHistory(response);
			unit.pagesCompleted += 1;
			const pageIds = page.data
				.map((row) => (isRecord(row) ? rowId(row.row_id) : null))
				.filter((id): id is number => id !== null);
			if (pageIds.some((id, index) => index > 0 && id > pageIds[index - 1]!))
				fail("rows-inconsistent");
			if (firstPage) {
				highWater = pageIds.length > 0 ? Math.max(...pageIds) : null;
			}
			const allFiniteBeforeWindow =
				page.data.length > 0 &&
				page.data.every((row) => {
					if (!isRecord(row)) return false;
					const date = canonicalDate(row.date);
					return date !== null && date.getTime() < windowStartedAt.getTime();
				});
			for (const raw of page.data) {
				if (!isRecord(raw)) {
					if (rawTotal >= TAUTULLI_OBSERVATION_MAX_RAW_ROWS) {
						if (!truncateOldest()) fail("provider-limit");
						stopAll = true;
						break;
					}
					observeRaw(unit);
					addSkip(unit, "unsupported-provider-object");
					continue;
				}
				const occurredAt = canonicalDate(raw.date);
				if (occurredAt && (occurredAt < windowStartedAt || occurredAt > windowEndedAt)) continue;
				const knownMusicDomain =
					raw.media_type === "track" || raw.media_type === "album" || raw.media_type === "artist";
				if (knownMusicDomain) {
					if (rawTotal >= TAUTULLI_OBSERVATION_MAX_RAW_ROWS) {
						if (!truncateOldest()) fail("provider-limit");
						stopAll = true;
						break;
					}
					observeRaw(unit);
					addSkip(unit, "unsupported-provider-object");
					continue;
				}
				const stableId = rowId(raw.row_id);
				if (stableId === null) {
					if (rawTotal >= TAUTULLI_OBSERVATION_MAX_RAW_ROWS) {
						if (!truncateOldest()) fail("provider-limit");
						stopAll = true;
						break;
					}
					observeRaw(unit);
					addSkip(unit, occurredAt === null ? "unsupported-provider-object" : "missing-stable-key");
					continue;
				}
				if (!firstPage && highWater !== null && stableId > highWater) continue;
				const identity = `${unit.scopeKey.slice("library:".length)}\u0000${stableId}`;
				const rowSignature = signatureFor(raw);
				const previousRow = seenStableRows.get(identity);
				if (previousRow !== undefined) {
					if (previousRow !== rowSignature) fail("rows-inconsistent");
					continue;
				}
				seenStableRows.set(identity, rowSignature);
				if (!occurredAt) {
					if (rawTotal >= TAUTULLI_OBSERVATION_MAX_RAW_ROWS) {
						if (!truncateOldest()) fail("provider-limit");
						stopAll = true;
						break;
					}
					observeRaw(unit);
					addSkip(unit, "unsupported-provider-object");
					continue;
				}
				const sourceType =
					raw.media_type === "movie" ? "movie" : raw.media_type === "episode" ? "series" : null;
				const ratingKey =
					sourceType === "movie"
						? canonicalText(raw.rating_key)
						: canonicalText(raw.grandparent_rating_key);
				const user = canonicalText(raw.user);
				const grouped =
					(raw.play_count !== undefined && raw.play_count !== 1) ||
					(raw.group_count !== undefined && raw.group_count !== 1);
				const container =
					raw.media_type === "show" ||
					raw.media_type === "season" ||
					raw.media_type === "collection";
				if (!sourceType || !ratingKey || !user || grouped) {
					if (rawTotal >= TAUTULLI_OBSERVATION_MAX_RAW_ROWS) {
						if (!truncateOldest()) fail("provider-limit");
						stopAll = true;
						break;
					}
					observeRaw(unit);
					addSkip(
						unit,
						container
							? "known-container"
							: sourceType && !ratingKey && !grouped
								? "missing-stable-key"
								: "unsupported-provider-object",
					);
					continue;
				}
				if (rawTotal >= TAUTULLI_OBSERVATION_MAX_RAW_ROWS) {
					if (!truncateOldest()) fail("provider-limit");
					stopAll = true;
					break;
				}
				observeRaw(unit);
				const candidate: Candidate = {
					unit,
					sectionId: unit.scopeKey.slice("library:".length),
					rowId: stableId,
					ratingKey,
					mediaType: sourceType,
					user,
					occurredAt,
					signature: rowSignature,
				};
				const previousMediaType = keyMediaTypes.get(ratingKey);
				if (previousMediaType && previousMediaType !== sourceType) fail("rows-inconsistent");
				keyMediaTypes.set(ratingKey, sourceType);
				candidates.push(candidate);
			}
			if (stopAll) break;
			if (page.data.length === 0 || page.data.length < TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE)
				break;
			if (allFiniteBeforeWindow) break;
			firstPage = false;
			start += page.data.length;
			if (pageIds.length === 0) break;
		}
		if (stopAll) break;
	}

	const keys = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const list = keys.get(candidate.ratingKey) ?? [];
		list.push(candidate);
		keys.set(candidate.ratingKey, list);
	}
	const orderedKeys = [...keys.entries()].sort((left, right) => {
		const leftNewest = Math.max(...left[1].map((candidate) => candidate.occurredAt.getTime()));
		const rightNewest = Math.max(...right[1].map((candidate) => candidate.occurredAt.getTime()));
		return rightNewest - leftNewest || compareText(left[0], right[0]);
	});
	const aggregates = new Map<string, Aggregate>();
	const applyMetadata = (keyCandidates: Candidate[], metadata: unknown): void => {
		if (!isRecord(metadata) || !Array.isArray(metadata.guids)) fail("rows-inconsistent");
		const metadataRecord = metadata as Record<string, unknown>;
		const guidIds = new Set<number>();
		for (const guid of metadataRecord.guids as unknown[]) {
			if (typeof guid !== "string") fail("rows-inconsistent");
			const canonicalGuid = guid as string;
			const parsed = parseTmdbId(canonicalGuid);
			if (canonicalGuid.startsWith("tmdb://") && parsed === null) fail("rows-inconsistent");
			if (parsed !== null) guidIds.add(parsed);
		}
		if (guidIds.size > 1) fail("rows-inconsistent");
		const tmdbId = [...guidIds][0];
		if (tmdbId === undefined) {
			for (const candidate of keyCandidates) addSkip(candidate.unit, "missing-supported-mapping");
			return;
		}
		for (const candidate of keyCandidates) {
			candidate.unit.sourceBindings += 1;
			const canonicalKey = `${candidate.mediaType}:${tmdbId}`;
			if (!candidate.unit.canonicalKeys.has(canonicalKey)) {
				candidate.unit.canonicalKeys.add(canonicalKey);
				candidate.unit.canonicalEntities += 1;
			}
			const aggregate = aggregates.get(canonicalKey) ?? {
				instanceId: canonicalInstanceId,
				tmdbId,
				mediaType: candidate.mediaType,
				lastWatchedAt: candidate.occurredAt,
				watchCount: 0,
				users: new Set<string>(),
			};
			if (aggregate.watchCount >= MAX_SAFE_MEDIA_ID) fail("rows-inconsistent");
			aggregate.watchCount += 1;
			if (candidate.occurredAt > aggregate.lastWatchedAt)
				aggregate.lastWatchedAt = candidate.occurredAt;
			aggregate.users.add(candidate.user);
			aggregates.set(canonicalKey, aggregate);
		}
	};
	let batchStart = 0;
	const metadataAbortController = new AbortController();
	while (batchStart < orderedKeys.length) {
		const batchStartedAt = readMonotonicTime();
		if (metadataAbortController.signal.aborted || batchStartedAt >= workDeadline) {
			for (const [, keyCandidates] of orderedKeys.slice(batchStart)) {
				for (const candidate of keyCandidates) addSkip(candidate.unit, "bounded-window-truncation");
			}
			break;
		}
		const batch = orderedKeys.slice(batchStart, batchStart + metadataBatchSize);
		let metadataResults: unknown[] = [];
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const remainingDeadlineMs = workDeadline - batchStartedAt;
			if (remainingDeadlineMs <= 0) {
				metadataAbortController.abort();
				fail("provider-unavailable");
			}
			const deadlinePromise = new Promise<never>((_, reject) => {
				deadlineTimer = setTimeout(() => {
					metadataAbortController.abort();
					reject(new TautulliPositiveObservationError("provider-unavailable"));
				}, remainingDeadlineMs);
				(deadlineTimer as unknown as { unref?: () => void }).unref?.();
			});
			const metadataPromise = Promise.all(
				batch.map(
					async ([ratingKey]) =>
						await client.getMetadata(ratingKey, metadataAbortController.signal),
				),
			);
			metadataResults = await Promise.race([metadataPromise, deadlinePromise]);
		} catch {
			if (metadataAbortController.signal.aborted) fail("provider-unavailable");
			fail("provider-unavailable");
		} finally {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		}
		if (metadataAbortController.signal.aborted || readMonotonicTime() > workDeadline)
			fail("provider-unavailable");
		for (let index = 0; index < batch.length; index += 1) {
			if (batch[index] === undefined) fail("rows-inconsistent");
			const keyCandidates = batch[index]![1];
			applyMetadata(keyCandidates, metadataResults[index]);
		}
		batchStart += batch.length;
		if (batchStart < orderedKeys.length && readMonotonicTime() >= workDeadline) {
			for (const [, keyCandidates] of orderedKeys.slice(batchStart)) {
				for (const candidate of keyCandidates) addSkip(candidate.unit, "bounded-window-truncation");
			}
			break;
		}
	}

	const rows = [...aggregates.values()]
		.sort((left, right) => {
			const mediaOrder =
				left.mediaType === right.mediaType ? 0 : left.mediaType === "movie" ? -1 : 1;
			return mediaOrder || left.tmdbId - right.tmdbId;
		})
		.map((aggregate) => {
			const watchedByUsers = safeJson([...aggregate.users].sort(compareText));
			if (watchedByUsers.length > SAFE_JSON_LENGTH) fail("rows-inconsistent");
			return {
				instanceId: aggregate.instanceId,
				tmdbId: aggregate.tmdbId,
				mediaType: aggregate.mediaType,
				lastWatchedAt: aggregate.lastWatchedAt,
				watchCount: aggregate.watchCount,
				watchedByUsers,
			};
		});
	const receipt: ProviderCoverageReceiptV1 = {
		version: 1,
		provider: "tautulli",
		attemptStartedAt: attemptStartedAt.toISOString(),
		observedAt: windowEndedAt.toISOString(),
		evidence: "positive-only",
		units: units.map((unit) => ({
			scopeKey: unit.scopeKey,
			expectedRawCount: null,
			pagesAttempted: unit.pagesAttempted,
			pagesCompleted: unit.pagesCompleted,
			rawObserved: unit.rawObserved,
			sourceBindings: unit.sourceBindings,
			canonicalEntities: unit.canonicalEntities,
			acceptedSkips: [...unit.acceptedSkips.entries()]
				.sort(([left], [right]) => compareText(left, right))
				.map(([reason, count]) => ({ reason, count })),
			fatalCount: 0,
		})),
		publishedCanonicalEntities: rows.length,
	};
	const evaluation = evaluateProviderCoverageReceipt(receipt);
	if (
		!evaluation.valid ||
		evaluation.evidence !== "positive-only" ||
		evaluation.publishedCanonicalEntities !== rows.length
	) {
		fail("rows-inconsistent");
	}
	return { rows, receipt, windowStartedAt, windowEndedAt };
}
