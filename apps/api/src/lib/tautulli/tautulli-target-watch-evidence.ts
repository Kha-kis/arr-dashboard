import { createHash } from "node:crypto";
import type { ProviderObservationStatus } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import { plexProviderLogSink } from "../label-sync/plex-provider-log-sink.js";
import { PlexClient, type PlexTargetMetadata } from "../plex/plex-client.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import { readCompleteNativeLibrary } from "../provider-observation/inventory-connection-repository.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import {
	type ProviderIdentityObservation,
	readProviderIdentity,
} from "../services/service-identity.js";
import { TargetWatchReadBudget, type TargetWatchReadPhase } from "./target-watch-read-budget.js";
import { TautulliClient, type TautulliTargetHistoryItem } from "./tautulli-client.js";

const MAX_TARGETS = 200;
const MAX_HISTORY_ROWS = 500;
const MAX_METADATA_REQUESTS = 100;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MAX_AGE_MS = 7 * DEFAULT_MAX_AGE_MS;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

type WatchTarget = { mediaType: "movie" | "series"; tmdbId: number };

export type TautulliTargetWatchEvidence = {
	userId: string;
	instanceId: string;
	plexInstanceId: string;
	mediaType: WatchTarget["mediaType"];
	tmdbId: number;
	generationId: string;
	coordinate: string;
	observedValue: number;
	providerStatus: ProviderObservationStatus;
};

type EvidenceReadInput = {
	prisma: PrismaClient;
	encryptor: Encryptor;
	userId: string;
	targets: readonly WatchTarget[];
	now?: Date;
	maxAgeMs?: number;
	readBudget?: TargetWatchReadBudget;
	readPhase?: TargetWatchReadPhase;
};

type RevalidateInput = Omit<EvidenceReadInput, "targets"> & {
	instanceId: string;
	mediaType: WatchTarget["mediaType"];
	tmdbId: number;
	coordinate: string;
	generationId: string;
	threshold: number;
};

type OwnedProvider = {
	instance: ProviderInstance;
	client: TautulliClient | PlexClient;
	observation: ProviderIdentityObservation;
};

type ProviderInstance = Pick<
	ServiceInstance,
	| "id"
	| "userId"
	| "service"
	| "label"
	| "baseUrl"
	| "enabled"
	| "encryptedApiKey"
	| "encryptionIv"
	| "encryptedHttpAuthCredentials"
	| "httpAuthEncryptionIv"
	| "connectionGeneration"
	| "identityGeneration"
	| "expectedIdentity"
	| "identityKind"
	| "identityStatus"
>;

const silentLog: FastifyBaseLogger = {
	warn: () => undefined,
	info: () => undefined,
	error: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
	fatal: () => undefined,
	child: () => silentLog,
} as unknown as FastifyBaseLogger;

/**
 * Read lower-bound positive Tautulli history, bound to the current Plex
 * native library and current provider identities. The recent Tautulli cache is
 * deliberately not consulted: its observation window cannot gate historical
 * evidence. Only these live GETs prove a watch. A reference_id represents one
 * play across pause/resume rows.
 */
