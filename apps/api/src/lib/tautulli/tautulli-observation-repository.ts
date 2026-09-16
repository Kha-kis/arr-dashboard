import type { ProviderCoverageReceipt, ProviderObservationStatus } from "@arr/shared";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
import type { Prisma, PrismaClient } from "../prisma.js";
import {
	evaluateProviderCoverageReceipt,
	type ProviderCoverageEvaluation,
} from "../provider-observation/coverage-receipt.js";
import { projectProviderObservationStatus } from "../provider-observation/status-projection.js";
import {
	decodeTautulliObservationMetadata,
	type TautulliObservationMetadataV1,
} from "./tautulli-observation-metadata.js";

export interface TautulliObservationRow {
	id: string;
	instanceId: string;
	tmdbId: number;
	mediaType: "movie" | "series";
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
	connectionGeneration: number | null;
	identityGeneration: number | null;
}

export interface TautulliObservationResult {
	instanceId: string;
	metadata: TautulliObservationMetadataV1 | null;
	rows: TautulliObservationRow[];
	providerStatus: ProviderObservationStatus;
}

export interface TautulliSelectedObservationResult {
	configured: boolean;
	available: boolean;
	rows: TautulliObservationRow[];
	providerStatus?: ProviderObservationStatus;
	reasonCodes: string[];
}

export type TautulliObservationPrisma = Pick<PrismaClient, "$transaction">;

