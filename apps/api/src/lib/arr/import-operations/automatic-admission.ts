import { createHash } from "node:crypto";
import type {
	Prisma,
	QueueCleanerConfig,
	QueueCleanerStrike,
	ServiceInstance,
} from "../../prisma.js";
import { evaluateAutoImportEligibility } from "../../queue-cleaner/auto-import-policy.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";
import { normalizeDownloadId } from "../../queue-cleaner/qui-gate.js";

export interface AutomaticAttemptTracking {
	queueId: number;
	queueFingerprint: string;
	attemptOrdinal: number;
	downloadId: string;
	downloadTitle: string;
	rule: "import_pending" | "import_blocked";
	reason: string;
	statusTexts: string[];
	configFingerprint: string;
}

export interface AutomaticOperationBinding {
	id: string;
	userId: string;
	instanceId: string | null;
	originalInstanceId: string;
	origin: string;
	service: string;
	createdAt: Date;
	files: Array<{ downloadKey: string }>;
}

const SNAPSHOT_OMISSIONS = new Set([
	"createdAt",
	"updatedAt",
	"lastRunAt",
	"lastRunItemsCleaned",
	"lastRunItemsSkipped",
]);
type SupportedService = "SONARR" | "RADARR" | "LIDARR" | "READARR";
const SUPPORTED_SERVICES = new Set<SupportedService>(["SONARR", "RADARR", "LIDARR", "READARR"]);
const AUTOMATIC_RULES = new Set(["import_pending", "import_blocked"]);
const QUEUE_FINGERPRINT_PATTERN = /^v1:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DOWNLOAD_ID_LENGTH = 256;
const MAX_DOWNLOAD_TITLE_LENGTH = 512;
const MAX_REASON_LENGTH = 512;
const MAX_STATUS_COUNT = 32;
const MAX_STATUS_LENGTH = 512;
const MAX_PATTERN_JSON_LENGTH = 32_768;
const MAX_PATTERN_COUNT = 100;
const MAX_PATTERN_LENGTH = 256;

type Tx = Prisma.TransactionClient;
type OperationRow = Prisma.ArrImportOperationGetPayload<{ include: { files: true } }>;

/** Generic conflict surface; no queue title, source identifier, policy text, or database detail. */
export class AutomaticImportAdmissionError extends Error {
	readonly statusCode = 409;

	constructor() {
		super("Automatic import admission is unavailable. Refresh queue state and retry.");
		this.name = "AutomaticImportAdmissionError";
	}
}

function deny(): never {
	throw new AutomaticImportAdmissionError();
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isSupportedService(value: unknown): value is SupportedService {
	return typeof value === "string" && SUPPORTED_SERVICES.has(value as SupportedService);
}

function isBoundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function policyPatternsAreValid(config: QueueCleanerConfig): boolean {
	for (const value of [config.autoImportNeverPatterns, config.autoImportCustomPatterns]) {
		if (value === null) continue;
		if (typeof value !== "string" || value.length > MAX_PATTERN_JSON_LENGTH) return false;
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return false;
		}
		if (
			!Array.isArray(parsed) ||
			parsed.length > MAX_PATTERN_COUNT ||
			parsed.some((pattern) => typeof pattern !== "string" || pattern.length > MAX_PATTERN_LENGTH)
		)
			return false;
	}
	return true;
}