export async function readTautulliTargetWatchEvidence(
	input: EvidenceReadInput,
): Promise<readonly TautulliTargetWatchEvidence[]> {
	const now = input.now ?? new Date();
	const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	if (!isValidDate(now) || !validMaxAge(maxAgeMs)) {
		return [];
	}
	const targets = normalizeTargets(input.targets);
	if (!targets.length || targets.length > MAX_TARGETS || !isSafeUserId(input.userId)) return [];

	const readBudget = input.readBudget ?? new TargetWatchReadBudget();
	const readPhase = input.readPhase ?? "discovery";
	const admit = (requests = 1) => readBudget.tryConsume(requests, readPhase);
	const providers = await establishRelation(input.prisma, input.encryptor, input.userId, admit);
	if (!providers) return [];
	const { tautulli, plex } = providers;

	const nativeCatalog = await readCompleteNativeLibrary(input.prisma, {
		userId: input.userId,
		instanceId: plex.instance.id,
		now,
	});
	if (
		!nativeCatalog?.complete ||
		nativeCatalog.freshness !== "current" ||
		!isValidDate(nativeCatalog.observedAt) ||
		nativeCatalog.observedAt.getTime() > now.getTime() ||
		now.getTime() - nativeCatalog.observedAt.getTime() > maxAgeMs
	)
		return [];
	const nativeRows = nativeCatalog.rows;

	const evidence: TautulliTargetWatchEvidence[] = [];
	const metadata = new Map<string, PlexTargetMetadata>();
	const loadMetadata = async (keys: readonly string[]) => {
		const missing = [...new Set(keys)].filter((key) => !metadata.has(key));
		for (let offset = 0; offset < missing.length; offset += 100) {
			if (!admit()) return;
			try {
				const values = await (plex.client as PlexClient).getTargetMetadataBatch(
					missing.slice(offset, offset + 100),
				);
				for (const value of values) metadata.set(value.ratingKey, value);
			} catch {
				/* A failed batch never becomes evidence or individual retries. */
			}
		}
	};
	const nativeTargets = targets.flatMap((target) => {
		const native = uniqueNativeTarget(nativeRows, target);
		return native ? [{ target, native }] : [];
	});
	await loadMetadata(nativeTargets.map(({ native }) => native.ratingKey));
	for (const { target, native } of nativeTargets) {
		const targetMetadata = metadata.get(native.ratingKey);
		if (!targetMetadata || !validTargetMetadata(targetMetadata, target, native.libraryId)) continue;
		if (!admit()) break;
		const history = await readTargetHistory(
			tautulli.client as TautulliClient,
			target,
			native.ratingKey,
			native.libraryId,
		);
		if (!history) continue;
		if (target.mediaType === "series") {
			const episodeKeys = [
				...new Set(
					history
						.filter(
							(row) =>
								row.media_type === "episode" &&
								row.stopped > 0 &&
								row.grandparent_rating_key === native.ratingKey &&
								(row.section_id === undefined || row.section_id === native.libraryId),
						)
						.map((row) => row.rating_key),
				),
			].slice(0, MAX_METADATA_REQUESTS - 1);
			await loadMetadata(episodeKeys);
		}
		const plays = await countBoundPlays(
			history,
			target,
			native,
			targetMetadata,
			async (ratingKey) => metadata.get(ratingKey),
		);
		if (!plays || plays.count < 1) continue;

		const generationId = digest({
			nativeGenerationId: nativeCatalog.generationId,
			tautulli: authoritySnapshot(tautulli),
			plex: authoritySnapshot(plex),
			native,
			target,
		});
		const coordinate = digest({
			generationId,
			native,
			target,
			plays: plays.coordinates,
		});
		evidence.push({
			userId: input.userId,
			instanceId: tautulli.instance.id,
			plexInstanceId: plex.instance.id,
			mediaType: target.mediaType,
			tmdbId: target.tmdbId,
			generationId,
			coordinate,
			observedValue: plays.count,
			providerStatus: positiveProviderStatus(now),
		});
	}

	const latestRelation = await establishRelation(
		input.prisma,
		input.encryptor,
		input.userId,
		admit,
	);
	const authorityFence = {
		tautulli: authoritySnapshotDigest(tautulli),
		plex: authoritySnapshotDigest(plex),
	};
	return latestRelation !== undefined &&
		latestRelation.tautulli.instance.id === tautulli.instance.id &&
		latestRelation.plex.instance.id === plex.instance.id &&
		authoritySnapshotDigest(latestRelation.tautulli) === authorityFence.tautulli &&
		authoritySnapshotDigest(latestRelation.plex) === authorityFence.plex &&
		(await readCompleteNativeLibrary(input.prisma, {
			userId: input.userId,
			instanceId: plex.instance.id,
			now,
		})
			.then(
				(latest) =>
					latest?.complete === true &&
					latest.freshness === "current" &&
					isValidDate(latest.observedAt) &&
					latest.observedAt.getTime() <= now.getTime() &&
					now.getTime() - latest.observedAt.getTime() <= maxAgeMs &&
					latest.generationId === nativeCatalog.generationId,
			)
			.catch(() => false))
		? evidence
		: [];
}

/** Re-read the exact target proof and require the same current authority fence. */
export async function revalidateTautulliTargetWatchEvidence(
	input: RevalidateInput,
): Promise<boolean> {
	if (
		!isSafeUserId(input.userId) ||
		!Number.isSafeInteger(input.tmdbId) ||
		input.tmdbId <= 0 ||
		!Number.isSafeInteger(input.threshold) ||
		input.threshold < 0 ||
		!DIGEST_PATTERN.test(input.generationId) ||
		!DIGEST_PATTERN.test(input.coordinate) ||
		(input.maxAgeMs !== undefined && !validMaxAge(input.maxAgeMs))
	) {
		return false;
	}
	const results = await readTautulliTargetWatchEvidence({
		...input,
		readPhase: input.readPhase ?? "validation",
		targets: [{ mediaType: input.mediaType, tmdbId: input.tmdbId }],
	});
	const match = results.find(
		(value) =>
			value.instanceId === input.instanceId &&
			value.mediaType === input.mediaType &&
			value.tmdbId === input.tmdbId &&
			value.generationId === input.generationId &&
			value.coordinate === input.coordinate,
	);
	return match !== undefined && match.observedValue > input.threshold;
}

