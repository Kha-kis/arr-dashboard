import { createHash } from "node:crypto";
import type { ProviderObservationStatus } from "@arr/shared";
import {
	createJellyfinMutationTargetIndex,
	resolveJellyfinMutationTarget,
} from "../label-sync/jellyfin-mutation-target.js";
import { plexProviderLogSink } from "../label-sync/plex-provider-log-sink.js";
import type { PrismaClient } from "../prisma.js";
import { readCompleteNativeLibrary } from "../provider-observation/inventory-connection-repository.js";
import { createJellyfinClient } from "./jellyfin-client.js";
import {
	type JellyfinEvidencePrisma,
	type JellyfinLibraryObservation,
	type JellyfinLibraryRow,
	readOwnedJellyfinObservation,
} from "./jellyfin-evidence-repository.js";

type JellyfinTarget = { mediaType: "movie" | "series"; tmdbId: number };

export type JellyfinTargetWatchEvidence = {
	readonly userId: string;
	readonly instanceId: string;
	readonly mediaType: "movie" | "series";
	readonly tmdbId: number;
	readonly generationId: string;
	readonly nativeGenerationId: string;
	readonly nativeId: string;
	readonly libraryId: string;
	readonly observedValue: number;
	readonly coordinate: string;
	readonly providerStatus: ProviderObservationStatus;
};

type EvidenceReadInput = {
	prisma: JellyfinEvidencePrisma;
	userId: string;
	instanceId: string;
	targets: readonly JellyfinTarget[];
	now?: Date;
	maxAgeMs?: number;
};

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MAX_AGE_MS = 7 * DEFAULT_MAX_AGE_MS;
const MAX_TARGETS = 200;

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function validTarget(target: unknown): target is JellyfinTarget {
	if (!target || typeof target !== "object") return false;
	const candidate = target as Record<string, unknown>;
	return (
		(candidate.mediaType === "movie" || candidate.mediaType === "series") &&
		typeof candidate.tmdbId === "number" &&
		Number.isSafeInteger(candidate.tmdbId) &&
		candidate.tmdbId > 0
	);
}

function targetKey(target: JellyfinTarget): string {
	return `${target.mediaType}:${target.tmdbId}`;
}

function positiveCachedUsers(value: string): boolean {
	try {
		const parsed: unknown = JSON.parse(value);
		return (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed.every((entry) => typeof entry === "string" && entry.trim().length > 0)
		);
	} catch {
		return false;
	}
}

function coordinate(input: {
	userId: string;
	instanceId: string;
	mediaType: "movie" | "series";
	tmdbId: number;
	generationId: string;
	nativeGenerationId: string;
	nativeId: string;
	libraryId: string;
	observedValue: number;
	connectionGeneration: number;
	identityGeneration: number;
	providerStatus: {
		availability: ProviderObservationStatus["availability"];
		evidence: ProviderObservationStatus["evidence"];
		domains: ReadonlyArray<{
			domain: string;
			availability: string;
			evidence: string;
			valueSemantics: string;
		}> | null;
	};
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				userId: input.userId,
				instanceId: input.instanceId,
				mediaType: input.mediaType,
				tmdbId: input.tmdbId,
				generationId: input.generationId,
				nativeGenerationId: input.nativeGenerationId,
				nativeId: input.nativeId,
				libraryId: input.libraryId,
				observedValue: input.observedValue,
				connectionGeneration: input.connectionGeneration,
				identityGeneration: input.identityGeneration,
				providerStatus: input.providerStatus,
			}),
		)
		.digest("hex");
}

function stableProviderStatus(status: ProviderObservationStatus) {
	return {
		availability: status.availability,
		evidence: status.evidence,
		domains:
			status.domains
				?.map(({ domain, availability, evidence, valueSemantics }) => ({
					domain,
					availability,
					evidence,
					valueSemantics,
				}))
				.sort((left, right) => left.domain.localeCompare(right.domain)) ?? null,
	};
}