/** Hash all current policy fields while ignoring only run-observation metadata. */
export function automaticImportPolicyFingerprint(config: QueueCleanerConfig): string {
	const canonical = Object.fromEntries(
		Object.entries(config)
			.filter(([key]) => !SNAPSHOT_OMISSIONS.has(key))
			.sort(([left], [right]) => left.localeCompare(right)),
	);
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validateTracking(tracking: AutomaticAttemptTracking): string {
	if (
		!isPositiveSafeInteger(tracking.queueId) ||
		!QUEUE_FINGERPRINT_PATTERN.test(tracking.queueFingerprint) ||
		!isPositiveSafeInteger(tracking.attemptOrdinal) ||
		!isBoundedText(tracking.downloadId, MAX_DOWNLOAD_ID_LENGTH) ||
		tracking.downloadId.trim() !== tracking.downloadId ||
		!isBoundedText(tracking.downloadTitle, MAX_DOWNLOAD_TITLE_LENGTH) ||
		!isBoundedText(tracking.reason, MAX_REASON_LENGTH) ||
		!AUTOMATIC_RULES.has(tracking.rule) ||
		!Array.isArray(tracking.statusTexts) ||
		tracking.statusTexts.length > MAX_STATUS_COUNT ||
		tracking.statusTexts.some((text) => !isBoundedText(text, MAX_STATUS_LENGTH)) ||
		!SHA256_PATTERN.test(tracking.configFingerprint)
	)
		return deny();
	const key = queueDownloadKey({ downloadId: tracking.downloadId });
	if (!key || !SHA256_PATTERN.test(key)) return deny();
	return key;
}

function validateBinding(binding: AutomaticOperationBinding): void {
	if (
		!isBoundedText(binding.id, 128) ||
		!isBoundedText(binding.userId, 128) ||
		!isBoundedText(binding.originalInstanceId, 128) ||
		!isSupportedService(binding.service) ||
		!isValidDate(binding.createdAt) ||
		!Array.isArray(binding.files) ||
		binding.files.length < 1 ||
		binding.files.length > 1000 ||
		binding.files.some((file) => !file || !SHA256_PATTERN.test(file.downloadKey))
	)
		deny();
}

function operationMatches(
	actual: OperationRow | null,
	binding: AutomaticOperationBinding,
	tracking: AutomaticAttemptTracking,
	fileDownloadKey: string,
): actual is OperationRow {
	if (
		!actual ||
		actual.id !== binding.id ||
		actual.userId !== binding.userId ||
		actual.instanceId !== binding.instanceId ||
		actual.originalInstanceId !== binding.originalInstanceId ||
		actual.origin !== binding.origin ||
		actual.service !== binding.service ||
		actual.createdAt.getTime() !== binding.createdAt.getTime() ||
		actual.origin !== "queue-cleaner" ||
		actual.instanceId === null ||
		actual.instanceId !== actual.originalInstanceId ||
		actual.state !== "preparing" ||
		actual.submissionStartedAt !== null ||
		actual.commandId !== null ||
		actual.commandState !== null ||
		actual.commandTerminal ||
		!isSupportedService(actual.service) ||
		actual.files.length !== binding.files.length ||
		actual.files.length === 0 ||
		actual.files.some((file) => file.downloadKey !== fileDownloadKey) ||
		binding.files.some((file) => file.downloadKey !== fileDownloadKey) ||
		tracking.queueId <= 0
	)
		return false;
	return true;
}

async function readBoundOperation(
	tx: Tx,
	binding: AutomaticOperationBinding,
	tracking: AutomaticAttemptTracking,
	fileDownloadKey: string,
): Promise<OperationRow> {
	const actual = await tx.arrImportOperation.findFirst({
		where: { id: binding.id, userId: binding.userId },
		include: { files: true },
	});
	if (!operationMatches(actual, binding, tracking, fileDownloadKey)) return deny();
	return actual;
}

async function readCurrentPolicy(
	tx: Tx,
	operation: OperationRow,
	tracking: AutomaticAttemptTracking,
): Promise<{ config: QueueCleanerConfig; instance: ServiceInstance }> {
	if (!operation.instanceId || operation.instanceId !== operation.originalInstanceId) return deny();
	const instance = await tx.serviceInstance.findFirst({
		where: {
			id: operation.instanceId,
			userId: operation.userId,
			enabled: true,
			service: operation.service,
		},
	});
	if (
		!instance ||
		!isSupportedService(instance.service) ||
		instance.service !== operation.service ||
		importConnectionFingerprint(instance) !== operation.connectionFingerprint
	)
		return deny();
	const config = await tx.queueCleanerConfig.findFirst({
		where: {
			instanceId: operation.instanceId,
			instance: { userId: operation.userId, enabled: true, service: operation.service },
		},
	});
	if (
		!config?.enabled ||
		config.dryRunMode ||
		!config.autoImportEnabled ||
		!isPositiveSafeInteger(config.autoImportMaxAttempts) ||
		!isNonNegativeSafeInteger(config.autoImportCooldownMins) ||
		automaticImportPolicyFingerprint(config) !== tracking.configFingerprint ||
		!policyPatternsAreValid(config)
	)
		return deny();
	return { config, instance };
}

function normalizedPriorStrike(
	strike: QueueCleanerStrike | null,
	queueFingerprint: string,
): QueueCleanerStrike | null {
	if (!strike) return null;
	if (strike.downloadFingerprint !== queueFingerprint) return null;
	if (!isNonNegativeSafeInteger(strike.importAttempts)) return deny();
	return strike;
}

async function readStrike(
	tx: Tx,
	instanceId: string,
	userId: string,
	queueId: number,
): Promise<QueueCleanerStrike | null> {
	return tx.queueCleanerStrike.findFirst({
		where: {
			instanceId,
			downloadId: String(queueId),
			instance: { userId },
		},
	});
}

async function validatePreparation(
	tx: Tx,
	binding: AutomaticOperationBinding,
	tracking: AutomaticAttemptTracking,
): Promise<{
	operation: OperationRow;
	instanceId: string;
	config: QueueCleanerConfig;
	downloadKey: string;
	strike: QueueCleanerStrike | null;
	priorStrike: QueueCleanerStrike | null;
}> {
	validateBinding(binding);
	const downloadKey = validateTracking(tracking);
	if (!isSupportedService(binding.service)) return deny();
	const operation = await readBoundOperation(tx, binding, tracking, downloadKey);
	const { config, instance } = await readCurrentPolicy(tx, operation, tracking);
	if (instance.id !== binding.instanceId || config.instanceId !== instance.id) return deny();
	const strike = await readStrike(tx, instance.id, operation.userId, tracking.queueId);
	const priorStrike = normalizedPriorStrike(strike, tracking.queueFingerprint);
	return { operation, instanceId: instance.id, config, downloadKey, strike, priorStrike };
}

/** Atomically record one policy-admitted automatic attempt in the caller's prepare transaction. */
export async function recordAutomaticPreparation(
	tx: Prisma.TransactionClient,
	operation: AutomaticOperationBinding,
	tracking: AutomaticAttemptTracking,
): Promise<void> {
	const validated = await validatePreparation(tx, operation, tracking);
	const previousAttempts = validated.priorStrike?.importAttempts ?? 0;
	if (tracking.attemptOrdinal !== previousAttempts + 1) return deny();
	const result = evaluateAutoImportEligibility(
		tracking.statusTexts,
		validated.config,
		validated.priorStrike,
		validated.operation.createdAt,
	);
	if (!result.eligible) return deny();
	if (result.reason !== "Eligible for auto-import" && result.reason.length > MAX_REASON_LENGTH)
		return deny();
	const sameTarget = validated.strike?.downloadFingerprint === tracking.queueFingerprint;
	const downloadHash = normalizeDownloadId(tracking.downloadId);
	await tx.queueCleanerStrike.upsert({
		where: {
			instanceId_downloadId: {
				instanceId: validated.instanceId,
				downloadId: String(tracking.queueId),
			},
		},
		create: {
			instanceId: validated.instanceId,
			downloadId: String(tracking.queueId),
			downloadTitle: tracking.downloadTitle,
			downloadHash,
			downloadFingerprint: tracking.queueFingerprint,
			strikeCount: 0,
			firstStrikeAt: validated.operation.createdAt,
			lastRule: tracking.rule,
			lastReason: tracking.reason,
			importAttempts: tracking.attemptOrdinal,
			lastImportAttempt: validated.operation.createdAt,
			lastImportError: null,
		},
		update: {
			downloadTitle: tracking.downloadTitle,
			downloadHash,
			downloadFingerprint: tracking.queueFingerprint,
			...(sameTarget ? {} : { strikeCount: 0, firstStrikeAt: validated.operation.createdAt }),
			lastRule: tracking.rule,
			lastReason: tracking.reason,
			importAttempts: tracking.attemptOrdinal,
			lastImportAttempt: validated.operation.createdAt,
			lastImportError: null,
		},
	});
}

/** Recheck preparation authority immediately before the submission-state CAS. */
export async function assertPreparedAutomaticTracking(
	tx: Prisma.TransactionClient,
	operation: AutomaticOperationBinding,
	tracking: AutomaticAttemptTracking,
): Promise<void> {
	const validated = await validatePreparation(tx, operation, tracking);
	const strike = validated.strike;
	if (
		!strike ||
		strike.downloadFingerprint !== tracking.queueFingerprint ||
		strike.importAttempts !== tracking.attemptOrdinal ||
		!strike.lastImportAttempt ||
		strike.lastImportAttempt.getTime() !== validated.operation.createdAt.getTime()
	)
		return deny();
}