const READ_PAGE_SIZE = 500;
const MAX_ROWS = 10_000;
const MAX_STRING_LENGTH = 500;
const MAX_USERNAMES_JSON_LENGTH = 100_000;
const MAX_USERNAME_LENGTH = 500;
const MAX_ERROR_LENGTH = 4_000;
const MAX_TMDB_ID = 2_147_483_647;
const MAX_WATCH_COUNT = 2_147_483_647;
const MAX_OBSERVATION_AGE_MS = 15 * 60 * 1000;
const TRANSACTION_ATTEMPTS = 3;
const TRANSACTION_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 15;
const ATTEMPT_MARKER =
	/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INSTANCE_SELECT = {
	id: true,
	service: true,
	enabled: true,
	expectedIdentity: true,
	identityStatus: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

const STATUS_SELECT = {
	instanceId: true,
	cacheType: true,
	lastRefreshedAt: true,
	lastResult: true,
	lastErrorMessage: true,
	itemCount: true,
	generationId: true,
	generationMetadata: true,
	lastAttemptAt: true,
	lastAttemptResult: true,
	lastAttemptErrorMessage: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

const ROW_SELECT = {
	id: true,
	instanceId: true,
	tmdbId: true,
	mediaType: true,
	lastWatchedAt: true,
	watchCount: true,
	watchedByUsers: true,
	connectionGeneration: true,
	identityGeneration: true,
} as const;

type Instance = Prisma.ServiceInstanceGetPayload<{ select: typeof INSTANCE_SELECT }>;
type Status = Prisma.CacheRefreshStatusGetPayload<{ select: typeof STATUS_SELECT }>;
type SelectedRow = Prisma.TautulliCacheGetPayload<{ select: typeof ROW_SELECT }>;
type TransactionReader = Pick<
	Prisma.TransactionClient,
	"serviceInstance" | "cacheRefreshStatus" | "tautulliCache"
>;

const MAX_DISPLAY_TARGETS = 200;

type Publication = {
	status: Status;
	metadata: TautulliObservationMetadataV1;
	evaluation: ProviderCoverageEvaluation;
};

function projectWatchCountDomain(
	receipt: ProviderCoverageReceipt,
	evaluation: ProviderCoverageEvaluation,
): ProviderCoverageEvaluation {
	if (receipt.version === 2) return evaluation;
	const projected = evaluateProviderCoverageReceipt({
		...receipt,
		version: 2,
		domains: [
			{
				domain: "watch-count",
				evidence: "positive-only",
				valueSemantics: "lower-bound",
				units: receipt.units,
			},
		],
	});
	return { ...evaluation, domains: projected.domains };
}

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function safeGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function currentIdentity(instance: Instance): boolean {
	return (
		instance.service === "TAUTULLI" &&
		instance.enabled &&
		instance.identityStatus === "VERIFIED" &&
		typeof instance.expectedIdentity === "string" &&
		instance.expectedIdentity.trim() !== "" &&
		safeGeneration(instance.connectionGeneration) &&
		safeGeneration(instance.identityGeneration)
	);
}

function unavailable(
	instanceId: string,
	reason:
		| "identity-unverified"
		| "identity-changed"
		| "no-publication"
		| "receipt-invalid"
		| "rows-inconsistent"
		| "coverage-incomplete"
		| "unknown-failure",
): TautulliObservationResult {
	return {
		instanceId,
		metadata: null,
		rows: [],
		providerStatus: {
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle",
			reasonCodes: [reason],
		},
	};
}

function boundedError(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && value.length <= MAX_ERROR_LENGTH;
}

function attemptMarker(value: unknown): value is string {
	return (
		value === "success" ||
		value === "error" ||
		(typeof value === "string" && ATTEMPT_MARKER.test(value))
	);
}

function instanceFingerprint(instance: Instance): string {
	return evidenceFingerprint({
		id: instance.id,
		service: instance.service,
		enabled: instance.enabled,
		expectedIdentity: instance.expectedIdentity,
		identityStatus: instance.identityStatus,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	});
}

function statusFingerprint(status: Status): string {
	return evidenceFingerprint({
		instanceId: status.instanceId,
		cacheType: status.cacheType,
		lastRefreshedAt: validDate(status.lastRefreshedAt)
			? status.lastRefreshedAt.toISOString()
			: null,
		lastResult: status.lastResult,
		lastErrorMessage: status.lastErrorMessage,
		itemCount: status.itemCount,
		generationId: status.generationId,
		generationMetadata: status.generationMetadata,
		lastAttemptAt: validDate(status.lastAttemptAt) ? status.lastAttemptAt.toISOString() : null,
		lastAttemptResult: status.lastAttemptResult,
		lastAttemptErrorMessage: status.lastAttemptErrorMessage,
		connectionGeneration: status.connectionGeneration,
		identityGeneration: status.identityGeneration,
	});
}

function readAttempt(
	status: Status,
): { state: "running" | "failed" | "successful"; attemptedAt: Date } | null {
	if (!validDate(status.lastAttemptAt)) return null;
	if (status.lastAttemptResult === "success") {
		return { state: "successful", attemptedAt: status.lastAttemptAt };
	}
	if (status.lastAttemptResult === "error") {
		return { state: "failed", attemptedAt: status.lastAttemptAt };
	}
	if (
		typeof status.lastAttemptResult === "string" &&
		ATTEMPT_MARKER.test(status.lastAttemptResult)
	) {
		return { state: "running", attemptedAt: status.lastAttemptAt };
	}
	return null;
}

function canonicalUsernames(value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_USERNAMES_JSON_LENGTH) {
		return false;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed) || parsed.length === 0) return false;
		const usernames = parsed.filter((entry): entry is string => typeof entry === "string");
		if (usernames.length !== parsed.length) return false;
		if (
			usernames.some(
				(username) =>
					username.length === 0 ||
					username.length > MAX_USERNAME_LENGTH ||
					username.trim() !== username,
			)
		) {
			return false;
		}
		if (new Set(usernames).size !== usernames.length) return false;
		const sorted = [...usernames].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
		return JSON.stringify(parsed) === JSON.stringify(sorted);
	} catch {
		return false;
	}
}