function currentPositiveObservation(
	observation: Awaited<ReturnType<typeof readOwnedJellyfinObservation>>,
): observation is JellyfinLibraryObservation & {
	generationId: string;
	metadata: NonNullable<JellyfinLibraryObservation["metadata"]>;
} {
	const watchDomain = observation?.providerStatus.domains?.find(
		(domain) => domain.domain === "watch-count",
	);
	return (
		observation !== null &&
		observation.service === "JELLYFIN" &&
		observation.cacheType === "jellyfin" &&
		observation.available &&
		(observation.providerStatus.availability === "current" ||
			observation.providerStatus.availability === "partial") &&
		((observation.providerStatus.evidence === "complete" &&
			observation.providerStatus.availability === "current") ||
			observation.providerStatus.evidence === "positive-only") &&
		(observation.providerStatus.evidence === "complete" ||
			(watchDomain?.availability === "current" &&
				(watchDomain.evidence === "complete" || watchDomain.evidence === "positive-only") &&
				(watchDomain.valueSemantics === "exact" ||
					watchDomain.valueSemantics === "lower-bound"))) &&
		typeof observation.generationId === "string" &&
		observation.generationId.trim() !== "" &&
		observation.metadata !== null
	);
}

function matchingCachedRow(
	observation: JellyfinLibraryObservation,
	target: JellyfinTarget,
): JellyfinLibraryRow | undefined {
	const matches = observation.rows.filter(
		(row) => row.mediaType === target.mediaType && row.tmdbId === target.tmdbId,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function makeProof(
	userId: string,
	observation: JellyfinLibraryObservation & { generationId: string },
	nativeGenerationId: string,
	row: JellyfinLibraryRow,
): JellyfinTargetWatchEvidence | undefined {
	const metadata = observation.metadata;
	if (
		row.jellyfinId === null ||
		row.jellyfinId.trim() === "" ||
		row.libraryId.trim() === "" ||
		!Number.isSafeInteger(row.watchCount) ||
		row.watchCount <= 0 ||
		!positiveCachedUsers(row.watchedByUsers) ||
		!metadata ||
		!Number.isSafeInteger(metadata.connectionGeneration) ||
		!Number.isSafeInteger(metadata.identityGeneration)
	)
		return undefined;
	const base = {
		userId,
		instanceId: observation.instanceId,
		mediaType: row.mediaType as "movie" | "series",
		tmdbId: row.tmdbId,
		generationId: observation.generationId,
		nativeGenerationId,
		nativeId: row.jellyfinId,
		libraryId: row.libraryId,
		observedValue: row.watchCount,
		connectionGeneration: metadata.connectionGeneration,
		identityGeneration: metadata.identityGeneration,
		providerStatus: stableProviderStatus(observation.providerStatus),
	};
	const {
		connectionGeneration: _connectionGeneration,
		identityGeneration: _identityGeneration,
		...proof
	} = base;
	return Object.freeze({
		...proof,
		providerStatus: observation.providerStatus,
		coordinate: coordinate(base),
	});
}

async function readProofs(
	input: EvidenceReadInput,
): Promise<readonly JellyfinTargetWatchEvidence[]> {
	if (
		typeof input.userId !== "string" ||
		input.userId.trim() === "" ||
		typeof input.instanceId !== "string" ||
		input.instanceId.trim() === "" ||
		!Array.isArray(input.targets) ||
		input.targets.length === 0 ||
		input.targets.length > MAX_TARGETS ||
		input.targets.some((target) => !validTarget(target))
	)
		return [];
	const targets = input.targets as readonly JellyfinTarget[];
	const keys = targets.map(targetKey);
	if (new Set(keys).size !== keys.length) return [];
	const now = validDate(input.now) ? input.now : new Date();
	const maxAgeMs =
		typeof input.maxAgeMs === "number" &&
		Number.isSafeInteger(input.maxAgeMs) &&
		input.maxAgeMs >= 0 &&
		input.maxAgeMs <= MAX_MAX_AGE_MS
			? input.maxAgeMs
			: DEFAULT_MAX_AGE_MS;
	const observation = await readOwnedJellyfinObservation({
		prisma: input.prisma,
		userId: input.userId,
		instanceId: input.instanceId,
		cacheType: "jellyfin",
		mode: "display",
		now,
		maxAgeMs,
	});
	if (!currentPositiveObservation(observation)) return [];
	const catalog = await readCompleteNativeLibrary(input.prisma as unknown as PrismaClient, {
		userId: input.userId,
		instanceId: input.instanceId,
		now,
	});
	const index = createJellyfinMutationTargetIndex(catalog);
	if (
		!index ||
		!catalog ||
		!validDate(catalog.observedAt) ||
		catalog.observedAt.getTime() > now.getTime() ||
		now.getTime() - catalog.observedAt.getTime() > maxAgeMs
	)
		return [];
	const proofs: JellyfinTargetWatchEvidence[] = [];
	for (const target of targets) {
		const row = matchingCachedRow(observation, target);
		const native = resolveJellyfinMutationTarget(index, target);
		if (
			!row ||
			!native.available ||
			row.jellyfinId !== native.nativeId ||
			row.libraryId !== native.libraryId
		)
			continue;
		const proof = makeProof(input.userId, observation, catalog.generationId, row);
		if (!proof) continue;
		proofs.push(proof);
	}
	return proofs;
}

export async function readJellyfinTargetWatchEvidence(
	input: EvidenceReadInput,
): Promise<readonly JellyfinTargetWatchEvidence[]> {
	try {
		return await readProofs(input);
	} catch {
		return [];
	}
}

export async function revalidateJellyfinTargetWatchEvidence(input: {
	prisma: PrismaClient;
	encryptor: Parameters<typeof createJellyfinClient>[0];
	userId: string;
	instanceId: string;
	mediaType: "movie" | "series";
	tmdbId: number;
	coordinate: string;
	generationId: string;
	threshold: number;
	now?: Date;
	maxAgeMs?: number;
}): Promise<boolean> {
	try {
		if (
			!validTarget({ mediaType: input.mediaType, tmdbId: input.tmdbId }) ||
			typeof input.coordinate !== "string" ||
			!/^[a-f0-9]{64}$/i.test(input.coordinate) ||
			typeof input.generationId !== "string" ||
			input.generationId.trim() === "" ||
			!Number.isSafeInteger(input.threshold) ||
			input.threshold < 0
		)
			return false;
		const now = validDate(input.now) ? input.now : new Date();
		const evidence = await readJellyfinTargetWatchEvidence({
			prisma: input.prisma as unknown as JellyfinEvidencePrisma,
			userId: input.userId,
			instanceId: input.instanceId,
			targets: [{ mediaType: input.mediaType, tmdbId: input.tmdbId }],
			now,
			maxAgeMs: input.maxAgeMs,
		});
		const proof = evidence[0];
		if (
			!proof ||
			proof.generationId !== input.generationId ||
			proof.coordinate !== input.coordinate
		)
			return false;
		const instance = await input.prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId },
		});
		if (
			instance?.service !== "JELLYFIN" ||
			!instance.enabled ||
			instance.identityStatus !== "VERIFIED" ||
			typeof instance.expectedIdentity !== "string" ||
			instance.expectedIdentity.trim() === ""
		)
			return false;
		const client = createJellyfinClient(input.encryptor, instance, plexProviderLogSink);
		const live = await client.readTargetWatchCount({
			itemId: proof.nativeId,
			mediaType: proof.mediaType,
			tmdbId: proof.tmdbId,
			libraryId: proof.libraryId,
		});
		if (
			live.serverId.trim() !== instance.expectedIdentity.trim() ||
			live.itemId !== proof.nativeId ||
			live.mediaType !== proof.mediaType ||
			live.tmdbId !== proof.tmdbId ||
			live.libraryId !== proof.libraryId ||
			!Number.isSafeInteger(live.observedValue) ||
			live.observedValue <= input.threshold
		)
			return false;
		const finalEvidence = await readJellyfinTargetWatchEvidence({
			prisma: input.prisma as unknown as JellyfinEvidencePrisma,
			userId: input.userId,
			instanceId: input.instanceId,
			targets: [{ mediaType: input.mediaType, tmdbId: input.tmdbId }],
			now,
			maxAgeMs: input.maxAgeMs,
		});
		const finalProof = finalEvidence[0];
		return Boolean(
			finalProof &&
				finalProof.coordinate === input.coordinate &&
				finalProof.generationId === input.generationId &&
				finalProof.nativeGenerationId === proof.nativeGenerationId,
		);
	} catch {
		return false;
	}
}