async function establishRelation(
	prisma: PrismaClient,
	encryptor: Encryptor,
	userId: string,
	admit: (requests?: number) => boolean,
) {
	let rows: ProviderInstance[];
	try {
		rows = await prisma.serviceInstance.findMany({
			where: {
				userId,
				enabled: true,
				service: { in: ["TAUTULLI", "PLEX"] },
			},
			orderBy: { label: "asc" },
		});
	} catch {
		return undefined;
	}
	const tautulliRows = rows.filter(
		(row) => row.service === "TAUTULLI" && row.userId === userId && row.enabled,
	);
	if (tautulliRows.length !== 1) return undefined;
	if (!admit(2)) return undefined; // Tautulli identity may require the documented fallback GET.
	const tautulli = await observeProvider(encryptor, tautulliRows[0]!);
	if (!tautulli) return undefined;
	if (
		tautulli.instance.identityStatus !== "VERIFIED" ||
		!identityKindMatches(tautulli.instance.identityKind, "TAUTULLI") ||
		tautulli.instance.expectedIdentity === null ||
		tautulli.instance.expectedIdentity !== tautulli.observation.rawIdentity
	)
		return undefined;

	const plexRows = rows.filter(
		(row) => row.service === "PLEX" && row.userId === userId && row.enabled,
	);
	if (plexRows.length === 0 || !admit(plexRows.length)) return undefined;
	const plexObserved = await Promise.all(plexRows.map((row) => observeProvider(encryptor, row)));
	if (plexObserved.some((value) => value === undefined)) return undefined;
	const matchingPlex = plexObserved.filter(
		(value): value is OwnedProvider =>
			value !== undefined && value.observation.rawIdentity === tautulli.observation.rawIdentity,
	);
	if (matchingPlex.length !== 1) return undefined;
	const selectedPlex = matchingPlex[0]!;
	if (
		selectedPlex.instance.identityStatus !== "VERIFIED" ||
		!identityKindMatches(selectedPlex.instance.identityKind, "PLEX") ||
		selectedPlex.instance.expectedIdentity === null ||
		selectedPlex.instance.expectedIdentity !== selectedPlex.observation.rawIdentity
	)
		return undefined;
	return { tautulli, plex: selectedPlex };
}

async function observeProvider(
	encryptor: Encryptor,
	instance: ProviderInstance,
): Promise<OwnedProvider | undefined> {
	try {
		const apiKey = encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});
		const httpAuthHeaders = getStoredHttpAuthHeaders(encryptor, instance);
		const snapshot = {
			service: instance.service as "PLEX" | "TAUTULLI",
			baseUrl: instance.baseUrl,
			apiKey,
			httpAuthHeaders,
			label: instance.label,
		};
		const observation = await readProviderIdentity(snapshot, silentLog);
		const client =
			instance.service === "PLEX"
				? new PlexClient(instance.baseUrl, apiKey, plexProviderLogSink, undefined, httpAuthHeaders)
				: new TautulliClient(
						instance.baseUrl,
						apiKey,
						plexProviderLogSink,
						undefined,
						httpAuthHeaders,
					);
		return { instance, client, observation };
	} catch {
		return undefined;
	}
}

function identityKindMatches(kind: string | null, service: string): boolean {
	if (service !== "PLEX" && service !== "TAUTULLI") return false;
	const expected = service === "PLEX" ? "PLEX_MACHINE_IDENTIFIER" : "TAUTULLI_PMS_IDENTIFIER";
	const mapped = service === "PLEX" ? "plex-machine-identifier" : "tautulli-pms-identifier";
	return kind === expected || kind === mapped;
}

type NativeTarget = {
	ratingKey: string;
	libraryId: string;
	type: "movie" | "show";
	tmdbId: number;
};

function uniqueNativeTarget(
	rows: readonly {
		nativeId: string;
		mediaType: string;
		libraryIds: readonly string[];
		externalIds?: { tmdb?: number[] };
	}[],
	target: WatchTarget,
): NativeTarget | undefined {
	const matches = rows.filter(
		(row) =>
			row.mediaType === target.mediaType && (row.externalIds?.tmdb ?? []).includes(target.tmdbId),
	);
	if (matches.length !== 1) return undefined;
	const match = matches[0]!;
	if (match.libraryIds.length !== 1 || (match.externalIds?.tmdb ?? []).length !== 1)
		return undefined;
	return {
		ratingKey: match.nativeId,
		libraryId: match.libraryIds[0]!,
		type: target.mediaType === "movie" ? "movie" : "show",
		tmdbId: target.tmdbId,
	};
}