function safeRow(
	value: unknown,
	instance: Instance,
	metadata: TautulliObservationMetadataV1,
): value is TautulliObservationRow {
	if (!value || typeof value !== "object") return false;
	const row = value as SelectedRow;
	const windowStartedAt = Date.parse(metadata.windowStartedAt);
	const windowEndedAt = Date.parse(metadata.windowEndedAt);
	return (
		typeof row.id === "string" &&
		row.id.trim() !== "" &&
		row.id.length <= MAX_STRING_LENGTH &&
		row.instanceId === instance.id &&
		typeof row.tmdbId === "number" &&
		Number.isSafeInteger(row.tmdbId) &&
		row.tmdbId > 0 &&
		row.tmdbId <= MAX_TMDB_ID &&
		(row.mediaType === "movie" || row.mediaType === "series") &&
		validDate(row.lastWatchedAt) &&
		row.lastWatchedAt.getTime() >= windowStartedAt &&
		row.lastWatchedAt.getTime() <= windowEndedAt &&
		typeof row.watchCount === "number" &&
		Number.isSafeInteger(row.watchCount) &&
		row.watchCount > 0 &&
		row.watchCount <= MAX_WATCH_COUNT &&
		canonicalUsernames(row.watchedByUsers) &&
		row.connectionGeneration === instance.connectionGeneration &&
		row.identityGeneration === instance.identityGeneration
	);
}

/**
 * Tautulli's positive-only publication has no exact attribution domain. Keep its
 * bounded count, but never publish timestamp or user attribution from raw rows.
 */
function publicRows(rows: readonly TautulliObservationRow[]): TautulliObservationRow[] {
	return rows.map((row) => ({ ...row, lastWatchedAt: null, watchedByUsers: "[]" }));
}

function rowsInOrder(rows: readonly SelectedRow[], cursor: string | undefined): boolean {
	let previous = cursor;
	for (const row of rows) {
		if (typeof row.id !== "string" || (previous !== undefined && row.id <= previous)) return false;
		previous = row.id;
	}
	return true;
}

async function readStatus(
	tx: TransactionReader,
	instanceId: string,
	userId: string,
): Promise<Status | null> {
	return (await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: { instanceId, cacheType: "tautulli" },
			instance: { userId },
		},
		select: STATUS_SELECT,
	})) as Status | null;
}

async function readInstance(
	tx: TransactionReader,
	userId: string,
	instanceId: string,
): Promise<Instance | null> {
	return (await tx.serviceInstance.findFirst({
		where: { id: instanceId, userId, service: "TAUTULLI" },
		select: INSTANCE_SELECT,
	})) as Instance | null;
}

async function readRows(
	tx: TransactionReader,
	userId: string,
	instanceId: string,
	declaredCount: number,
): Promise<SelectedRow[]> {
	if (declaredCount > MAX_ROWS) throw new Error("row-cap");
	const rows: SelectedRow[] = [];
	let cursor: string | undefined;
	while (true) {
		const page = (await tx.tautulliCache.findMany({
			where: { instanceId, instance: { userId } },
			select: ROW_SELECT,
			take: READ_PAGE_SIZE,
			orderBy: { id: "asc" },
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
		})) as SelectedRow[];
		if (page.length === 0) break;
		if (
			page.length > READ_PAGE_SIZE ||
			rows.length + page.length > MAX_ROWS ||
			rows.length + page.length > declaredCount ||
			!rowsInOrder(page, cursor)
		) {
			throw new Error("rows-inconsistent");
		}
		rows.push(...page);
		const lastId = page[page.length - 1]?.id;
		if (typeof lastId !== "string") throw new Error("cursor-invalid");
		if (page.length < READ_PAGE_SIZE) break;
		cursor = lastId;
	}
	return rows;
}

async function readSelectedRows(
	tx: TransactionReader,
	userId: string,
	instance: Instance,
	targets: Array<{ tmdbId: number; mediaType: "movie" | "series" }>,
): Promise<SelectedRow[]> {
	if (targets.length > MAX_DISPLAY_TARGETS) throw new Error("target-cap");
	if (targets.length === 0) return [];
	const rows = (await tx.tautulliCache.findMany({
		where: {
			instanceId: instance.id,
			instance: { userId },
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			OR: targets.map((target) => ({
				tmdbId: target.tmdbId,
				mediaType: target.mediaType,
			})),
			watchCount: { gt: 0 },
			lastWatchedAt: { not: null },
		},
		select: ROW_SELECT,
		orderBy: { id: "asc" },
		take: targets.length,
	})) as SelectedRow[];
	if (rows.length > targets.length || !rowsInOrder(rows, undefined)) {
		throw new Error("rows-inconsistent");
	}
	return rows;
}

function strictPublication(instance: Instance, status: Status, now: Date): Publication | null {
	if (
		status.instanceId !== instance.id ||
		status.cacheType !== "tautulli" ||
		status.lastResult !== "success" ||
		status.lastErrorMessage !== null ||
		!validDate(status.lastRefreshedAt) ||
		status.lastRefreshedAt.getTime() > now.getTime() ||
		!safeGeneration(status.itemCount) ||
		status.itemCount > MAX_ROWS ||
		status.generationId !== null ||
		typeof status.generationMetadata !== "string" ||
		status.connectionGeneration !== instance.connectionGeneration ||
		status.identityGeneration !== instance.identityGeneration ||
		!attemptMarker(status.lastAttemptResult) ||
		!validDate(status.lastAttemptAt) ||
		status.lastAttemptAt.getTime() > now.getTime() ||
		(status.lastAttemptResult === "success" &&
			(status.lastAttemptAt.getTime() !== status.lastRefreshedAt.getTime() ||
				status.lastAttemptErrorMessage !== null)) ||
		(status.lastAttemptResult === "error" &&
			(status.lastAttemptAt.getTime() <= status.lastRefreshedAt.getTime() ||
				!boundedError(status.lastAttemptErrorMessage))) ||
		(typeof status.lastAttemptResult === "string" &&
			ATTEMPT_MARKER.test(status.lastAttemptResult) &&
			(status.lastAttemptAt.getTime() <= status.lastRefreshedAt.getTime() ||
				status.lastAttemptErrorMessage !== null))
	) {
		return null;
	}
	const decoded = decodeTautulliObservationMetadata(status.generationMetadata);
	if (!decoded.ok || decoded.metadata.itemCount !== status.itemCount) return null;
	if (decoded.metadata.coverageReceipt.observedAt !== status.lastRefreshedAt.toISOString()) {
		return null;
	}
	const evaluation = projectWatchCountDomain(
		decoded.metadata.coverageReceipt,
		evaluateProviderCoverageReceipt(decoded.metadata.coverageReceipt),
	);
	if (
		!evaluation.valid ||
		evaluation.provider !== "tautulli" ||
		evaluation.evidence !== "positive-only" ||
		evaluation.publishedCanonicalEntities !== status.itemCount
	) {
		return null;
	}
	return { status, metadata: decoded.metadata, evaluation };
}

function retryableConflict(error: unknown, seen = new Set<object>()): boolean {
	if (!error || typeof error !== "object" || seen.has(error)) return false;
	seen.add(error);
	const value = error as Record<string, unknown>;
	const codes = [value.code, value.originalCode].filter(
		(code): code is string => typeof code === "string",
	);
	const messages = [value.message, value.originalMessage].filter(
		(message): message is string => typeof message === "string",
	);
	if (
		codes.some((code) => /^(P2034|SQLITE_BUSY|SQLITE_LOCKED|40001)$/i.test(code)) ||
		messages.some((message) =>
			/serialization|deadlock|database[\s-]+locked|transaction[\s-]+write[\s-]+conflict/i.test(
				message,
			),
		)
	) {
		return true;
	}
	return Object.values(value).some((nested) => retryableConflict(nested, seen));
}

async function runSerializable<T>(
	prisma: TautulliObservationPrisma,
	operation: (tx: TransactionReader) => Promise<T>,
	fallback: T,
): Promise<T> {
	for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt++) {
		try {
			return (await prisma.$transaction(async (tx) => await operation(tx as TransactionReader), {
				isolationLevel: "Serializable",
				timeout: TRANSACTION_TIMEOUT_MS,
			})) as T;
		} catch (error) {
			if (attempt === TRANSACTION_ATTEMPTS - 1 || !retryableConflict(error)) return fallback;
			await new Promise<void>((resolve) => setTimeout(resolve, (attempt + 1) * RETRY_DELAY_MS));
		}
	}
	return fallback;
}

type ValidatedPublication = {
	instance: Instance;
	status: Status;
	publication: Publication;
	attempt: NonNullable<ReturnType<typeof readAttempt>>;
};

type PublicationGuardResult =
	| { ok: true; value: ValidatedPublication }
	| { ok: false; result: TautulliObservationResult | null };