async function readTargetHistory(
	client: TautulliClient,
	target: WatchTarget,
	ratingKey: string,
	sectionId: string,
): Promise<readonly TautulliTargetHistoryItem[] | undefined> {
	try {
		const result = await client.getTargetHistory({
			...(target.mediaType === "movie"
				? { rating_key: ratingKey }
				: { grandparent_rating_key: ratingKey }),
			section_id: sectionId,
			length: MAX_HISTORY_ROWS,
			start: 0,
		});
		if (result.data.length > MAX_HISTORY_ROWS || result.recordsFiltered < result.data.length)
			return undefined;
		return result.data;
	} catch {
		return undefined;
	}
}

async function countBoundPlays(
	rows: readonly TautulliTargetHistoryItem[],
	target: WatchTarget,
	native: NativeTarget,
	targetMetadata: PlexTargetMetadata,
	readMetadata: (ratingKey: string) => Promise<PlexTargetMetadata | undefined>,
) {
	const rowIds = new Set<number>();
	const references = new Map<string, TautulliTargetHistoryItem>();
	const coordinates: string[] = [];
	for (const row of rows) {
		if (
			!Number.isSafeInteger(row.row_id) ||
			row.row_id <= 0 ||
			!safeString(row.reference_id) ||
			row.stopped <= 0 ||
			(row.section_id !== undefined && row.section_id !== native.libraryId) ||
			row.media_type !== (target.mediaType === "movie" ? "movie" : "episode")
		) {
			continue;
		}
		if (rowIds.has(row.row_id)) return undefined;
		rowIds.add(row.row_id);
		if (references.has(row.reference_id)) continue;
		if (target.mediaType === "movie") {
			if (
				row.rating_key !== native.ratingKey ||
				row.guid !== targetMetadata.guid ||
				targetMetadata.type !== "movie"
			) {
				continue;
			}
		} else {
			if (row.grandparent_rating_key !== native.ratingKey) continue;
			const episode = await readMetadata(row.rating_key);
			if (
				episode?.type !== "episode" ||
				episode.librarySectionID !== native.libraryId ||
				episode.grandparentRatingKey !== native.ratingKey ||
				episode.parentRatingKey === undefined ||
				episode.grandparentRatingKey === undefined ||
				episode.guid !== row.guid
			) {
				continue;
			}
		}
		references.set(row.reference_id, row);
		coordinates.push(`${row.reference_id}:${row.row_id}:${row.guid}`);
	}
	return { count: references.size, coordinates: coordinates.sort() };
}

function validTargetMetadata(
	metadata: PlexTargetMetadata,
	target: WatchTarget,
	libraryId: string,
): boolean {
	if (
		metadata.librarySectionID !== libraryId ||
		metadata.type !== (target.mediaType === "movie" ? "movie" : "show") ||
		metadata.ratingKey.trim() === "" ||
		metadata.guid.trim() === ""
	) {
		return false;
	}
	return metadata.Guid.some((guid) => guid.id.trim().toLowerCase() === `tmdb://${target.tmdbId}`);
}

function authoritySnapshot(provider: OwnedProvider) {
	return {
		instanceId: provider.instance.id,
		connectionGeneration: provider.instance.connectionGeneration,
		identityGeneration: provider.instance.identityGeneration,
		identity: provider.observation.confirmationDigest,
	};
}

function authoritySnapshotDigest(provider: OwnedProvider): string {
	return digest(authoritySnapshot(provider));
}

function normalizeTargets(targets: readonly WatchTarget[]): WatchTarget[] {
	const seen = new Set<string>();
	const normalized: WatchTarget[] = [];
	for (const target of targets) {
		if (
			(target.mediaType !== "movie" && target.mediaType !== "series") ||
			!Number.isSafeInteger(target.tmdbId) ||
			target.tmdbId <= 0
		) {
			continue;
		}
		const key = `${target.mediaType}:${target.tmdbId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(target);
	}
	return normalized;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveProviderStatus(now: Date): ProviderObservationStatus {
	const observedAt = now.toISOString();
	return {
		availability: "current",
		evidence: "positive-only",
		observedAt,
		ageSeconds: 0,
		latestAttempt: "successful",
		reasonCodes: ["positive-only"],
		domains: [
			{
				domain: "watch-count",
				availability: "current",
				evidence: "positive-only",
				valueSemantics: "lower-bound",
				observedAt,
				reasonCodes: ["positive-only"],
			},
		],
	};
}

function safeString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isSafeUserId(value: unknown): value is string {
	return safeString(value) && value.length <= 256;
}

function validMaxAge(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MAX_AGE_MS;
}

function isValidDate(value: Date): boolean {
	return value instanceof Date && Number.isFinite(value.getTime());
}