async function readValidatedPublication(
	tx: TransactionReader,
	input: { userId: string; instanceId: string; now: Date },
): Promise<PublicationGuardResult> {
	const instance = await readInstance(tx, input.userId, input.instanceId);
	if (instance?.service !== "TAUTULLI") return { ok: false, result: null };
	const status = await readStatus(tx, instance.id, input.userId);
	if (!currentIdentity(instance)) {
		return {
			ok: false,
			result: unavailable(
				instance.id,
				instance.identityStatus === "MISMATCH" ? "identity-changed" : "identity-unverified",
			),
		};
	}
	if (!status) return { ok: false, result: unavailable(instance.id, "no-publication") };
	if (!safeGeneration(status.itemCount) || status.itemCount > MAX_ROWS) {
		return { ok: false, result: unavailable(instance.id, "rows-inconsistent") };
	}
	const publication = strictPublication(instance, status, input.now);
	if (!publication) return { ok: false, result: unavailable(instance.id, "receipt-invalid") };
	const attempt = readAttempt(status);
	if (!attempt) return { ok: false, result: unavailable(instance.id, "receipt-invalid") };
	return { ok: true, value: { instance, status, publication, attempt } };
}

async function readStableProviderStatus(
	tx: TransactionReader,
	input: { userId: string; now: Date },
	validated: ValidatedPublication,
): Promise<ProviderObservationStatus | null> {
	const statusAfter = await readStatus(tx, validated.instance.id, input.userId);
	const instanceAfter = await readInstance(tx, input.userId, validated.instance.id);
	if (
		!statusAfter ||
		!instanceAfter ||
		statusFingerprint(statusAfter) !== statusFingerprint(validated.status) ||
		instanceFingerprint(instanceAfter) !== instanceFingerprint(validated.instance)
	) {
		return null;
	}
	return projectProviderObservationStatus({
		identity: "current",
		publication: {
			observedAt: validated.status.lastRefreshedAt,
			evaluation: validated.publication.evaluation,
		},
		latestAttempt: validated.attempt,
		now: input.now,
		maxAgeMs: MAX_OBSERVATION_AGE_MS,
	});
}

async function readSnapshot(
	tx: TransactionReader,
	input: { userId: string; instanceId: string; now: Date },
): Promise<TautulliObservationResult | null> {
	const guard = await readValidatedPublication(tx, input);
	if (!guard.ok) return guard.result;
	const { instance, status, publication } = guard.value;
	let rows: SelectedRow[];
	try {
		rows = await readRows(tx, input.userId, instance.id, status.itemCount);
	} catch {
		return unavailable(instance.id, "rows-inconsistent");
	}
	if (
		rows.length !== status.itemCount ||
		rows.length !== publication.metadata.itemCount ||
		!rows.every((row) => safeRow(row, instance, publication.metadata))
	) {
		return unavailable(instance.id, "rows-inconsistent");
	}
	// An empty positive-only window is still a successful observation attempt.
	// Preserve its receipt and freshness, but never synthesize unwatched rows.
	const providerStatus = await readStableProviderStatus(tx, input, guard.value);
	if (!providerStatus) return unavailable(instance.id, "rows-inconsistent");
	return {
		instanceId: instance.id,
		metadata: publication.metadata,
		rows: publicRows(rows as TautulliObservationRow[]),
		providerStatus,
	};
}

async function readSelectedSnapshot(
	tx: TransactionReader,
	input: {
		userId: string;
		instanceId: string;
		targets: Array<{ tmdbId: number; mediaType: "movie" | "series" }>;
		now: Date;
	},
): Promise<TautulliObservationResult | null> {
	const guard = await readValidatedPublication(tx, input);
	if (!guard.ok) return guard.result;
	const { instance, status, publication } = guard.value;
	try {
		const [totalCount, exactCount, rows] = await Promise.all([
			tx.tautulliCache.count({
				where: { instanceId: instance.id, instance: { userId: input.userId } },
			}),
			tx.tautulliCache.count({
				where: {
					instanceId: instance.id,
					instance: { userId: input.userId },
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
				},
			}),
			readSelectedRows(tx, input.userId, instance, input.targets),
		]);
		if (totalCount !== exactCount || exactCount !== status.itemCount) {
			return unavailable(instance.id, "rows-inconsistent");
		}
		if (!rows.every((row) => safeRow(row, instance, publication.metadata))) {
			return unavailable(instance.id, "rows-inconsistent");
		}
		const providerStatus = await readStableProviderStatus(tx, input, guard.value);
		if (!providerStatus) return unavailable(instance.id, "rows-inconsistent");
		return {
			instanceId: instance.id,
			metadata: publication.metadata,
			rows: publicRows(rows as TautulliObservationRow[]),
			providerStatus,
		};
	} catch {
		return unavailable(instance.id, "rows-inconsistent");
	}
}

export async function readOwnedTautulliObservation(
	prisma: TautulliObservationPrisma,
	input: { userId: string; instanceId: string; now?: Date },
): Promise<TautulliObservationResult | null> {
	const now = validDate(input.now) ? input.now : new Date();
	const fallback = unavailable(input.instanceId, "unknown-failure");
	return runSerializable(
		prisma,
		(tx) => readSnapshot(tx, { userId: input.userId, instanceId: input.instanceId, now }),
		fallback,
	);
}

export async function readOwnedTautulliObservationForTargets(
	prisma: TautulliObservationPrisma,
	input: {
		userId: string;
		instanceId: string;
		targets: Array<{ tmdbId: number; mediaType: "movie" | "series" }>;
		now?: Date;
	},
): Promise<TautulliObservationResult | null> {
	const now = validDate(input.now) ? input.now : new Date();
	const fallback = unavailable(input.instanceId, "unknown-failure");
	return runSerializable(prisma, (tx) => readSelectedSnapshot(tx, { ...input, now }), fallback);
}

export async function readUserSelectedTautulliObservation(
	prisma: TautulliObservationPrisma,
	input: {
		userId: string;
		targets: Array<{ tmdbId: number; mediaType: "movie" | "series" }>;
		now?: Date;
	},
): Promise<TautulliSelectedObservationResult> {
	const targets = [
		...new Map(
			input.targets.map((target) => [`${target.mediaType}:${target.tmdbId}`, target]),
		).values(),
	];
	if (targets.length > MAX_DISPLAY_TARGETS) {
		return {
			configured: true,
			available: false,
			rows: [],
			providerStatus: unavailable("", "unknown-failure").providerStatus,
			reasonCodes: ["unknown-failure"],
		};
	}
	const now = validDate(input.now) ? input.now : new Date();
	return runSerializable(
		prisma,
		async (tx) => {
			const instances = await tx.serviceInstance.findMany({
				where: { userId: input.userId, service: "TAUTULLI", enabled: true },
				select: { id: true },
				orderBy: { id: "asc" },
			});
			if (instances.length === 0) {
				return { configured: false, available: true, rows: [], reasonCodes: [] };
			}
			if (instances.length !== 1) {
				const status = unavailable("", "unknown-failure").providerStatus;
				return {
					configured: true,
					available: false,
					rows: [],
					providerStatus: status,
					reasonCodes: ["tautulli_mapping_required"],
				};
			}
			const observation = await readSelectedSnapshot(tx, {
				userId: input.userId,
				instanceId: instances[0]!.id,
				targets,
				now,
			});
			if (!observation) {
				const status = unavailable("", "unknown-failure").providerStatus;
				return {
					configured: true,
					available: false,
					rows: [],
					providerStatus: status,
					reasonCodes: status.reasonCodes,
				};
			}
			const available =
				observation.providerStatus.evidence === "positive-only" &&
				(observation.providerStatus.availability === "partial" ||
					observation.providerStatus.availability === "last-known");
			return {
				configured: true,
				available,
				rows: available ? observation.rows : [],
				providerStatus: observation.providerStatus,
				reasonCodes: available ? [] : observation.providerStatus.reasonCodes,
			};
		},
		{
			configured: true,
			available: false,
			rows: [],
			providerStatus: unavailable(input.userId, "unknown-failure").providerStatus,
			reasonCodes: ["unknown-failure"],
		},
	);
}
