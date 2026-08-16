import { createHash } from "node:crypto";
import { normalizeTorrentState } from "@arr/shared";
import type {
	Movie,
	MovieFile,
	RadarrClient,
	Notification as RadarrNotification,
} from "arr-sdk/radarr";
import type {
	EpisodeFile,
	Series,
	SonarrClient,
	Notification as SonarrNotification,
} from "arr-sdk/sonarr";
import { createOwnedJellyfinPublicationSnapshot } from "../jellyfin/jellyfin-cache-refresher.js";
import { createOwnedPlexPublicationSnapshot } from "../plex/plex-cache-refresher.js";
import {
	createPlexClient,
	type PlexClient,
	type PlexMovieMediaItem,
	PlexMovieNotFoundError,
	type PlexSeriesMediaItem,
	PlexSeriesNotFoundError,
} from "../plex/plex-client.js";
import { plexConnectionFingerprint as plexEvidenceSourceFingerprint } from "../plex/service-instance-fingerprint.js";
import type { ServiceInstance } from "../prisma.js";
import {
	providerIdentityAuthorityFingerprint,
	providerInstanceAuthorityFingerprint,
	readProviderIdentity,
} from "../services/service-identity.js";
import { toPersistedIdentityKind } from "../services/service-identity-lifecycle.js";
import { createOwnedTautulliPublicationSnapshot } from "../tautulli/tautulli-cache-refresher.js";
import {
	isProviderCacheType,
	loadExactProviderCacheRows,
	type ProviderCacheType,
	providerCacheServicesForDependencies,
	providerServiceUsesCacheType,
} from "./provider-cache-evidence.js";

export { createArrServiceFingerprint } from "../arr/service-fingerprint.js";

import { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { CleanupExecutorDeps, CompleteQuiFileHashIndex } from "./types.js";

export interface CleanupDeleteTarget {
	instanceId: string;
	arrItemId: number;
	itemType: string;
	action?: string | null;
	targetScope?: string | null;
	arrEpisodeId?: number | null;
	seasonNumber?: number | null;
	episodeNumber?: number | null;
	episodeFileId?: number | null;
	episodeFileConsumerIds?: number[];
	plexWatchEvidence?: Array<{
		plexInstanceId: string;
		sourceFingerprint: string;
		ratingKey: string;
		watchCount: number;
		refreshedAt: Date | string;
	}>;
	respectQuiSeeding?: boolean;
	episodeFileInfoHash?: string | null;
	episodeFileTorrentState?: string | null;
}

type SafetyPlexClient = Pick<
	PlexClient,
	"getAccounts" | "getMovieMediaPartsByTmdbId" | "getSeriesEpisodeMediaPartsByTvdbId"
> &
	Partial<Pick<PlexClient, "getEpisodeWatchCount">>;

export interface SharedPlexSafetyContext {
	plexClients: Map<string, SafetyPlexClient>;
	failedPlexConnections: Set<string>;
	verifiedRadarrFiles: Map<string, VerifiedRadarrFileIdentity>;
	verifiedSonarrFiles: Map<string, VerifiedSonarrFileIdentity>;
	plans: Map<string, SharedMediaSafetyPlan>;
	liveEpisodeWatchSources: Map<string, VerifiedEpisodePlexWatchSource[]>;
	quiInstances?: Promise<ServiceInstance[]>;
	quiFileIndexes: Map<string, Promise<CompleteQuiFileHashIndex>>;
	quiHashTorrents: Map<
		string,
		Promise<
			Awaited<
				ReturnType<
					ReturnType<NonNullable<CleanupExecutorDeps["quiClientFactory"]>>["getTorrentsByHash"]
				>
			>
		>
	>;
}

export function createSharedPlexSafetyContext(): SharedPlexSafetyContext {
	return {
		plexClients: new Map(),
		failedPlexConnections: new Set(),
		verifiedRadarrFiles: new Map(),
		verifiedSonarrFiles: new Map(),
		plans: new Map(),
		liveEpisodeWatchSources: new Map(),
		quiFileIndexes: new Map(),
		quiHashTorrents: new Map(),
	};
}

class FileMatchVerificationError extends Error {}
class EpisodeWatchProofError extends FileMatchVerificationError {}

function isQuiSeedingTorrentState(state: string | null | undefined): boolean {
	return state === "seeding" || state === "downloading";
}

interface NormalizedMediaPath {
	value: string;
	windows: boolean;
}

interface MediaFileIdentity {
	fileId: number;
	fullPath: NormalizedMediaPath;
	size: number;
}

export interface VerifiedRadarrFileIdentity {
	movieFileId: number;
	fullPath: NormalizedMediaPath;
	size: number;
}

export interface VerifiedSonarrEpisodeFileIdentity {
	episodeFileId: number;
	fullPath: NormalizedMediaPath;
	size: number;
}

export interface VerifiedSonarrFileIdentity {
	seriesPath: NormalizedMediaPath;
	episodeFiles: VerifiedSonarrEpisodeFileIdentity[];
}

export interface VerifiedSonarrEpisodeIdentity {
	arrEpisodeId: number;
	seasonNumber: number;
	episodeNumber: number;
	episodeFileId: number;
	episodeFileConsumerIds: number[];
	monitored: boolean;
}

export interface VerifiedEpisodePlexWatchProof {
	plexInstanceId: string;
	sourceFingerprint: string;
	plexServerUrl: string;
	ratingKey: string;
	watchCount: number;
	refreshedAt: string;
	fullPath: NormalizedMediaPath;
	size: number;
	mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
}

export interface VerifiedEpisodePlexWatchSource {
	plexInstanceId: string;
	ratingKey: string;
	liveWatchCount: number;
}

export interface VerifiedEpisodeQuiIdentity {
	enabled: boolean;
	infoHash: string | null;
	torrentState: string | null;
}

export interface VerifiedSonarrPeerIdentity {
	instanceId: string;
	serviceFingerprint: string;
	externalId: number;
	arrItemId: number | null;
	mediaPath: NormalizedMediaPath | null;
	files: VerifiedSonarrFileIdentity | null;
}

interface VerifiedSonarrPlexPart {
	ratingKey: string;
	fullPath: NormalizedMediaPath;
	size: number;
}

export interface VerifiedSonarrPlexOwnership {
	plexServerUrl: string;
	target: VerifiedSonarrPlexPart[];
	retained: Array<
		VerifiedSonarrPlexPart & {
			instanceId: string;
			mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
		}
	>;
}

export interface VerifiedSonarrTargetDeleteNotification {
	plexServerUrl: string;
	onSeriesDelete: boolean;
	onEpisodeFileDelete: boolean;
	mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
}

export interface VerifiedArrTargetIdentity {
	serviceFingerprint: string;
	externalId: number;
	mediaPath: NormalizedMediaPath;
}

export interface VerifiedRadarrPeerIdentity {
	instanceId: string;
	serviceFingerprint: string;
	externalId: number;
	arrItemId: number | null;
	mediaPath: NormalizedMediaPath | null;
	file: VerifiedRadarrFileIdentity | null;
}

export interface VerifiedRadarrPlexOwnership {
	plexServerUrl: string;
	target: {
		ratingKey: string;
		fullPath: NormalizedMediaPath;
		size: number;
	};
	retained: Array<{
		instanceId: string;
		ratingKey: string;
		fullPath: NormalizedMediaPath;
		size: number;
		mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
	}>;
}

export interface VerifiedRadarrTargetDeleteNotification {
	plexServerUrl: string;
	onMovieFileDelete: boolean;
	mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
}

export type VerifiedCleanupFileIdentity =
	| { service: "RADARR"; file: VerifiedRadarrFileIdentity }
	| { service: "SONARR"; files: VerifiedSonarrFileIdentity };

export type SharedMediaSafetyPlan =
	| { kind: "not_required" }
	| { kind: "blocked"; reason: string }
	| { kind: "verified_arr_target"; target: VerifiedArrTargetIdentity }
	| { kind: "verified_radarr_empty"; target: VerifiedArrTargetIdentity }
	| {
			kind: "verified_radarr";
			target: VerifiedArrTargetIdentity;
			file: VerifiedRadarrFileIdentity;
			peers: VerifiedRadarrPeerIdentity[];
			peerInventoryComplete?: true;
			ownership: VerifiedRadarrPlexOwnership[];
			targetDeleteNotifications: VerifiedRadarrTargetDeleteNotification[];
	  }
	| {
			kind: "verified_sonarr";
			target: VerifiedArrTargetIdentity;
			files: VerifiedSonarrFileIdentity;
			peers: VerifiedSonarrPeerIdentity[];
			peerInventoryComplete?: true;
			ownership: VerifiedSonarrPlexOwnership[];
			targetDeleteNotifications: VerifiedSonarrTargetDeleteNotification[];
	  }
	| {
			kind: "verified_sonarr_episode";
			target: VerifiedArrTargetIdentity;
			episode: VerifiedSonarrEpisodeIdentity;
			selectedFile: VerifiedSonarrEpisodeFileIdentity;
			retainedTargetFiles: VerifiedSonarrEpisodeFileIdentity[];
			watchProof: VerifiedEpisodePlexWatchProof;
			quiIdentity: VerifiedEpisodeQuiIdentity;
			peers: VerifiedSonarrPeerIdentity[];
			peerInventoryComplete?: true;
			ownership: VerifiedSonarrPlexOwnership[];
			targetDeleteNotifications: VerifiedSonarrTargetDeleteNotification[];
	  };

export type ExecutableSharedMediaSafetyPlan = Extract<
	SharedMediaSafetyPlan,
	{
		kind:
			| "verified_arr_target"
			| "verified_radarr_empty"
			| "verified_radarr"
			| "verified_sonarr"
			| "verified_sonarr_episode";
	}
>;

/**
 * Provider authority captured with a cleanup selection. These fields are
 * deliberately derived-only: no URLs, labels, titles, credentials, raw
 * expected identities, or upstream identifiers belong in approval JSON.
 */
export interface SanitizedProviderEvidenceSource {
	service: "PLEX" | "JELLYFIN" | "EMBY" | "TAUTULLI";
	/** Added after evidence v1 shipped; absent sources remain parseable as conservative legacy evidence. */
	instanceFingerprint?: string;
	identityKind: string;
	identityFingerprint: string;
	connectionGeneration: number;
	identityGeneration: number;
	cacheType: string;
	completedAt: string;
	itemCount: number;
	verifiedAt: string;
	statusFingerprint: string;
	rowFingerprint: string;
	fingerprint: string;
}

export interface SanitizedProviderEvidence {
	version: 1;
	dependencies: string[];
	fingerprint: string;
	sources: SanitizedProviderEvidenceSource[];
}

export interface ExecutableSafetyEnvelope {
	version: 3;
	plan: ExecutableSharedMediaSafetyPlan;
	providerEvidence: SanitizedProviderEvidence;
	mutationCheckpoint: "pre_mutation" | "post_partial_mutation";
	fingerprint: string;
}

function requiredPositiveSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new FileMatchVerificationError(`${label} is unavailable`);
	}
	return value;
}

function requiredNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
		throw new FileMatchVerificationError(`${label} is unavailable`);
	}
	return value.trim();
}

function canonicalTargetIdentity(value: unknown): VerifiedArrTargetIdentity {
	if (!value || typeof value !== "object") {
		throw new FileMatchVerificationError("ARR target identity is invalid");
	}
	const target = value as Record<string, unknown>;
	const serviceFingerprint = requiredNonEmptyString(
		target.serviceFingerprint,
		"ARR service fingerprint",
	);
	if (!/^[a-f0-9]{64}$/.test(serviceFingerprint)) {
		throw new FileMatchVerificationError("ARR service fingerprint is invalid");
	}
	return {
		serviceFingerprint,
		externalId: requiredPositiveSafeInteger(target.externalId, "ARR external media ID"),
		mediaPath: normalizeMediaPath((target.mediaPath as Record<string, unknown> | undefined)?.value),
	};
}

function canonicalRadarrFileIdentity(value: unknown): VerifiedRadarrFileIdentity {
	if (!value || typeof value !== "object") {
		throw new FileMatchVerificationError("Radarr file identity is invalid");
	}
	const file = value as Record<string, unknown>;
	return {
		movieFileId: requiredPositiveSafeInteger(file.movieFileId, "Radarr movie file ID"),
		fullPath: normalizeMediaPath((file.fullPath as Record<string, unknown> | undefined)?.value),
		size: requiredPositiveSafeInteger(file.size, "Radarr movie file size"),
	};
}

function canonicalSonarrFiles(value: unknown): VerifiedSonarrFileIdentity {
	if (!value || typeof value !== "object") {
		throw new FileMatchVerificationError("Sonarr file safety snapshot is invalid");
	}
	const files = value as Record<string, unknown>;
	if (!Array.isArray(files.episodeFiles)) {
		throw new FileMatchVerificationError("Sonarr file safety snapshot is invalid");
	}
	const episodeFiles = files.episodeFiles
		.map((entry) => {
			if (!entry || typeof entry !== "object") {
				throw new FileMatchVerificationError("Sonarr episode-file snapshot is invalid");
			}
			const file = entry as Record<string, unknown>;
			return {
				episodeFileId: requiredPositiveSafeInteger(file.episodeFileId, "Sonarr episode file ID"),
				fullPath: normalizeMediaPath((file.fullPath as Record<string, unknown> | undefined)?.value),
				size: requiredPositiveSafeInteger(file.size, "Sonarr episode file size"),
			};
		})
		.sort((left, right) => left.episodeFileId - right.episodeFileId);
	if (new Set(episodeFiles.map((file) => file.episodeFileId)).size !== episodeFiles.length) {
		throw new FileMatchVerificationError("Sonarr safety snapshot contains duplicate file IDs");
	}
	return {
		seriesPath: normalizeMediaPath(
			(files.seriesPath as Record<string, unknown> | undefined)?.value,
		),
		episodeFiles,
	};
}

function canonicalSonarrEpisodeIdentity(value: unknown): VerifiedSonarrEpisodeIdentity {
	if (!value || typeof value !== "object") {
		throw new FileMatchVerificationError("Sonarr episode safety snapshot is invalid");
	}
	const episode = value as Record<string, unknown>;
	if (!Array.isArray(episode.episodeFileConsumerIds)) {
		throw new FileMatchVerificationError("Sonarr episode file membership is invalid");
	}
	const consumerIds = episode.episodeFileConsumerIds
		.map((id) => requiredPositiveSafeInteger(id, "Sonarr episode consumer ID"))
		.sort((left, right) => left - right);
	if (
		consumerIds.length !== 1 ||
		new Set(consumerIds).size !== consumerIds.length ||
		typeof episode.monitored !== "boolean"
	) {
		throw new FileMatchVerificationError("Sonarr episode is not an exact single-episode target");
	}
	const arrEpisodeId = requiredPositiveSafeInteger(episode.arrEpisodeId, "Sonarr episode ID");
	if (consumerIds[0] !== arrEpisodeId) {
		throw new FileMatchVerificationError("Sonarr episode file membership changed");
	}
	const seasonNumber = episode.seasonNumber;
	if (typeof seasonNumber !== "number" || !Number.isSafeInteger(seasonNumber) || seasonNumber < 0) {
		throw new FileMatchVerificationError("Sonarr season number is invalid");
	}
	return {
		arrEpisodeId,
		seasonNumber,
		episodeNumber: requiredPositiveSafeInteger(episode.episodeNumber, "Sonarr episode number"),
		episodeFileId: requiredPositiveSafeInteger(episode.episodeFileId, "Sonarr episode file ID"),
		episodeFileConsumerIds: consumerIds,
		monitored: episode.monitored,
	};
}

function canonicalEpisodeWatchProof(value: unknown): VerifiedEpisodePlexWatchProof {
	if (!value || typeof value !== "object") {
		throw new FileMatchVerificationError("Plex episode watch proof is invalid");
	}
	const proof = value as Record<string, unknown>;
	const refreshedAt = requiredNonEmptyString(proof.refreshedAt, "Plex watch refresh time");
	if (!Number.isFinite(Date.parse(refreshedAt))) {
		throw new FileMatchVerificationError("Plex watch refresh time is invalid");
	}
	const mapping = proof.mapping as Record<string, unknown> | null | undefined;
	return {
		plexInstanceId: requiredNonEmptyString(proof.plexInstanceId, "Plex watch instance ID"),
		sourceFingerprint: requiredNonEmptyString(
			proof.sourceFingerprint,
			"Plex watch source fingerprint",
		),
		plexServerUrl: requiredNonEmptyString(proof.plexServerUrl, "Plex watch server URL"),
		ratingKey: requiredNonEmptyString(proof.ratingKey, "Plex episode rating key"),
		watchCount: requiredPositiveSafeInteger(proof.watchCount, "Plex episode watch count"),
		refreshedAt: new Date(refreshedAt).toISOString(),
		fullPath: normalizeMediaPath((proof.fullPath as Record<string, unknown> | undefined)?.value),
		size: requiredPositiveSafeInteger(proof.size, "Plex episode media part size"),
		mapping:
			mapping === null
				? null
				: {
						from: normalizeMediaPath((mapping?.from as Record<string, unknown> | undefined)?.value),
						to: normalizeMediaPath((mapping?.to as Record<string, unknown> | undefined)?.value),
					},
	};
}

function canonicalEpisodeQuiIdentity(value: unknown): VerifiedEpisodeQuiIdentity {
	if (!value || typeof value !== "object") {
		throw new FileMatchVerificationError("Episode qUI identity is invalid");
	}
	const identity = value as Record<string, unknown>;
	if (typeof identity.enabled !== "boolean") {
		throw new FileMatchVerificationError("Episode qUI protection setting is invalid");
	}
	const infoHash =
		identity.infoHash === null
			? null
			: requiredNonEmptyString(identity.infoHash, "Episode qUI info hash");
	const torrentState =
		identity.torrentState === null
			? null
			: requiredNonEmptyString(identity.torrentState, "Episode qUI torrent state");
	return { enabled: identity.enabled, infoHash, torrentState };
}

function canonicalSonarrEpisodeFile(
	value: unknown,
	label: string,
): VerifiedSonarrEpisodeFileIdentity {
	if (!value || typeof value !== "object") {
		throw new FileMatchVerificationError(`${label} is invalid`);
	}
	const file = value as Record<string, unknown>;
	return {
		episodeFileId: requiredPositiveSafeInteger(file.episodeFileId, "Sonarr episode file ID"),
		fullPath: normalizeMediaPath((file.fullPath as Record<string, unknown> | undefined)?.value),
		size: requiredPositiveSafeInteger(file.size, "Sonarr episode file size"),
	};
}

function canonicalRetainedSonarrEpisodeFiles(
	value: unknown,
	selectedFileId: number,
): VerifiedSonarrEpisodeFileIdentity[] {
	if (!Array.isArray(value)) {
		throw new FileMatchVerificationError("Sonarr retained file inventory is invalid");
	}
	const files = value
		.map((file) => canonicalSonarrEpisodeFile(file, "Sonarr retained episode file"))
		.sort((left, right) => left.episodeFileId - right.episodeFileId);
	if (
		files.some((file) => file.episodeFileId === selectedFileId) ||
		new Set(files.map((file) => file.episodeFileId)).size !== files.length
	) {
		throw new FileMatchVerificationError("Sonarr retained file inventory is ambiguous");
	}
	return files;
}

function canonicalSonarrPeers(value: unknown): VerifiedSonarrPeerIdentity[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new FileMatchVerificationError("Sonarr peer safety snapshot is invalid");
	}
	const peers = value
		.map((entry) => {
			if (!entry || typeof entry !== "object") {
				throw new FileMatchVerificationError("Sonarr peer safety snapshot is invalid");
			}
			const peer = entry as Record<string, unknown>;
			const serviceFingerprint = requiredNonEmptyString(
				peer.serviceFingerprint,
				"Sonarr peer service fingerprint",
			);
			if (!/^[a-f0-9]{64}$/.test(serviceFingerprint)) {
				throw new FileMatchVerificationError("Sonarr peer service fingerprint is invalid");
			}
			const arrItemId =
				peer.arrItemId === null
					? null
					: requiredPositiveSafeInteger(peer.arrItemId, "Sonarr peer series ID");
			const mediaPath =
				peer.mediaPath === null
					? null
					: normalizeMediaPath((peer.mediaPath as Record<string, unknown> | undefined)?.value);
			const files = peer.files === null ? null : canonicalSonarrFiles(peer.files);
			if (
				arrItemId === null
					? mediaPath !== null || files !== null
					: mediaPath === null || files === null || !pathsEqual(files.seriesPath, mediaPath)
			) {
				throw new FileMatchVerificationError("Sonarr peer series snapshot is inconsistent");
			}
			return {
				instanceId: requiredNonEmptyString(peer.instanceId, "Sonarr peer instance ID"),
				serviceFingerprint,
				externalId: requiredPositiveSafeInteger(peer.externalId, "Sonarr peer external media ID"),
				arrItemId,
				mediaPath,
				files,
			};
		})
		.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
	if (new Set(peers.map((peer) => peer.instanceId)).size !== peers.length) {
		throw new FileMatchVerificationError(
			"Sonarr peer safety snapshot contains duplicate instances",
		);
	}
	return peers;
}

function canonicalSonarrOwnership(value: unknown): VerifiedSonarrPlexOwnership[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new FileMatchVerificationError("Sonarr Plex ownership snapshot is invalid");
	}
	const ownership = value.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new FileMatchVerificationError("Sonarr Plex ownership snapshot is invalid");
		}
		const witness = entry as Record<string, unknown>;
		if (!Array.isArray(witness.target) || !Array.isArray(witness.retained)) {
			throw new FileMatchVerificationError("Sonarr Plex ownership snapshot is invalid");
		}
		const target = witness.target
			.map((targetEntry) => {
				if (!targetEntry || typeof targetEntry !== "object") {
					throw new FileMatchVerificationError("Sonarr target-part snapshot is invalid");
				}
				const part = targetEntry as Record<string, unknown>;
				return {
					ratingKey: requiredNonEmptyString(part.ratingKey, "Sonarr target Plex rating key"),
					fullPath: normalizeMediaPath(
						(part.fullPath as Record<string, unknown> | undefined)?.value,
					),
					size: requiredPositiveSafeInteger(part.size, "Sonarr target Plex part size"),
				};
			})
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		const retained = witness.retained
			.map((retainedEntry) => {
				if (!retainedEntry || typeof retainedEntry !== "object") {
					throw new FileMatchVerificationError("Sonarr retained-part snapshot is invalid");
				}
				const part = retainedEntry as Record<string, unknown>;
				const mapping = part.mapping as Record<string, unknown> | null | undefined;
				return {
					instanceId: requiredNonEmptyString(part.instanceId, "Sonarr retained-part instance ID"),
					ratingKey: requiredNonEmptyString(part.ratingKey, "Sonarr retained Plex rating key"),
					fullPath: normalizeMediaPath(
						(part.fullPath as Record<string, unknown> | undefined)?.value,
					),
					size: requiredPositiveSafeInteger(part.size, "Sonarr retained Plex part size"),
					mapping:
						mapping === null
							? null
							: {
									from: normalizeMediaPath(
										(mapping?.from as Record<string, unknown> | undefined)?.value,
									),
									to: normalizeMediaPath(
										(mapping?.to as Record<string, unknown> | undefined)?.value,
									),
								},
				};
			})
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		return {
			plexServerUrl: requiredNonEmptyString(witness.plexServerUrl, "Sonarr ownership Plex URL"),
			target,
			retained,
		};
	});
	const unique = new Map(ownership.map((entry) => [JSON.stringify(entry), entry]));
	return [...unique.values()].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
}

function canonicalSonarrTargetDeleteNotifications(
	value: unknown,
): VerifiedSonarrTargetDeleteNotification[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new FileMatchVerificationError("Sonarr target notification snapshot is invalid");
	}
	const notifications = value.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new FileMatchVerificationError("Sonarr target notification snapshot is invalid");
		}
		const notification = entry as Record<string, unknown>;
		const normalizedUrl = normalizedServerUrl(
			requiredNonEmptyString(notification.plexServerUrl, "Sonarr target notification Plex URL"),
		);
		if (!normalizedUrl) {
			throw new FileMatchVerificationError("Sonarr target notification Plex URL is invalid");
		}
		const mapping = notification.mapping as Record<string, unknown> | null | undefined;
		return {
			plexServerUrl: normalizedUrl,
			onSeriesDelete:
				notification.onSeriesDelete === undefined ? true : notification.onSeriesDelete === true,
			onEpisodeFileDelete: notification.onEpisodeFileDelete === true,
			mapping:
				mapping === null
					? null
					: {
							from: normalizeMediaPath(
								(mapping?.from as Record<string, unknown> | undefined)?.value,
							),
							to: normalizeMediaPath((mapping?.to as Record<string, unknown> | undefined)?.value),
						},
		};
	});
	const unique = new Map(notifications.map((entry) => [JSON.stringify(entry), entry]));
	return [...unique.values()].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
}

function canonicalRadarrPeers(value: unknown): VerifiedRadarrPeerIdentity[] {
	if (!Array.isArray(value)) {
		throw new FileMatchVerificationError("Radarr peer safety snapshot is invalid");
	}
	const peers = value
		.map((entry) => {
			if (!entry || typeof entry !== "object") {
				throw new FileMatchVerificationError("Radarr peer safety snapshot is invalid");
			}
			const peer = entry as Record<string, unknown>;
			const serviceFingerprint = requiredNonEmptyString(
				peer.serviceFingerprint,
				"Radarr peer service fingerprint",
			);
			if (!/^[a-f0-9]{64}$/.test(serviceFingerprint)) {
				throw new FileMatchVerificationError("Radarr peer service fingerprint is invalid");
			}
			const arrItemId =
				peer.arrItemId === null
					? null
					: requiredPositiveSafeInteger(peer.arrItemId, "Radarr peer movie ID");
			const mediaPath =
				peer.mediaPath === null
					? null
					: normalizeMediaPath((peer.mediaPath as Record<string, unknown> | undefined)?.value);
			const file = peer.file === null ? null : canonicalRadarrFileIdentity(peer.file);
			if (arrItemId === null ? mediaPath !== null || file !== null : mediaPath === null) {
				throw new FileMatchVerificationError("Radarr peer movie snapshot is inconsistent");
			}
			return {
				instanceId: requiredNonEmptyString(peer.instanceId, "Radarr peer instance ID"),
				serviceFingerprint,
				externalId: requiredPositiveSafeInteger(peer.externalId, "Radarr peer external media ID"),
				arrItemId,
				mediaPath,
				file,
			};
		})
		.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
	if (new Set(peers.map((peer) => peer.instanceId)).size !== peers.length) {
		throw new FileMatchVerificationError(
			"Radarr peer safety snapshot contains duplicate instances",
		);
	}
	return peers;
}

function canonicalRadarrOwnership(value: unknown): VerifiedRadarrPlexOwnership[] {
	if (!Array.isArray(value)) {
		throw new FileMatchVerificationError("Radarr Plex ownership snapshot is invalid");
	}
	const ownership = value.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new FileMatchVerificationError("Radarr Plex ownership snapshot is invalid");
		}
		const witness = entry as Record<string, unknown>;
		const target = witness.target as Record<string, unknown> | undefined;
		if (!target || !Array.isArray(witness.retained)) {
			throw new FileMatchVerificationError("Radarr Plex ownership snapshot is invalid");
		}
		const retained = witness.retained
			.map((retainedEntry) => {
				if (!retainedEntry || typeof retainedEntry !== "object") {
					throw new FileMatchVerificationError("Radarr retained-part snapshot is invalid");
				}
				const part = retainedEntry as Record<string, unknown>;
				const mapping = part.mapping as Record<string, unknown> | null | undefined;
				return {
					instanceId: requiredNonEmptyString(part.instanceId, "Radarr retained-part instance ID"),
					ratingKey: requiredNonEmptyString(part.ratingKey, "Radarr retained Plex rating key"),
					fullPath: normalizeMediaPath(
						(part.fullPath as Record<string, unknown> | undefined)?.value,
					),
					size: requiredPositiveSafeInteger(part.size, "Radarr retained Plex part size"),
					mapping:
						mapping === null
							? null
							: {
									from: normalizeMediaPath(
										(mapping?.from as Record<string, unknown> | undefined)?.value,
									),
									to: normalizeMediaPath(
										(mapping?.to as Record<string, unknown> | undefined)?.value,
									),
								},
				};
			})
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		return {
			plexServerUrl: requiredNonEmptyString(witness.plexServerUrl, "Radarr ownership Plex URL"),
			target: {
				ratingKey: requiredNonEmptyString(target.ratingKey, "Radarr target Plex rating key"),
				fullPath: normalizeMediaPath(
					(target.fullPath as Record<string, unknown> | undefined)?.value,
				),
				size: requiredPositiveSafeInteger(target.size, "Radarr target Plex part size"),
			},
			retained,
		};
	});
	const unique = new Map(ownership.map((entry) => [JSON.stringify(entry), entry]));
	return [...unique.values()].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
}

function canonicalRadarrTargetDeleteNotifications(
	value: unknown,
): VerifiedRadarrTargetDeleteNotification[] {
	if (!Array.isArray(value)) {
		throw new FileMatchVerificationError("Radarr target notification snapshot is invalid");
	}
	const notifications = value.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new FileMatchVerificationError("Radarr target notification snapshot is invalid");
		}
		const notification = entry as Record<string, unknown>;
		const normalizedUrl = normalizedServerUrl(
			requiredNonEmptyString(notification.plexServerUrl, "Radarr target notification Plex URL"),
		);
		if (!normalizedUrl) {
			throw new FileMatchVerificationError("Radarr target notification Plex URL is invalid");
		}
		const mapping = notification.mapping as Record<string, unknown> | null | undefined;
		return {
			plexServerUrl: normalizedUrl,
			onMovieFileDelete: notification.onMovieFileDelete === true,
			mapping:
				mapping === null
					? null
					: {
							from: normalizeMediaPath(
								(mapping?.from as Record<string, unknown> | undefined)?.value,
							),
							to: normalizeMediaPath((mapping?.to as Record<string, unknown> | undefined)?.value),
						},
		};
	});
	const unique = new Map(notifications.map((entry) => [JSON.stringify(entry), entry]));
	return [...unique.values()].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
}

function buildTargetIdentity(
	instance: ServiceInstance,
	externalId: unknown,
	mediaPath: unknown,
): VerifiedArrTargetIdentity {
	return canonicalTargetIdentity({
		serviceFingerprint: createArrServiceFingerprint(instance),
		externalId,
		mediaPath: { value: mediaPath },
	});
}

function canonicalExecutableSafetyPlan(plan: unknown): ExecutableSharedMediaSafetyPlan {
	if (!plan || typeof plan !== "object" || !("kind" in plan)) {
		throw new FileMatchVerificationError("Cleanup safety snapshot is invalid");
	}
	const candidate = plan as Record<string, unknown>;
	if (candidate.kind === "verified_arr_target") {
		return {
			kind: "verified_arr_target",
			target: canonicalTargetIdentity(candidate.target),
		};
	}
	if (candidate.kind === "verified_radarr_empty") {
		return {
			kind: "verified_radarr_empty",
			target: canonicalTargetIdentity(candidate.target),
		};
	}
	if (candidate.kind === "verified_radarr") {
		return {
			kind: "verified_radarr",
			target: canonicalTargetIdentity(candidate.target),
			file: canonicalRadarrFileIdentity(candidate.file),
			peers: canonicalRadarrPeers(candidate.peers),
			...(candidate.peerInventoryComplete === true ? { peerInventoryComplete: true as const } : {}),
			ownership: canonicalRadarrOwnership(candidate.ownership),
			targetDeleteNotifications: canonicalRadarrTargetDeleteNotifications(
				candidate.targetDeleteNotifications,
			),
		};
	}
	if (candidate.kind === "verified_sonarr") {
		return {
			kind: "verified_sonarr",
			target: canonicalTargetIdentity(candidate.target),
			files: canonicalSonarrFiles(candidate.files),
			peers: canonicalSonarrPeers(candidate.peers),
			...(candidate.peerInventoryComplete === true ? { peerInventoryComplete: true as const } : {}),
			ownership: canonicalSonarrOwnership(candidate.ownership),
			targetDeleteNotifications: canonicalSonarrTargetDeleteNotifications(
				candidate.targetDeleteNotifications,
			),
		};
	}
	if (candidate.kind === "verified_sonarr_episode") {
		const episode = canonicalSonarrEpisodeIdentity(candidate.episode);
		const selectedFile = canonicalSonarrEpisodeFile(
			candidate.selectedFile,
			"Sonarr selected episode file",
		);
		if (selectedFile.episodeFileId !== episode.episodeFileId) {
			throw new FileMatchVerificationError("Sonarr selected episode file identity is inconsistent");
		}
		return {
			kind: "verified_sonarr_episode",
			target: canonicalTargetIdentity(candidate.target),
			episode,
			selectedFile,
			retainedTargetFiles: canonicalRetainedSonarrEpisodeFiles(
				candidate.retainedTargetFiles,
				selectedFile.episodeFileId,
			),
			watchProof: canonicalEpisodeWatchProof(candidate.watchProof),
			quiIdentity: canonicalEpisodeQuiIdentity(candidate.quiIdentity),
			peers: canonicalSonarrPeers(candidate.peers),
			...(candidate.peerInventoryComplete === true ? { peerInventoryComplete: true as const } : {}),
			ownership: canonicalSonarrOwnership(candidate.ownership),
			targetDeleteNotifications: canonicalSonarrTargetDeleteNotifications(
				candidate.targetDeleteNotifications,
			),
		};
	}
	throw new FileMatchVerificationError("Cleanup safety snapshot is not executable");
}

function canonicalFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function providerSourcePayload(source: Omit<SanitizedProviderEvidenceSource, "fingerprint">) {
	return {
		service: source.service,
		...(source.instanceFingerprint === undefined
			? {}
			: { instanceFingerprint: source.instanceFingerprint }),
		identityKind: source.identityKind,
		identityFingerprint: source.identityFingerprint,
		connectionGeneration: source.connectionGeneration,
		identityGeneration: source.identityGeneration,
		cacheType: source.cacheType,
		completedAt: source.completedAt,
		itemCount: source.itemCount,
		verifiedAt: source.verifiedAt,
		statusFingerprint: source.statusFingerprint,
		rowFingerprint: source.rowFingerprint,
	};
}

export function createSanitizedProviderEvidence(
	dependencies: string[],
	sources: Array<Omit<SanitizedProviderEvidenceSource, "fingerprint">>,
): SanitizedProviderEvidence {
	const orderedDependencies = [...new Set(dependencies)].sort();
	const orderedSources = sources
		.map((source) => ({
			...providerSourcePayload(source),
			fingerprint: canonicalFingerprint(providerSourcePayload(source)),
		}))
		.sort(
			(left, right) =>
				left.service.localeCompare(right.service) ||
				left.cacheType.localeCompare(right.cacheType) ||
				left.identityFingerprint.localeCompare(right.identityFingerprint),
		);
	if ((orderedDependencies.length === 0) !== (orderedSources.length === 0)) {
		throw new FileMatchVerificationError(
			"Cleanup provider dependencies and evidence sources are inconsistent",
		);
	}
	return {
		version: 1,
		dependencies: orderedDependencies,
		sources: orderedSources,
		fingerprint: canonicalFingerprint({
			dependencies: orderedDependencies,
			sources: orderedSources,
		}),
	};
}

export interface SanitizedProviderScanAuthority {
	version: 1;
	providerEvidence: SanitizedProviderEvidence;
	fingerprint: string;
}

type ProviderScanTarget = {
	instanceId: string;
	service: "PLEX" | "JELLYFIN" | "EMBY";
	mediaType: "movie" | "show";
};

export function serializeProviderScanAuthority(
	target: ProviderScanTarget,
	providerEvidence: SanitizedProviderEvidence,
): string {
	const canonicalEvidence = canonicalProviderEvidence(providerEvidence);
	if (
		canonicalEvidence.sources.length === 0 ||
		canonicalEvidence.sources.some(
			(source) =>
				source.service !== target.service ||
				!isProviderCacheType(source.cacheType) ||
				!providerServiceUsesCacheType(target.service, source.cacheType),
		)
	) {
		throw new ProviderExecutionAuthorityChangedError();
	}
	const services = providerCacheServicesForDependencies(canonicalEvidence.dependencies);
	if (!services?.includes(target.service)) throw new ProviderExecutionAuthorityChangedError();
	return JSON.stringify({
		version: 1,
		providerEvidence: canonicalEvidence,
		fingerprint: canonicalFingerprint({
			instanceId: target.instanceId,
			service: target.service,
			mediaType: target.mediaType,
			providerEvidenceFingerprint: canonicalEvidence.fingerprint,
		}),
	} satisfies SanitizedProviderScanAuthority);
}

export function parseProviderScanAuthority(
	value: string | null,
	target: ProviderScanTarget,
): SanitizedProviderEvidence | null {
	if (!value) return null;
	try {
		const candidate = JSON.parse(value) as Partial<SanitizedProviderScanAuthority>;
		if (candidate.version !== 1 || typeof candidate.fingerprint !== "string") return null;
		const providerEvidence = canonicalProviderEvidence(candidate.providerEvidence);
		if (
			providerEvidence.sources.length === 0 ||
			providerEvidence.sources.some(
				(source) =>
					source.service !== target.service ||
					!isProviderCacheType(source.cacheType) ||
					!providerServiceUsesCacheType(target.service, source.cacheType),
			)
		) {
			return null;
		}
		const services = providerCacheServicesForDependencies(providerEvidence.dependencies);
		if (!services?.includes(target.service)) return null;
		const fingerprint = canonicalFingerprint({
			instanceId: target.instanceId,
			service: target.service,
			mediaType: target.mediaType,
			providerEvidenceFingerprint: providerEvidence.fingerprint,
		});
		return candidate.fingerprint === fingerprint ? providerEvidence : null;
	} catch {
		return null;
	}
}

const PROVIDER_EXECUTION_EVIDENCE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export class ProviderExecutionAuthorityChangedError extends Error {
	readonly code = "PROVIDER_EXECUTION_AUTHORITY_CHANGED";

	constructor() {
		super("Provider execution authority changed");
		this.name = "ProviderExecutionAuthorityChangedError";
	}
}

function providerExecutionFingerprint(value: unknown): string {
	const canonicalize = (input: unknown): unknown => {
		if (input instanceof Date) return input.toISOString();
		if (Array.isArray(input)) return input.map(canonicalize);
		if (typeof input === "object" && input !== null) {
			return Object.fromEntries(
				Object.entries(input as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, canonicalize(entry)]),
			);
		}
		return input;
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function providerExecutionInstanceFingerprint(instance: ServiceInstance): string {
	return providerExecutionFingerprint({
		id: instance.id,
		userId: instance.userId,
		service: instance.service,
		baseUrl: instance.baseUrl,
		enabled: instance.enabled,
		encryptedApiKey: instance.encryptedApiKey,
		encryptionIv: instance.encryptionIv,
		encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
		httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
		expectedIdentity: instance.expectedIdentity,
		identityKind: instance.identityKind,
		identityStatus: instance.identityStatus,
		identityVerifiedAt: instance.identityVerifiedAt,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
		updatedAt: instance.updatedAt,
	});
}

function isCurrentProviderExecutionInstance(instance: ServiceInstance): boolean {
	return (
		instance.enabled &&
		(instance.service === "PLEX" ||
			instance.service === "JELLYFIN" ||
			instance.service === "EMBY" ||
			instance.service === "TAUTULLI") &&
		instance.identityStatus === "VERIFIED" &&
		typeof instance.expectedIdentity === "string" &&
		instance.expectedIdentity.trim() !== "" &&
		instance.identityKind !== null &&
		instance.identityVerifiedAt !== null &&
		Number.isSafeInteger(instance.connectionGeneration) &&
		instance.connectionGeneration >= 0 &&
		Number.isSafeInteger(instance.identityGeneration) &&
		instance.identityGeneration > 0
	);
}

async function loadProviderExecutionEvidence(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	dependencies: string[],
	cacheTypes: ProviderCacheType[],
	now: Date,
	target?: Pick<ProviderScanTarget, "instanceId" | "service">,
): Promise<{ evidence: SanitizedProviderEvidence; instances: ServiceInstance[] }> {
	const services = providerCacheServicesForDependencies(dependencies);
	const uniqueCacheTypes = [...new Set(cacheTypes)];
	if (
		!services ||
		services.length === 0 ||
		uniqueCacheTypes.length === 0 ||
		uniqueCacheTypes.some((cacheType) => !isProviderCacheType(cacheType))
	) {
		throw new ProviderExecutionAuthorityChangedError();
	}
	if (target && !services.includes(target.service)) {
		throw new ProviderExecutionAuthorityChangedError();
	}
	const instances = (await prisma.serviceInstance.findMany({
		where: target
			? { id: target.instanceId, userId, service: target.service, enabled: true }
			: { userId, service: { in: services }, enabled: true },
		orderBy: { id: "asc" },
	})) as ServiceInstance[];
	if (
		instances.length === 0 ||
		instances.some((instance) => !isCurrentProviderExecutionInstance(instance))
	) {
		throw new ProviderExecutionAuthorityChangedError();
	}
	const statuses = await prisma.cacheRefreshStatus.findMany({
		where: {
			instanceId: { in: instances.map((instance) => instance.id) },
			cacheType: { in: uniqueCacheTypes },
		},
		select: {
			instanceId: true,
			cacheType: true,
			lastRefreshedAt: true,
			lastResult: true,
			lastErrorMessage: true,
			lastAttemptResult: true,
			lastAttemptErrorMessage: true,
			itemCount: true,
			connectionGeneration: true,
			identityGeneration: true,
			generationId: true,
			generationMetadata: true,
		},
	});
	const statusesByKey = new Map(
		statuses.map((status) => [`${status.instanceId}:${status.cacheType}`, status]),
	);
	const rowsByType = new Map<ProviderCacheType, Map<string, unknown[]>>();
	for (const cacheType of uniqueCacheTypes) {
		rowsByType.set(
			cacheType,
			await loadExactProviderCacheRows(
				prisma as never,
				cacheType,
				instances.map((instance) => instance.id),
			),
		);
	}
	const freshnessThreshold = now.getTime() - PROVIDER_EXECUTION_EVIDENCE_FRESHNESS_MS;
	const sources: Array<Omit<SanitizedProviderEvidenceSource, "fingerprint">> = [];
	for (const instance of instances) {
		const applicableTypes = uniqueCacheTypes.filter((cacheType) =>
			providerServiceUsesCacheType(
				instance.service as SanitizedProviderEvidenceSource["service"],
				cacheType as ProviderCacheType,
			),
		) as ProviderCacheType[];
		for (const cacheType of applicableTypes) {
			const status = statusesByKey.get(`${instance.id}:${cacheType}`);
			if (
				!status ||
				instance.identityVerifiedAt === null ||
				status.lastResult !== "success" ||
				status.lastErrorMessage !== null ||
				status.lastAttemptErrorMessage !== null ||
				(status.lastAttemptResult !== null && status.lastAttemptResult !== "success") ||
				status.lastRefreshedAt.getTime() < freshnessThreshold ||
				status.lastRefreshedAt.getTime() < instance.updatedAt.getTime() ||
				status.lastRefreshedAt.getTime() < instance.identityVerifiedAt.getTime() ||
				status.connectionGeneration !== instance.connectionGeneration ||
				status.identityGeneration !== instance.identityGeneration
			) {
				throw new ProviderExecutionAuthorityChangedError();
			}
			const rows = rowsByType.get(cacheType)?.get(instance.id) ?? [];
			if (rows.length !== status.itemCount) throw new ProviderExecutionAuthorityChangedError();
			sources.push({
				service: instance.service as SanitizedProviderEvidenceSource["service"],
				instanceFingerprint: providerInstanceAuthorityFingerprint(instance.id),
				identityKind: instance.identityKind!,
				identityFingerprint: providerIdentityAuthorityFingerprint(instance),
				connectionGeneration: status.connectionGeneration!,
				identityGeneration: status.identityGeneration!,
				cacheType,
				completedAt: status.lastRefreshedAt.toISOString(),
				itemCount: status.itemCount,
				verifiedAt: instance.identityVerifiedAt.toISOString(),
				statusFingerprint: providerExecutionFingerprint({
					instance: {
						id: instance.id,
						expectedIdentity: instance.expectedIdentity,
						identityKind: instance.identityKind,
						identityVerifiedAt: instance.identityVerifiedAt,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
						updatedAt: instance.updatedAt,
					},
					status: {
						instanceId: status.instanceId,
						lastRefreshedAt: status.lastRefreshedAt,
						lastResult: status.lastResult,
						lastErrorMessage: status.lastErrorMessage,
						lastAttemptResult: status.lastAttemptResult,
						lastAttemptErrorMessage: status.lastAttemptErrorMessage,
						itemCount: status.itemCount,
						connectionGeneration: status.connectionGeneration,
						identityGeneration: status.identityGeneration,
						generationId: status.generationId,
						generationMetadata: status.generationMetadata,
					},
				}),
				rowFingerprint: providerExecutionFingerprint(rows),
			});
		}
	}
	return { evidence: createSanitizedProviderEvidence(dependencies, sources), instances };
}

async function loadCurrentProviderExecutionEvidence(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	accepted: SanitizedProviderEvidence,
	now: Date,
	target?: Pick<ProviderScanTarget, "instanceId" | "service">,
): Promise<{ evidence: SanitizedProviderEvidence; instances: ServiceInstance[] }> {
	const cacheTypes = [...new Set(accepted.sources.map((source) => source.cacheType))];
	if (cacheTypes.some((cacheType) => !isProviderCacheType(cacheType))) {
		throw new ProviderExecutionAuthorityChangedError();
	}
	return loadProviderExecutionEvidence(
		prisma,
		userId,
		accepted.dependencies,
		cacheTypes as ProviderCacheType[],
		now,
		target,
	);
}

/**
 * Capture the exact durable provider generations that participated in a
 * cleanup decision. A cleanup run lease must already prevent concurrent
 * publication before callers use this evidence to authorize a mutation.
 */
export async function captureCurrentProviderEvidenceAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	dependencies: ProviderCacheType[],
): Promise<SanitizedProviderEvidence> {
	const uniqueDependencies = [...new Set(dependencies)].sort();
	if (uniqueDependencies.length === 0) return emptyProviderEvidence();
	const testCapturer = (
		deps as unknown as {
			providerEvidenceCapturer?: (
				userId: string,
				dependencies: ProviderCacheType[],
			) => Promise<SanitizedProviderEvidence>;
		}
	).providerEvidenceCapturer;
	if (testCapturer)
		return canonicalProviderEvidence(await testCapturer(userId, uniqueDependencies));
	try {
		return (
			await loadProviderExecutionEvidence(
				deps.prisma,
				userId,
				uniqueDependencies,
				uniqueDependencies,
				new Date(),
			)
		).evidence;
	} catch (error) {
		if (error instanceof ProviderExecutionAuthorityChangedError) throw error;
		throw new ProviderExecutionAuthorityChangedError();
	}
}

export async function captureCurrentProviderScanAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	target: ProviderScanTarget,
): Promise<string> {
	try {
		const testCapturer = (
			deps as unknown as {
				providerScanAuthorityCapturer?: (target: ProviderScanTarget) => Promise<string>;
			}
		).providerScanAuthorityCapturer;
		if (testCapturer) return await testCapturer(target);

		const cacheType: ProviderCacheType = target.service === "PLEX" ? "plex" : "jellyfin";
		const current = await loadProviderExecutionEvidence(
			deps.prisma,
			userId,
			[cacheType],
			[cacheType],
			new Date(),
			target,
		);
		if (current.evidence.sources.length === 0) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		return serializeProviderScanAuthority(target, current.evidence);
	} catch (error) {
		if (error instanceof ProviderExecutionAuthorityChangedError) throw error;
		throw new ProviderExecutionAuthorityChangedError();
	}
}

export async function createCurrentProviderScanAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	target: ProviderScanTarget,
	accepted: SanitizedProviderEvidence,
): Promise<string> {
	try {
		const canonicalAccepted = canonicalProviderEvidence(accepted);
		const acceptedSources = canonicalAccepted.sources.filter(
			(source) =>
				source.service === target.service &&
				isProviderCacheType(source.cacheType) &&
				providerServiceUsesCacheType(target.service, source.cacheType),
		);
		if (acceptedSources.length === 0) throw new ProviderExecutionAuthorityChangedError();
		const testCreator = (
			deps as unknown as {
				providerScanAuthorityCreator?: (
					target: ProviderScanTarget,
					evidence: SanitizedProviderEvidence,
				) => Promise<string>;
			}
		).providerScanAuthorityCreator;
		if (testCreator) return await testCreator(target, canonicalAccepted);
		const targetRequest = createSanitizedProviderEvidence(
			[...new Set(acceptedSources.map((source) => source.cacheType))],
			acceptedSources.map(({ fingerprint: _fingerprint, ...source }) => source),
		);
		const current = await loadCurrentProviderExecutionEvidence(
			deps.prisma,
			userId,
			targetRequest,
			new Date(),
			target,
		);
		if (
			current.evidence.sources.length === 0 ||
			!current.evidence.sources.every((currentSource) =>
				acceptedSources.some((acceptedSource) =>
					providerEvidenceSourceMatches(acceptedSource, currentSource),
				),
			)
		) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		return serializeProviderScanAuthority(target, current.evidence);
	} catch (error) {
		if (error instanceof ProviderExecutionAuthorityChangedError) throw error;
		throw new ProviderExecutionAuthorityChangedError();
	}
}

function currentEvidenceMatches(
	accepted: SanitizedProviderEvidence,
	current: SanitizedProviderEvidence,
): boolean {
	if (accepted.fingerprint === current.fingerprint) return true;
	return (
		JSON.stringify(accepted.dependencies) === JSON.stringify(current.dependencies) &&
		providerEvidenceSourcesMatch(accepted.sources, current.sources)
	);
}

function stableProviderEvidenceMatches(
	accepted: SanitizedProviderEvidence,
	current: SanitizedProviderEvidence,
): boolean {
	if (
		accepted.sources.some((source) => source.instanceFingerprint === undefined) ||
		current.sources.some((source) => source.instanceFingerprint === undefined)
	) {
		return currentEvidenceMatches(accepted, current);
	}
	if (
		JSON.stringify(accepted.dependencies) !== JSON.stringify(current.dependencies) ||
		accepted.sources.length !== current.sources.length
	) {
		return false;
	}
	const remaining = [...current.sources];
	for (const acceptedSource of accepted.sources) {
		const matchIndex = remaining.findIndex(
			(currentSource) =>
				acceptedSource.service === currentSource.service &&
				acceptedSource.instanceFingerprint === currentSource.instanceFingerprint &&
				acceptedSource.identityKind === currentSource.identityKind &&
				acceptedSource.identityFingerprint === currentSource.identityFingerprint &&
				acceptedSource.connectionGeneration === currentSource.connectionGeneration &&
				acceptedSource.identityGeneration === currentSource.identityGeneration &&
				acceptedSource.cacheType === currentSource.cacheType &&
				acceptedSource.verifiedAt === currentSource.verifiedAt,
		);
		if (matchIndex < 0) return false;
		remaining.splice(matchIndex, 1);
	}
	return true;
}

function providerEvidenceSourcesMatch(
	accepted: SanitizedProviderEvidenceSource[],
	current: SanitizedProviderEvidenceSource[],
): boolean {
	if (accepted.length !== current.length) return false;
	const remaining = [...current];
	for (const acceptedSource of accepted) {
		const matchIndex = remaining.findIndex((currentSource) =>
			providerEvidenceSourceMatches(acceptedSource, currentSource),
		);
		if (matchIndex < 0) return false;
		remaining.splice(matchIndex, 1);
	}
	return true;
}

function providerEvidenceSourceMatches(
	accepted: SanitizedProviderEvidenceSource,
	current: SanitizedProviderEvidenceSource,
): boolean {
	if (accepted.instanceFingerprint !== undefined) {
		return accepted.fingerprint === current.fingerprint;
	}
	const {
		instanceFingerprint: _currentInstanceFingerprint,
		fingerprint: _currentFingerprint,
		...currentLegacyPayload
	} = current;
	const { fingerprint: _acceptedFingerprint, ...acceptedLegacyPayload } = accepted;
	return JSON.stringify(acceptedLegacyPayload) === JSON.stringify(currentLegacyPayload);
}

/**
 * Re-authorize every provider-dependent target from the durable Task 6 evidence.
 * Live network identity reads happen before the final database transaction; the
 * transaction then locks and rechecks the exact stored status/rows snapshot.
 */
export async function assertCurrentProviderEvidenceAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	accepted: SanitizedProviderEvidence,
	assertLease?: () => Promise<void>,
): Promise<void> {
	await authorizeProviderEvidence(deps, userId, accepted, assertLease, currentEvidenceMatches);
}

export async function renewCurrentProviderRetryAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	accepted: SanitizedProviderEvidence,
	assertLease?: () => Promise<void>,
): Promise<SanitizedProviderEvidence> {
	const testRenewer = (
		deps as unknown as {
			providerRetryAuthorityRenewer?: (
				userId: string,
				evidence: SanitizedProviderEvidence,
				assertLease?: () => Promise<void>,
			) => Promise<SanitizedProviderEvidence>;
		}
	).providerRetryAuthorityRenewer;
	if (testRenewer) return await testRenewer(userId, accepted, assertLease);
	return await authorizeProviderEvidence(
		deps,
		userId,
		accepted,
		assertLease,
		stableProviderEvidenceMatches,
	);
}

async function authorizeProviderEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	accepted: SanitizedProviderEvidence,
	assertLease?: () => Promise<void>,
	evidenceMatches: (
		accepted: SanitizedProviderEvidence,
		current: SanitizedProviderEvidence,
	) => boolean = currentEvidenceMatches,
	target?: Pick<ProviderScanTarget, "instanceId" | "service">,
): Promise<SanitizedProviderEvidence> {
	if (accepted.dependencies.length === 0 && accepted.sources.length === 0) {
		if (target) throw new ProviderExecutionAuthorityChangedError();
		return accepted;
	}
	const testAuthorityChecker = (
		deps as unknown as {
			providerEvidenceAuthorityChecker?: (
				userId: string,
				evidence: SanitizedProviderEvidence,
				assertLease?: () => Promise<void>,
			) => Promise<void>;
		}
	).providerEvidenceAuthorityChecker;
	if (testAuthorityChecker) {
		await testAuthorityChecker(userId, accepted, assertLease);
		return accepted;
	}
	try {
		const canonicalAccepted = createSanitizedProviderEvidence(
			accepted.dependencies,
			accepted.sources.map(({ fingerprint: _fingerprint, ...source }) => source),
		);
		if (!currentEvidenceMatches(accepted, canonicalAccepted)) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		await assertLease?.();
		const before = await loadCurrentProviderExecutionEvidence(
			deps.prisma,
			userId,
			accepted,
			new Date(),
			target,
		);
		if (!evidenceMatches(accepted, before.evidence)) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		if (!deps.encryptor) throw new ProviderExecutionAuthorityChangedError();
		const identityReader =
			(deps as unknown as { providerIdentityReader?: typeof readProviderIdentity })
				.providerIdentityReader ?? readProviderIdentity;
		for (const instance of before.instances) {
			const owned =
				instance.service === "PLEX"
					? createOwnedPlexPublicationSnapshot(deps.encryptor, instance)
					: instance.service === "TAUTULLI"
						? createOwnedTautulliPublicationSnapshot(deps.encryptor, instance)
						: createOwnedJellyfinPublicationSnapshot(deps.encryptor, instance);
			const observation = await identityReader(owned, deps.log);
			if (
				observation.service !== instance.service ||
				toPersistedIdentityKind(observation.identityKind) !== instance.identityKind ||
				observation.rawIdentity !== instance.expectedIdentity
			) {
				throw new ProviderExecutionAuthorityChangedError();
			}
		}
		await assertLease?.();
		const expectedInstanceFingerprint = providerExecutionFingerprint(
			before.instances.map(providerExecutionInstanceFingerprint),
		);
		const postgresql = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
		await deps.prisma.$transaction(
			async (tx) => {
				if (postgresql) {
					for (const instanceId of before.instances.map((instance) => instance.id).sort()) {
						await tx.$queryRawUnsafe(
							'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
							instanceId,
						);
					}
				}
				const current = await loadCurrentProviderExecutionEvidence(
					tx as unknown as CleanupExecutorDeps["prisma"],
					userId,
					accepted,
					new Date(),
					target,
				);
				if (
					!currentEvidenceMatches(before.evidence, current.evidence) ||
					providerExecutionFingerprint(
						current.instances.map(providerExecutionInstanceFingerprint),
					) !== expectedInstanceFingerprint
				) {
					throw new ProviderExecutionAuthorityChangedError();
				}
			},
			postgresql ? undefined : { isolationLevel: "Serializable" },
		);
		return before.evidence;
	} catch (error) {
		if (error instanceof ProviderExecutionAuthorityChangedError) throw error;
		throw new ProviderExecutionAuthorityChangedError();
	}
}

export async function assertCurrentProviderScanAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	serializedAuthority: string | null,
	target: ProviderScanTarget,
	assertLease?: () => Promise<void>,
): Promise<void> {
	const providerEvidence = parseProviderScanAuthority(serializedAuthority, target);
	if (!providerEvidence) throw new ProviderExecutionAuthorityChangedError();
	const testAuthorityChecker = (
		deps as unknown as {
			providerEvidenceAuthorityChecker?: (
				userId: string,
				evidence: SanitizedProviderEvidence,
				assertLease?: () => Promise<void>,
			) => Promise<void>;
		}
	).providerEvidenceAuthorityChecker;
	if (testAuthorityChecker) {
		await testAuthorityChecker(userId, providerEvidence, assertLease);
		return;
	}
	try {
		// Cache generations authorize the pre-delete capture, but normal cache
		// publications must not invalidate an already-durable post-delete retry.
		// Retry authority stays bound to the owned instance and enrolled identity.
		const matchesStableAuthority = (instance: ServiceInstance): boolean =>
			isCurrentProviderExecutionInstance(instance) &&
			instance.id === target.instanceId &&
			instance.userId === userId &&
			instance.service === target.service &&
			providerEvidence.sources.every(
				(source) =>
					source.service === instance.service &&
					(source.instanceFingerprint === undefined ||
						source.instanceFingerprint === providerInstanceAuthorityFingerprint(instance.id)) &&
					source.identityKind === instance.identityKind &&
					source.identityFingerprint === providerIdentityAuthorityFingerprint(instance) &&
					source.connectionGeneration === instance.connectionGeneration &&
					source.identityGeneration === instance.identityGeneration &&
					source.verifiedAt === instance.identityVerifiedAt?.toISOString(),
			);
		await assertLease?.();
		const instance = (await deps.prisma.serviceInstance.findFirst({
			where: { id: target.instanceId, userId, service: target.service, enabled: true },
		})) as ServiceInstance | null;
		if (!instance || !matchesStableAuthority(instance)) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		if (!deps.encryptor) throw new ProviderExecutionAuthorityChangedError();
		const identityReader =
			(deps as unknown as { providerIdentityReader?: typeof readProviderIdentity })
				.providerIdentityReader ?? readProviderIdentity;
		const owned =
			instance.service === "PLEX"
				? createOwnedPlexPublicationSnapshot(deps.encryptor, instance)
				: createOwnedJellyfinPublicationSnapshot(deps.encryptor, instance);
		const observation = await identityReader(owned, deps.log);
		if (
			observation.service !== instance.service ||
			toPersistedIdentityKind(observation.identityKind) !== instance.identityKind ||
			observation.rawIdentity !== instance.expectedIdentity
		) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		await assertLease?.();
		const expectedInstanceFingerprint = providerExecutionInstanceFingerprint(instance);
		const postgresql = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
		await deps.prisma.$transaction(
			async (tx) => {
				if (postgresql) {
					await tx.$queryRawUnsafe(
						'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
						target.instanceId,
					);
				}
				const current = (await tx.serviceInstance.findFirst({
					where: { id: target.instanceId, userId, service: target.service, enabled: true },
				})) as ServiceInstance | null;
				if (
					!current ||
					!matchesStableAuthority(current) ||
					providerExecutionInstanceFingerprint(current) !== expectedInstanceFingerprint
				) {
					throw new ProviderExecutionAuthorityChangedError();
				}
			},
			postgresql ? undefined : { isolationLevel: "Serializable" },
		);
	} catch (error) {
		if (error instanceof ProviderExecutionAuthorityChangedError) throw error;
		throw new ProviderExecutionAuthorityChangedError();
	}
}

function emptyProviderEvidence(): SanitizedProviderEvidence {
	return createSanitizedProviderEvidence([], []);
}

function canonicalProviderEvidence(value: unknown): SanitizedProviderEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new FileMatchVerificationError("Cleanup provider evidence is unavailable");
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== 1 ||
		typeof candidate.fingerprint !== "string" ||
		!Array.isArray(candidate.sources) ||
		!Array.isArray(candidate.dependencies)
	) {
		throw new FileMatchVerificationError("Cleanup provider evidence is invalid");
	}
	const sources = candidate.sources.map((source) => {
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			throw new FileMatchVerificationError("Cleanup provider evidence source is invalid");
		}
		const row = source as Record<string, unknown>;
		if (
			(row.service !== "PLEX" &&
				row.service !== "JELLYFIN" &&
				row.service !== "EMBY" &&
				row.service !== "TAUTULLI") ||
			typeof row.identityKind !== "string" ||
			!isSha256(row.identityFingerprint) ||
			(row.instanceFingerprint !== undefined && !isSha256(row.instanceFingerprint)) ||
			!Number.isSafeInteger(row.connectionGeneration) ||
			!Number.isSafeInteger(row.identityGeneration) ||
			typeof row.cacheType !== "string" ||
			typeof row.completedAt !== "string" ||
			!Number.isSafeInteger(row.itemCount) ||
			typeof row.verifiedAt !== "string" ||
			!isSha256(row.statusFingerprint) ||
			!isSha256(row.rowFingerprint) ||
			!isSha256(row.fingerprint)
		) {
			throw new FileMatchVerificationError("Cleanup provider evidence source is invalid");
		}
		const canonical = {
			service: row.service as SanitizedProviderEvidenceSource["service"],
			...(row.instanceFingerprint === undefined
				? {}
				: { instanceFingerprint: row.instanceFingerprint as string }),
			identityKind: row.identityKind as string,
			identityFingerprint: row.identityFingerprint as string,
			connectionGeneration: row.connectionGeneration as number,
			identityGeneration: row.identityGeneration as number,
			cacheType: row.cacheType as string,
			completedAt: row.completedAt as string,
			itemCount: row.itemCount as number,
			verifiedAt: row.verifiedAt as string,
			statusFingerprint: row.statusFingerprint as string,
			rowFingerprint: row.rowFingerprint as string,
		};
		if (canonicalFingerprint(canonical) !== row.fingerprint) {
			throw new FileMatchVerificationError("Cleanup provider evidence source was tampered");
		}
		return { ...canonical, fingerprint: row.fingerprint as string };
	});
	const dependencies = candidate.dependencies.map((dependency) => {
		if (typeof dependency !== "string" || dependency.trim() === "") {
			throw new FileMatchVerificationError("Cleanup provider dependency is invalid");
		}
		return dependency;
	});
	const canonical = createSanitizedProviderEvidence(dependencies, sources);
	if (candidate.fingerprint !== canonical.fingerprint) {
		throw new FileMatchVerificationError("Cleanup provider evidence was tampered");
	}
	return canonical;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function serializeExecutableSafetyPlan(
	plan: ExecutableSharedMediaSafetyPlan,
	providerEvidence: SanitizedProviderEvidence = emptyProviderEvidence(),
	mutationCheckpoint: ExecutableSafetyEnvelope["mutationCheckpoint"] = "pre_mutation",
): string {
	const canonicalPlan = canonicalExecutableSafetyPlan(plan);
	const canonicalEvidence = canonicalProviderEvidence(providerEvidence);
	return JSON.stringify({
		version: 3,
		plan: canonicalPlan,
		providerEvidence: canonicalEvidence,
		mutationCheckpoint,
		fingerprint: canonicalFingerprint({
			plan: canonicalPlan,
			providerEvidenceFingerprint: canonicalEvidence.fingerprint,
			mutationCheckpoint,
		}),
	});
}

export function parseExecutableSafetyEnvelope(value: unknown): ExecutableSafetyEnvelope | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	try {
		const snapshot = JSON.parse(value) as Record<string, unknown>;
		if (
			snapshot?.version !== 3 ||
			(snapshot.mutationCheckpoint !== "pre_mutation" &&
				snapshot.mutationCheckpoint !== "post_partial_mutation") ||
			!isSha256(snapshot.fingerprint)
		) {
			return null;
		}
		const providerEvidence = canonicalProviderEvidence(snapshot.providerEvidence);
		const plan = canonicalExecutableSafetyPlan(snapshot.plan);
		const fingerprint = canonicalFingerprint({
			plan,
			providerEvidenceFingerprint: providerEvidence.fingerprint,
			mutationCheckpoint: snapshot.mutationCheckpoint,
		});
		if (snapshot.fingerprint !== fingerprint) return null;
		return {
			version: 3,
			plan,
			providerEvidence,
			mutationCheckpoint: snapshot.mutationCheckpoint,
			fingerprint,
		};
	} catch {
		return null;
	}
}

export function parseExecutableSafetyPlan(value: unknown): ExecutableSharedMediaSafetyPlan | null {
	return parseExecutableSafetyEnvelope(value)?.plan ?? null;
}

export function executableSafetyPlansEqual(
	left: ExecutableSharedMediaSafetyPlan,
	right: ExecutableSharedMediaSafetyPlan,
): boolean {
	if (serializeExecutableSafetyPlan(left) === serializeExecutableSafetyPlan(right)) return true;
	const withoutNoPeerTopology = (plan: ExecutableSharedMediaSafetyPlan) => {
		if (
			(plan.kind !== "verified_radarr" && plan.kind !== "verified_sonarr") ||
			plan.peers.length !== 0
		) {
			return plan;
		}
		return { ...plan, peerInventoryComplete: undefined, ownership: [] };
	};
	return (
		JSON.stringify(withoutNoPeerTopology(left)) === JSON.stringify(withoutNoPeerTopology(right))
	);
}

export function buildRadarrCacheSafetyPlan(
	data: unknown,
	hasFile: boolean,
	liveTarget: VerifiedArrTargetIdentity,
): ExecutableSharedMediaSafetyPlan | null {
	if (!data || typeof data !== "object") return null;
	const item = data as Record<string, unknown>;
	const remoteIds =
		item.remoteIds && typeof item.remoteIds === "object"
			? (item.remoteIds as Record<string, unknown>)
			: undefined;
	const target: VerifiedArrTargetIdentity = {
		...liveTarget,
		externalId: requiredPositiveSafeInteger(remoteIds?.tmdbId, "Cached Radarr TMDb ID"),
		mediaPath: normalizeMediaPath(item.path),
	};
	const movieFileId = (item.movieFile as Record<string, unknown> | null | undefined)?.id;
	if (!hasFile) {
		return typeof movieFileId !== "number" || movieFileId <= 0
			? { kind: "verified_radarr_empty", target }
			: null;
	}
	return null;
}

export function radarrCachedFileIdentityMatches(
	moviePath: unknown,
	movieFile: Record<string, unknown> | undefined,
	expected: VerifiedRadarrFileIdentity,
): boolean {
	if (!movieFile || movieFile.id !== expected.movieFileId || movieFile.size !== expected.size) {
		return false;
	}
	try {
		const fullPath =
			typeof movieFile.path === "string" && movieFile.path.trim() !== ""
				? movieFile.path
				: joinMediaPath(moviePath, movieFile.relativePath, "RADARR");
		return pathsEqual(normalizeMediaPath(fullPath), expected.fullPath);
	} catch {
		return false;
	}
}

export function buildSonarrCacheSafetyPlan(
	seriesPath: unknown,
	externalId: unknown,
	hasFile: boolean,
	episodeFiles: Array<{ arrEpisodeFileId: number; path: string; size: bigint | number }>,
	liveTarget: VerifiedArrTargetIdentity,
): ExecutableSharedMediaSafetyPlan | null {
	if (hasFile !== episodeFiles.length > 0) return null;
	try {
		const target: VerifiedArrTargetIdentity = {
			...liveTarget,
			externalId: requiredPositiveSafeInteger(externalId, "Cached Sonarr TVDb ID"),
			mediaPath: normalizeMediaPath(seriesPath),
		};
		return canonicalExecutableSafetyPlan({
			kind: "verified_sonarr",
			target,
			files: {
				seriesPath: { value: seriesPath },
				episodeFiles: episodeFiles.map((file) => ({
					episodeFileId: file.arrEpisodeFileId,
					fullPath: { value: file.path },
					size: Number(file.size),
				})),
			},
			peers: [],
			ownership: [],
			targetDeleteNotifications: [],
		});
	} catch {
		return null;
	}
}

export function buildCacheTargetSafetyPlan(
	data: unknown,
	itemType: "movie" | "series",
	liveTarget: VerifiedArrTargetIdentity,
): ExecutableSharedMediaSafetyPlan | null {
	if (!data || typeof data !== "object") return null;
	const item = data as Record<string, unknown>;
	const remoteIds =
		item.remoteIds && typeof item.remoteIds === "object"
			? (item.remoteIds as Record<string, unknown>)
			: undefined;
	return canonicalExecutableSafetyPlan({
		kind: "verified_arr_target",
		target: {
			...liveTarget,
			externalId: requiredPositiveSafeInteger(
				itemType === "movie" ? remoteIds?.tmdbId : remoteIds?.tvdbId,
				itemType === "movie" ? "Cached Radarr TMDb ID" : "Cached Sonarr TVDb ID",
			),
			mediaPath: { value: item.path },
		},
	});
}

export class ArrFileChangedDuringSafetyCheckError extends Error {}

export class ArrMutationAuthorityChangedDuringSafetyCheckError extends ArrFileChangedDuringSafetyCheckError {}

export class ArrTargetChangedDuringSafetyCheckError extends ArrMutationAuthorityChangedDuringSafetyCheckError {
	constructor() {
		super(
			"Skipped for safety: the ARR target changed during live verification. Run cleanup again before mutating it.",
		);
	}
}

export class ArrCrossInstanceOwnershipChangedDuringSafetyCheckError extends ArrMutationAuthorityChangedDuringSafetyCheckError {
	constructor(service: "RADARR" | "SONARR") {
		super(crossInstanceOwnershipReason(service));
	}
}

export class RadarrFileChangedDuringSafetyCheckError extends ArrFileChangedDuringSafetyCheckError {
	constructor() {
		super(
			"Skipped for safety: the Radarr movie file changed during live Plex verification. Retry after the current import or upgrade finishes.",
		);
	}
}

export class SonarrFilesChangedDuringSafetyCheckError extends ArrFileChangedDuringSafetyCheckError {
	constructor() {
		super(
			"Skipped for safety: the Sonarr episode files changed during live Plex verification. Retry after the current import or upgrade finishes.",
		);
	}
}

interface NotificationLike {
	enable?: boolean | null;
	implementation?: string | null;
	implementationName?: string | null;
	configContract?: string | null;
	fields?: Array<{ name?: string | null; value?: unknown }> | null;
	tags?: number[] | null;
}

type PlexNotification = RadarrNotification | SonarrNotification;

function serviceLabel(service: "RADARR" | "SONARR"): string {
	return service === "RADARR" ? "Radarr movie" : "Sonarr series";
}

function mergedItemReason(service: "RADARR" | "SONARR"): string {
	const target = service === "RADARR" ? "Radarr movie file" : "Sonarr episode file";
	return `Skipped for safety: the exact ${target} belongs to an item where Plex has multiple files merged. The ${service === "RADARR" ? "Radarr" : "Sonarr"}-triggered refresh could recreate that shared item and lose custom artwork or metadata.`;
}

function verificationFailedReason(service: "RADARR" | "SONARR"): string {
	if (service === "RADARR") {
		return "Skipped for safety: arr-dashboard could not verify the live Radarr and Plex media state needed to make this movie deletion safe.";
	}
	return `Skipped for safety: arr-dashboard could not verify the live ${serviceLabel(service)} and Plex media state needed to make this deletion safe.`;
}

function fileMatchFailedReason(service: "RADARR" | "SONARR"): string {
	const target = service === "RADARR" ? "Radarr movie file" : "Sonarr episode files";
	return `Skipped for safety: arr-dashboard could not match the exact ${target} to live Plex media parts. Ensure the ARR instance and Plex report the same absolute media paths.`;
}

function unsupportedMediaServerReason(
	service: "RADARR" | "SONARR",
	destination: "Emby/Jellyfin" | "Kodi" | "Synology Indexer",
): string {
	return `Skipped for safety: ${serviceLabel(service)} is configured to update ${destination} after deletion, but arr-dashboard cannot verify the exact shared-library media state for that connection.`;
}

function entityDeleteRefreshReason(service: "RADARR" | "SONARR"): string {
	const fileEvent = service === "RADARR" ? "movie-file-delete" : "episode-file-delete";
	return `Skipped for safety: the ${serviceLabel(service)} Plex connection updates on full item deletion but not on ${fileEvent}. Exact-file cleanup cannot preserve that refresh without allowing ARR to delete an unverified replacement file.`;
}

function filelessEntityDeleteRefreshReason(service: "RADARR" | "SONARR"): string {
	return `Skipped for safety: the fileless ${serviceLabel(service)} still triggers a Plex refresh on full item deletion. Without an exact file-delete event, arr-dashboard cannot safely correlate that refresh to owner-visible Plex media.`;
}

function crossInstanceOwnershipReason(service: "RADARR" | "SONARR"): string {
	const serviceName = service === "RADARR" ? "Radarr" : "Sonarr";
	return `Skipped for safety: another configured ${serviceName} instance may access the same storage under a different path. arr-dashboard cannot rule out cross-instance ownership without risking a shared file.`;
}

function normalizeMediaPath(value: unknown): NormalizedMediaPath {
	if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
		throw new FileMatchVerificationError("Media path is missing or invalid");
	}
	const withForwardSlashes = value.trim().replaceAll("\\", "/");
	const unc = withForwardSlashes.startsWith("//");
	const slashed = unc
		? `//${withForwardSlashes.slice(2).replace(/\/+/g, "/")}`
		: withForwardSlashes.replace(/\/+/g, "/");
	const windows = /^[a-zA-Z]:\//.test(slashed);
	if (!windows && !unc && !slashed.startsWith("/")) {
		throw new FileMatchVerificationError("Media path is not absolute");
	}

	let prefix = "";
	let pathWithoutRoot: string;
	if (unc) {
		const uncComponents = slashed.slice(2).split("/");
		if (uncComponents.length < 3 || uncComponents[0] === "" || uncComponents[1] === "") {
			throw new FileMatchVerificationError("UNC media path has no server, share, and child");
		}
		prefix = `//${uncComponents[0]}/${uncComponents[1]}`;
		pathWithoutRoot = uncComponents.slice(2).join("/");
	} else {
		prefix = windows ? slashed.slice(0, 2).toUpperCase() : "";
		pathWithoutRoot = windows ? slashed.slice(3) : slashed.slice(1);
	}

	const components: string[] = [];
	for (const component of pathWithoutRoot.split("/")) {
		if (!component || component === ".") continue;
		if (component === "..") {
			if (components.length === 0) {
				throw new FileMatchVerificationError("Media path escapes its root");
			}
			components.pop();
			continue;
		}
		components.push(component);
	}
	if (components.length === 0) {
		throw new FileMatchVerificationError("Media path does not identify a media location");
	}

	return {
		value: windows || unc ? `${prefix}/${components.join("/")}` : `/${components.join("/")}`,
		windows: windows || unc,
	};
}

function comparablePath(path: NormalizedMediaPath, caseInsensitive: boolean): string {
	return caseInsensitive ? path.value.toLowerCase() : path.value;
}

function pathsEqual(left: NormalizedMediaPath, right: NormalizedMediaPath): boolean {
	if (left.windows !== right.windows) return false;
	return comparablePath(left, left.windows) === comparablePath(right, left.windows);
}

export function assertVerifiedArrTargetUnchanged(
	instance: ServiceInstance,
	externalId: unknown,
	mediaPath: unknown,
	expected: VerifiedArrTargetIdentity,
): void {
	if (
		createArrServiceFingerprint(instance) !== expected.serviceFingerprint ||
		externalId !== expected.externalId ||
		!pathsEqual(normalizeMediaPath(mediaPath), expected.mediaPath)
	) {
		throw new ArrTargetChangedDuringSafetyCheckError();
	}
}

function joinMediaPath(parent: unknown, child: unknown, service: "RADARR" | "SONARR"): string {
	if (typeof parent !== "string" || typeof child !== "string" || child.trim() === "") {
		throw new FileMatchVerificationError(`${serviceLabel(service)} file path is unavailable`);
	}
	return `${parent.replace(/[\\/]+$/, "")}/${child.replace(/^[\\/]+/, "")}`;
}

function radarrFileIdentity(
	movie: Movie,
	movieFile: MovieFile,
	movieFileId: number,
): VerifiedRadarrFileIdentity {
	if (movieFile.id !== movieFileId) {
		throw new FileMatchVerificationError("Radarr movie file identity does not match its movie");
	}
	const size = movieFile.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
		throw new FileMatchVerificationError("Radarr movie file size is unavailable");
	}
	const pathValue =
		typeof movieFile.path === "string" && movieFile.path.trim()
			? movieFile.path
			: joinMediaPath(movie.path, movieFile.relativePath, "RADARR");
	return {
		movieFileId,
		fullPath: normalizeMediaPath(pathValue),
		size,
	};
}

function sonarrEpisodeFileIdentity(
	series: Series,
	episodeFile: EpisodeFile,
): VerifiedSonarrEpisodeFileIdentity {
	const episodeFileId = episodeFile.id;
	if (
		typeof episodeFileId !== "number" ||
		!Number.isSafeInteger(episodeFileId) ||
		episodeFileId <= 0
	) {
		throw new FileMatchVerificationError("Sonarr episode file ID is unavailable");
	}
	const size = episodeFile.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
		throw new FileMatchVerificationError("Sonarr episode file size is unavailable");
	}
	const pathValue =
		typeof episodeFile.path === "string" && episodeFile.path.trim()
			? episodeFile.path
			: joinMediaPath(series.path, episodeFile.relativePath, "SONARR");
	return {
		episodeFileId,
		fullPath: normalizeMediaPath(pathValue),
		size,
	};
}

function comparableFile(identity: VerifiedRadarrFileIdentity): MediaFileIdentity;
function comparableFile(identity: VerifiedSonarrEpisodeFileIdentity): MediaFileIdentity;
function comparableFile(
	identity: VerifiedRadarrFileIdentity | VerifiedSonarrEpisodeFileIdentity,
): MediaFileIdentity {
	return {
		fileId: "movieFileId" in identity ? identity.movieFileId : identity.episodeFileId,
		fullPath: identity.fullPath,
		size: identity.size,
	};
}

export async function assertVerifiedRadarrFileUnchanged(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expectedTarget: VerifiedArrTargetIdentity,
	expected: VerifiedRadarrFileIdentity,
): Promise<void> {
	const currentMovie = await radarr.movie.getById(arrItemId);
	if (
		currentMovie.movieFileId !== expected.movieFileId ||
		currentMovie.tmdbId !== expectedTarget.externalId ||
		!pathsEqual(normalizeMediaPath(currentMovie.path), expectedTarget.mediaPath)
	) {
		throw new RadarrFileChangedDuringSafetyCheckError();
	}
	const currentFile = radarrFileIdentity(
		currentMovie,
		await radarr.movieFile.getById(expected.movieFileId),
		expected.movieFileId,
	);
	if (currentFile.size !== expected.size || !pathsEqual(currentFile.fullPath, expected.fullPath)) {
		throw new RadarrFileChangedDuringSafetyCheckError();
	}
}

export async function assertVerifiedRadarrEmptyUnchanged(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expectedTarget: VerifiedArrTargetIdentity,
): Promise<void> {
	const currentMovie = await radarr.movie.getById(arrItemId);
	if (
		currentMovie.hasFile === true ||
		(typeof currentMovie.movieFileId === "number" && currentMovie.movieFileId > 0) ||
		currentMovie.tmdbId !== expectedTarget.externalId ||
		!pathsEqual(normalizeMediaPath(currentMovie.path), expectedTarget.mediaPath)
	) {
		throw new RadarrFileChangedDuringSafetyCheckError();
	}
}

export async function assertVerifiedSonarrFilesUnchanged(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	expectedTarget: VerifiedArrTargetIdentity,
	expected: VerifiedSonarrFileIdentity,
): Promise<void> {
	const currentSeries = await sonarr.series.getById(arrItemId);
	const currentSeriesPath = normalizeMediaPath(currentSeries.path);
	if (
		currentSeries.tvdbId !== expectedTarget.externalId ||
		!pathsEqual(currentSeriesPath, expectedTarget.mediaPath) ||
		!pathsEqual(currentSeriesPath, expected.seriesPath)
	) {
		throw new SonarrFilesChangedDuringSafetyCheckError();
	}

	const currentFiles = (await sonarr.episodeFile.getBySeries(arrItemId))
		.map((file) => sonarrEpisodeFileIdentity(currentSeries, file))
		.sort((left, right) => left.episodeFileId - right.episodeFileId);
	const expectedFiles = [...expected.episodeFiles].sort(
		(left, right) => left.episodeFileId - right.episodeFileId,
	);
	if (currentFiles.length !== expectedFiles.length) {
		throw new SonarrFilesChangedDuringSafetyCheckError();
	}
	for (let index = 0; index < expectedFiles.length; index++) {
		const current = currentFiles[index]!;
		const wanted = expectedFiles[index]!;
		if (
			current.episodeFileId !== wanted.episodeFileId ||
			current.size !== wanted.size ||
			!pathsEqual(current.fullPath, wanted.fullPath)
		) {
			throw new SonarrFilesChangedDuringSafetyCheckError();
		}
	}
}

export async function assertVerifiedSonarrEpisodeUnchanged(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	plan: Pick<
		Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr_episode" }>,
		"target" | "episode" | "selectedFile" | "retainedTargetFiles"
	>,
	options: {
		monitoredMode?: "exact" | "allow_unmonitored" | "require_unmonitored";
	} = {},
): Promise<void> {
	await assertVerifiedSonarrFilesUnchanged(sonarr, arrItemId, plan.target, {
		seriesPath: plan.target.mediaPath,
		episodeFiles: [plan.selectedFile, ...plan.retainedTargetFiles],
	});
	const episodes = (await sonarr.episode.getAll({
		seriesId: arrItemId,
		includeEpisodeFile: true,
	})) as unknown as Array<Record<string, unknown>>;
	const selected = episodes.find((episode) => episode.id === plan.episode.arrEpisodeId);
	const currentMonitored = typeof selected?.monitored === "boolean" ? selected.monitored : null;
	const monitoredMatches =
		currentMonitored !== null &&
		(options.monitoredMode === "require_unmonitored"
			? currentMonitored === false
			: options.monitoredMode === "allow_unmonitored"
				? currentMonitored === plan.episode.monitored ||
					(plan.episode.monitored === true && currentMonitored === false)
				: currentMonitored === plan.episode.monitored);
	if (
		!selected ||
		selected.seasonNumber !== plan.episode.seasonNumber ||
		selected.episodeNumber !== plan.episode.episodeNumber ||
		selected.episodeFileId !== plan.episode.episodeFileId ||
		!monitoredMatches
	) {
		throw new SonarrFilesChangedDuringSafetyCheckError();
	}
	const consumers = episodes
		.filter((episode) => episode.episodeFileId === plan.episode.episodeFileId)
		.map((episode) => episode.id)
		.filter((id): id is number => typeof id === "number")
		.sort((left, right) => left - right);
	if (
		consumers.length !== plan.episode.episodeFileConsumerIds.length ||
		consumers.some((id, index) => id !== plan.episode.episodeFileConsumerIds[index])
	) {
		throw new SonarrFilesChangedDuringSafetyCheckError();
	}
}

function mediaPartMatchesTarget(
	target: MediaFileIdentity,
	part: { file: string; size: number },
): boolean {
	if (part.size !== target.size) return false;
	const plexPath = normalizeMediaPath(part.file);
	return pathsEqual(plexPath, target.fullPath);
}

function fieldValue(notification: NotificationLike, name: string): unknown {
	return notification.fields?.find((field) => field.name?.toLowerCase() === name.toLowerCase())
		?.value;
}

function booleanField(notification: NotificationLike, name: string, fallback: boolean): boolean {
	const value = fieldValue(notification, name);
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	return fallback;
}

function mappedArrPathForNotification(
	target: MediaFileIdentity,
	notification: NotificationLike,
	service: "RADARR" | "SONARR",
): NormalizedMediaPath {
	return mappedMediaPathForNotification(target.fullPath, notification, service);
}

function mappedMediaPathForNotification(
	fullPath: NormalizedMediaPath,
	notification: NotificationLike,
	service: "RADARR" | "SONARR",
): NormalizedMediaPath {
	const rawMapFrom = fieldValue(notification, "mapFrom");
	const rawMapTo = fieldValue(notification, "mapTo");
	const hasMapFrom = typeof rawMapFrom === "string" && rawMapFrom.trim() !== "";
	const hasMapTo = typeof rawMapTo === "string" && rawMapTo.trim() !== "";
	if (!hasMapFrom && !hasMapTo) return fullPath;
	if (!hasMapFrom || !hasMapTo) {
		throw new FileMatchVerificationError(
			`${serviceLabel(service)} Plex path mapping is incomplete`,
		);
	}

	const mapFrom = normalizeMediaPath(rawMapFrom);
	const mapTo = normalizeMediaPath(rawMapTo);
	if (mapFrom.windows !== fullPath.windows) {
		throw new FileMatchVerificationError(
			`${serviceLabel(service)} Plex source mapping uses a different path type`,
		);
	}
	const caseInsensitive = fullPath.windows;
	const targetPath = comparablePath(fullPath, caseInsensitive);
	const sourceValue = mapFrom.value.replace(/\/+$/, "");
	const sourcePrefix = comparablePath({ ...mapFrom, value: sourceValue }, caseInsensitive);
	if (targetPath !== sourcePrefix && !targetPath.startsWith(`${sourcePrefix}/`)) {
		throw new FileMatchVerificationError(
			`${serviceLabel(service)} path is outside its Plex source mapping`,
		);
	}
	if (targetPath === sourcePrefix) return mapTo;
	const relativePath = fullPath.value.slice(sourceValue.length + 1);
	return normalizeMediaPath(`${mapTo.value.replace(/\/+$/, "")}/${relativePath}`);
}

function matchingPlexItems(
	targets: MediaFileIdentity[],
	items: PlexMovieMediaItem[],
	notification: NotificationLike,
	service: "RADARR" | "SONARR",
): Array<{ item: PlexMovieMediaItem; part: { file: string; size: number } }> {
	return targets.map((target) => {
		const mappedTarget = {
			...target,
			fullPath: mappedArrPathForNotification(target, notification, service),
		};
		const matches = items.flatMap((item) =>
			item.parts
				.filter((part) => mediaPartMatchesTarget(mappedTarget, part))
				.map((part) => ({ item, part })),
		);
		if (matches.length !== 1) {
			throw new FileMatchVerificationError(
				matches.length === 0
					? `No Plex media part matched the ${serviceLabel(service)} file path and size`
					: `Multiple Plex media parts matched the ${serviceLabel(service)} file path and size`,
			);
		}
		return matches[0]!;
	});
}

function plexPartKey(part: { file: string; size: number }): string {
	const path = normalizeMediaPath(part.file);
	return JSON.stringify([path.windows, comparablePath(path, path.windows), part.size]);
}

function matchingPlexSeriesParts(
	targets: MediaFileIdentity[],
	seriesItems: PlexSeriesMediaItem[],
	notification: NotificationLike,
): Array<{
	show: PlexSeriesMediaItem;
	part: { file: string; size: number };
}> {
	const mappedTargets = targets.map((target) => ({
		...target,
		fullPath: mappedArrPathForNotification(target, notification, "SONARR"),
	}));
	const matches: Array<{
		show: PlexSeriesMediaItem;
		part: { file: string; size: number };
	}> = [];

	for (const target of mappedTargets) {
		const physicalMatches = new Map<
			string,
			{ show: PlexSeriesMediaItem; part: { file: string; size: number } }
		>();
		for (const show of seriesItems) {
			for (const episode of show.episodes) {
				for (const part of episode.parts) {
					if (mediaPartMatchesTarget(target, part)) {
						const key = `${show.ratingKey}:${plexPartKey(part)}`;
						physicalMatches.set(key, { show, part });
					}
				}
			}
		}
		if (physicalMatches.size !== 1) {
			throw new FileMatchVerificationError(
				physicalMatches.size === 0
					? "No Plex media part matched the Sonarr episode file path and size"
					: "Multiple Plex show items matched the Sonarr episode file path and size",
			);
		}
		const match = [...physicalMatches.values()][0]!;
		matches.push(match);
	}
	return matches;
}

export function cleanupDeleteTargetKey(
	target: Pick<CleanupDeleteTarget, "instanceId" | "arrItemId" | "itemType"> &
		Partial<Pick<CleanupDeleteTarget, "targetScope" | "arrEpisodeId" | "episodeFileId" | "action">>,
): string {
	const seriesKey = `${target.instanceId}:${target.arrItemId}:${target.itemType}`;
	if (target.targetScope !== "episode") return seriesKey;
	if (target.action === "unmonitor") {
		if (
			typeof target.arrEpisodeId !== "number" ||
			!Number.isSafeInteger(target.arrEpisodeId) ||
			target.arrEpisodeId <= 0
		) {
			throw new Error("Episode-scoped unmonitor target is missing its episode ID");
		}
		return `${seriesKey}:episode:${target.arrEpisodeId}`;
	}
	if (
		typeof target.episodeFileId !== "number" ||
		!Number.isSafeInteger(target.episodeFileId) ||
		target.episodeFileId <= 0
	) {
		throw new Error("File-changing episode target is missing its episode file ID");
	}
	return `${seriesKey}:episode-file:${target.episodeFileId}`;
}

function isDestructiveTarget(target: CleanupDeleteTarget): boolean {
	const action = target.action ?? "delete";
	return (target.itemType === "movie" || target.itemType === "series") && action !== "unmonitor";
}

function isSafetyTarget(target: CleanupDeleteTarget): boolean {
	return target.itemType === "movie" || target.itemType === "series";
}

function notificationIdentityValues(notification: NotificationLike): string[] {
	return [notification.implementation, notification.implementationName, notification.configContract]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim());
}

function mediaServerNotificationKind(
	notification: NotificationLike,
): "plex" | "mediabrowser" | "kodi" | "synology" | null {
	const identities = new Set(
		notificationIdentityValues(notification).map((value) => value.toLowerCase()),
	);
	if (identities.has("plexserver") || identities.has("plexserversettings")) return "plex";
	if (identities.has("mediabrowser") || identities.has("mediabrowsersettings")) {
		return "mediabrowser";
	}
	if (identities.has("xbmc") || identities.has("xbmcsettings")) return "kodi";
	if (identities.has("synologyindexer") || identities.has("synologyindexersettings")) {
		return "synology";
	}
	return null;
}

function notificationMutatesLibrary(notification: NotificationLike): boolean {
	const kind = mediaServerNotificationKind(notification);
	if (kind === "kodi") {
		return (
			booleanField(notification, "updateLibrary", true) ||
			booleanField(notification, "cleanLibrary", true)
		);
	}
	return kind !== null && booleanField(notification, "updateLibrary", true);
}

function unsupportedDestination(
	notification: NotificationLike,
): "Emby/Jellyfin" | "Kodi" | "Synology Indexer" {
	switch (mediaServerNotificationKind(notification)) {
		case "kodi":
			return "Kodi";
		case "synology":
			return "Synology Indexer";
		default:
			return "Emby/Jellyfin";
	}
}

function notificationTagsApply(notification: NotificationLike, tags: number[] | null | undefined) {
	const notificationTags = notification.tags ?? [];
	if (notificationTags.length === 0) return true;
	const entityTags = new Set(tags ?? []);
	return notificationTags.some((tag) => entityTags.has(tag));
}

function radarrNotificationApplies(
	notification: RadarrNotification,
	movie: Movie,
	action: string,
): boolean {
	if (
		(notification as NotificationLike).enable === false ||
		mediaServerNotificationKind(notification) === null ||
		!notificationMutatesLibrary(notification)
	) {
		return false;
	}
	const handlesAction =
		action === "delete_files"
			? notification.onMovieFileDelete === true
			: notification.onMovieDelete === true || notification.onMovieFileDelete === true;
	return handlesAction && notificationTagsApply(notification, movie.tags);
}

function sonarrNotificationApplies(
	notification: SonarrNotification,
	series: Series,
	action: string,
): boolean {
	if (
		(notification as NotificationLike).enable === false ||
		mediaServerNotificationKind(notification) === null ||
		!notificationMutatesLibrary(notification)
	) {
		return false;
	}
	const handlesAction =
		action === "delete_files"
			? notification.onEpisodeFileDelete === true
			: notification.onSeriesDelete === true || notification.onEpisodeFileDelete === true;
	return handlesAction && notificationTagsApply(notification, series.tags);
}

function requiredStringField(notification: NotificationLike, name: string): string {
	const value = fieldValue(notification, name);
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`ARR Plex connection has no usable ${name}`);
	}
	return value.trim();
}

function plexConnectionBaseUrl(notification: NotificationLike): string {
	const hostValue = requiredStringField(notification, "host");
	const useSsl = booleanField(notification, "useSsl", false);
	const rawPort = fieldValue(notification, "port");
	const port =
		typeof rawPort === "number"
			? rawPort
			: typeof rawPort === "string"
				? Number.parseInt(rawPort, 10)
				: 32400;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("ARR Plex connection has an invalid port");
	}
	const rawUrlBase = fieldValue(notification, "urlBase");
	const urlBase =
		typeof rawUrlBase === "string" && rawUrlBase.trim()
			? `/${rawUrlBase.trim().replace(/^\/+|\/+$/g, "")}`
			: "";

	if (/^https?:\/\//i.test(hostValue)) {
		const url = new URL(hostValue);
		if (!url.port) url.port = String(port);
		url.pathname = `${url.pathname.replace(/\/+$/, "")}${urlBase}`;
		return url.toString().replace(/\/$/, "");
	}

	const protocol = useSsl ? "https" : "http";
	return `${protocol}://${hostValue}:${port}${urlBase}`;
}

function normalizedServerUrl(value: string): string | null {
	try {
		const url = new URL(value);
		url.hash = "";
		url.search = "";
		url.hostname = url.hostname.toLowerCase();
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		if (
			(url.protocol === "http:" && url.port === "80") ||
			(url.protocol === "https:" && url.port === "443")
		) {
			url.port = "";
		}
		return url.toString().replace(/\/$/, "");
	} catch {
		return null;
	}
}

function notificationPathMapping(
	notification: NotificationLike,
	label: string,
): { from: NormalizedMediaPath; to: NormalizedMediaPath } | null {
	const rawMapFrom = fieldValue(notification, "mapFrom");
	const rawMapTo = fieldValue(notification, "mapTo");
	const hasMapFrom = typeof rawMapFrom === "string" && rawMapFrom.trim() !== "";
	const hasMapTo = typeof rawMapTo === "string" && rawMapTo.trim() !== "";
	if (hasMapFrom !== hasMapTo) {
		throw new FileMatchVerificationError(`${label} Plex path mapping is incomplete`);
	}
	return hasMapFrom && hasMapTo
		? {
				from: normalizeMediaPath(rawMapFrom),
				to: normalizeMediaPath(rawMapTo),
			}
		: null;
}

function radarrTargetDeleteNotificationWitnesses(
	notifications: RadarrNotification[],
	movie: Movie,
): VerifiedRadarrTargetDeleteNotification[] {
	const witnesses = notifications
		.filter(
			(notification) =>
				radarrNotificationApplies(notification, movie, "delete") &&
				notification.onMovieDelete === true,
		)
		.map((notification) => {
			if (mediaServerNotificationKind(notification) !== "plex") {
				throw new FileMatchVerificationError(
					"Radarr target has an unsupported movie-delete notification",
				);
			}
			const plexServerUrl = normalizedServerUrl(plexConnectionBaseUrl(notification));
			if (!plexServerUrl) {
				throw new FileMatchVerificationError("Radarr target movie-delete Plex URL is invalid");
			}
			return {
				plexServerUrl,
				onMovieFileDelete: notification.onMovieFileDelete === true,
				mapping: notificationPathMapping(notification, "Radarr target"),
			};
		});
	return canonicalRadarrTargetDeleteNotifications(witnesses);
}

function sonarrTargetDeleteNotificationWitnesses(
	notifications: SonarrNotification[],
	series: Series,
	action: string,
	seriesDeleteOnly = false,
): VerifiedSonarrTargetDeleteNotification[] {
	const witnesses = notifications
		.filter(
			(notification) =>
				sonarrNotificationApplies(notification, series, action) &&
				(!seriesDeleteOnly || notification.onSeriesDelete === true),
		)
		.map((notification) => {
			if (mediaServerNotificationKind(notification) !== "plex") {
				throw new FileMatchVerificationError(
					"Sonarr target has an unsupported series-delete notification",
				);
			}
			const plexServerUrl = normalizedServerUrl(plexConnectionBaseUrl(notification));
			if (!plexServerUrl) {
				throw new FileMatchVerificationError("Sonarr target series-delete Plex URL is invalid");
			}
			return {
				plexServerUrl,
				onSeriesDelete: notification.onSeriesDelete === true,
				onEpisodeFileDelete: notification.onEpisodeFileDelete === true,
				mapping: notificationPathMapping(notification, "Sonarr target"),
			};
		});
	return canonicalSonarrTargetDeleteNotifications(witnesses);
}

function plexConnectionFingerprint(instance: ServiceInstance): string {
	return JSON.stringify([
		instance.id,
		normalizedServerUrl(instance.baseUrl),
		instance.encryptedApiKey,
		instance.encryptionIv,
		instance.encryptedHttpAuthCredentials,
		instance.httpAuthEncryptionIv,
		instance.updatedAt instanceof Date ? instance.updatedAt.toISOString() : instance.updatedAt,
	]);
}

async function requirePlexClient(
	deps: CleanupExecutorDeps,
	context: SharedPlexSafetyContext,
	ownerChecks: Map<string, Promise<void>>,
	instance: ServiceInstance,
): Promise<SafetyPlexClient> {
	const fingerprint = plexConnectionFingerprint(instance);
	if (context.failedPlexConnections.has(fingerprint)) {
		throw new Error("Plex media verification already failed during this cleanup run");
	}

	let plex = context.plexClients.get(fingerprint);
	if (!plex) {
		const createdPlex = deps.plexClientFactory
			? deps.plexClientFactory(instance)
			: deps.encryptor
				? createPlexClient(deps.encryptor, instance, deps.log)
				: undefined;
		if (!createdPlex) {
			throw new Error("Live Plex safety verification is unavailable");
		}
		plex = createdPlex;
		context.plexClients.set(fingerprint, plex);
	}

	let ownerCheck = ownerChecks.get(fingerprint);
	if (!ownerCheck) {
		ownerCheck = plex.getAccounts().then(() => undefined);
		ownerChecks.set(fingerprint, ownerCheck);
	}
	try {
		await ownerCheck;
	} catch (error) {
		context.failedPlexConnections.add(fingerprint);
		throw error;
	}
	return plex;
}

interface PlexVerificationInput {
	service: "RADARR" | "SONARR";
	target: CleanupDeleteTarget;
	notifications: PlexNotification[];
	externalId: number;
	files: MediaFileIdentity[];
	/** Files retained on the same Sonarr target during an episode-scoped delete. */
	retainedSonarrTargetFiles?: MediaFileIdentity[];
	radarrPeers?: Array<{
		identity: VerifiedRadarrPeerIdentity;
		movieTags: number[];
		notifications: RadarrNotification[];
	}>;
	radarrUntrackedPeerFiles?: Array<{
		file: VerifiedRadarrFileIdentity;
		movieTags: number[];
		notifications: RadarrNotification[];
	}>;
	sonarrPeers?: Array<{
		identity: VerifiedSonarrPeerIdentity;
		seriesTags: number[];
		notifications: SonarrNotification[];
	}>;
}

interface PlexVerificationResult {
	block?: string;
	ownership: VerifiedRadarrPlexOwnership[];
	sonarrOwnership: VerifiedSonarrPlexOwnership[];
}

function mappedRadarrPeerFileCandidate(
	peer: {
		file: VerifiedRadarrFileIdentity | null;
		movieTags: number[];
		notifications: RadarrNotification[];
	},
	notificationUrl: string,
	requireExplicitPlexCorrelation = false,
): {
	fileId: number;
	fullPath: NormalizedMediaPath;
	size: number;
	mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
} | null {
	if (!peer.file) return null;
	const file = comparableFile(peer.file);
	const serverNotifications: RadarrNotification[] = [];
	for (const notification of peer.notifications) {
		if (mediaServerNotificationKind(notification) !== "plex") continue;
		let peerUrl: string | null = null;
		try {
			peerUrl = normalizedServerUrl(plexConnectionBaseUrl(notification));
		} catch {
			continue;
		}
		if (peerUrl === notificationUrl) serverNotifications.push(notification);
	}
	const matchingNotifications = serverNotifications.filter(
		(notification) =>
			(notification as NotificationLike).enable !== false &&
			notificationMutatesLibrary(notification) &&
			notificationTagsApply(notification, peer.movieTags),
	);
	const unusableConfiguredMapping = serverNotifications.some((notification) => {
		const rawMapFrom = fieldValue(notification, "mapFrom");
		const rawMapTo = fieldValue(notification, "mapTo");
		return (
			!matchingNotifications.includes(notification) &&
			((typeof rawMapFrom === "string" && rawMapFrom.trim() !== "") ||
				(typeof rawMapTo === "string" && rawMapTo.trim() !== ""))
		);
	});
	if (
		matchingNotifications.length === 0 &&
		(requireExplicitPlexCorrelation || unusableConfiguredMapping)
	) {
		throw new FileMatchVerificationError("Radarr peer has only non-applicable Plex path mappings");
	}
	const pathCandidates = new Map<
		string,
		{
			fullPath: NormalizedMediaPath;
			mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
		}
	>();
	if (matchingNotifications.length === 0) {
		pathCandidates.set(JSON.stringify([file.fullPath, null]), {
			fullPath: file.fullPath,
			mapping: null,
		});
	}
	for (const notification of matchingNotifications) {
		const mapping = notificationPathMapping(notification, "Radarr peer");
		const fullPath = mapping
			? mappedArrPathForNotification(file, notification, "RADARR")
			: file.fullPath;
		pathCandidates.set(JSON.stringify([fullPath, mapping]), { fullPath, mapping });
	}
	if (pathCandidates.size !== 1) {
		throw new FileMatchVerificationError("Radarr peer Plex path mappings conflict");
	}
	return { ...file, ...[...pathCandidates.values()][0]! };
}

function matchingPeerPlexPart(
	peer: NonNullable<PlexVerificationInput["radarrPeers"]>[number],
	items: PlexMovieMediaItem[],
	notificationUrl: string,
): {
	item: PlexMovieMediaItem;
	part: { file: string; size: number };
	mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
} | null {
	const pathCandidate = mappedRadarrPeerFileCandidate(
		{ file: peer.identity.file, movieTags: peer.movieTags, notifications: peer.notifications },
		notificationUrl,
	);
	if (!pathCandidate) return null;
	const matches = new Map<
		string,
		{
			item: PlexMovieMediaItem;
			part: { file: string; size: number };
			mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
		}
	>();
	const mappedFile = pathCandidate;
	for (const item of items) {
		for (const part of item.parts) {
			if (mediaPartMatchesTarget(mappedFile, part)) {
				matches.set(`${item.ratingKey}:${plexPartKey(part)}`, {
					item,
					part,
					mapping: pathCandidate.mapping,
				});
			}
		}
	}
	if (matches.size !== 1) {
		throw new FileMatchVerificationError(
			matches.size === 0
				? "No Plex media part matched the retained Radarr peer file"
				: "Multiple Plex media parts matched the retained Radarr peer file",
		);
	}
	return [...matches.values()][0]!;
}

function mappedSonarrPeerFileCandidate(
	files: MediaFileIdentity[],
	seriesTags: number[],
	notifications: SonarrNotification[],
	notificationUrl: string,
): {
	mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
	files: MediaFileIdentity[];
	hasExplicitServerCorrelation: boolean;
} {
	const serverNotifications: SonarrNotification[] = [];
	for (const notification of notifications) {
		if (mediaServerNotificationKind(notification) !== "plex") continue;
		let peerUrl: string | null = null;
		try {
			peerUrl = normalizedServerUrl(plexConnectionBaseUrl(notification));
		} catch {
			continue;
		}
		if (peerUrl === notificationUrl) serverNotifications.push(notification);
	}
	const matchingNotifications = serverNotifications.filter(
		(notification) =>
			(notification as NotificationLike).enable !== false &&
			notificationMutatesLibrary(notification) &&
			notificationTagsApply(notification, seriesTags),
	);
	const unusableConfiguredMapping = serverNotifications.some((notification) => {
		const rawMapFrom = fieldValue(notification, "mapFrom");
		const rawMapTo = fieldValue(notification, "mapTo");
		return (
			!matchingNotifications.includes(notification) &&
			((typeof rawMapFrom === "string" && rawMapFrom.trim() !== "") ||
				(typeof rawMapTo === "string" && rawMapTo.trim() !== ""))
		);
	});
	if (matchingNotifications.length === 0 && unusableConfiguredMapping) {
		throw new FileMatchVerificationError("Sonarr peer has only non-applicable Plex path mappings");
	}

	const pathCandidates = new Map<
		string,
		{
			mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
			files: MediaFileIdentity[];
		}
	>();
	if (matchingNotifications.length === 0) {
		pathCandidates.set(JSON.stringify([null, files.map((file) => file.fullPath)]), {
			mapping: null,
			files,
		});
	}
	for (const notification of matchingNotifications) {
		const mapping = notificationPathMapping(notification, "Sonarr peer");
		const mappedFiles = files.map((file) => ({
			...file,
			fullPath: mapping
				? mappedArrPathForNotification(file, notification, "SONARR")
				: file.fullPath,
		}));
		pathCandidates.set(JSON.stringify([mapping, mappedFiles.map((file) => file.fullPath)]), {
			mapping,
			files: mappedFiles,
		});
	}
	if (pathCandidates.size !== 1) {
		throw new FileMatchVerificationError("Sonarr peer Plex path mappings conflict");
	}
	return {
		...[...pathCandidates.values()][0]!,
		hasExplicitServerCorrelation: matchingNotifications.length > 0,
	};
}

function matchingSonarrPeerPlexParts(
	peer: NonNullable<PlexVerificationInput["sonarrPeers"]>[number],
	items: PlexSeriesMediaItem[],
	notificationUrl: string,
): Array<{
	show: PlexSeriesMediaItem;
	part: { file: string; size: number };
	mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
}> {
	if (!peer.identity.files) return [];
	const pathCandidate = mappedSonarrPeerFileCandidate(
		peer.identity.files.episodeFiles.map(comparableFile),
		peer.seriesTags,
		peer.notifications,
		notificationUrl,
	);

	return pathCandidate.files.map((file) => {
		const matches = new Map<
			string,
			{ show: PlexSeriesMediaItem; part: { file: string; size: number } }
		>();
		for (const show of items) {
			for (const episode of show.episodes) {
				for (const part of episode.parts) {
					if (mediaPartMatchesTarget(file, part)) {
						matches.set(`${show.ratingKey}:${plexPartKey(part)}`, { show, part });
					}
				}
			}
		}
		if (matches.size !== 1) {
			throw new FileMatchVerificationError(
				matches.size === 0
					? "No Plex media part matched a retained Sonarr peer file"
					: "Multiple Plex show items matched a retained Sonarr peer file",
			);
		}
		return { ...[...matches.values()][0]!, mapping: pathCandidate.mapping };
	});
}

function assertVerifiedSonarrTrackedPeerMappingUnchanged(
	peer: VerifiedSonarrPeerIdentity,
	series: Series | null,
	notifications: SonarrNotification[],
	ownership: VerifiedSonarrPlexOwnership[],
): void {
	for (const witness of ownership) {
		const expected = witness.retained
			.filter((part) => part.instanceId === peer.instanceId)
			.map((part) => ({
				fullPath: part.fullPath,
				size: part.size,
				mapping: part.mapping,
			}))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		if (peer.files === null) {
			if (expected.length !== 0) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
			}
			continue;
		}
		if (!series) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		const mappedCandidate = mappedSonarrPeerFileCandidate(
			peer.files.episodeFiles.map(comparableFile),
			series.tags ?? [],
			notifications,
			witness.plexServerUrl,
		);
		if (
			mappedCandidate.files.some((file) =>
				witness.target.some((part) => pathsEqual(file.fullPath, part.fullPath)),
			)
		) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		const current = mappedCandidate.files
			.map((file) => ({
				fullPath: file.fullPath,
				size: file.size,
				mapping: mappedCandidate.mapping,
			}))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		if (JSON.stringify(current) !== JSON.stringify(expected)) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
	}
}

/**
 * A TVDB lookup is not a complete ownership boundary: another Sonarr may have
 * imported the same physical file under a different or missing external ID.
 * Inspect every untracked peer series whose mapped root can contain a target
 * Plex part and fail closed if one of its exact episode files matches.
 */
const SONARR_PEER_FILE_READ_CONCURRENCY = 8;
const RADARR_PEER_FILE_READ_CONCURRENCY = 8;

interface StableRadarrPeerInventory {
	movieCatalog: Movie[];
	notifications: RadarrNotification[];
	filesByMovie: Map<number, VerifiedRadarrFileIdentity | null>;
}

function radarrPeerMovieCatalogWitness(movieCatalog: Movie[]): string {
	return JSON.stringify(
		movieCatalog
			.map((movie) => ({
				id: requiredPositiveSafeInteger(movie.id, "Unverified Radarr peer movie ID"),
				tmdbId:
					movie.tmdbId === undefined || movie.tmdbId === null
						? null
						: requiredPositiveSafeInteger(movie.tmdbId, "Unverified Radarr peer TMDb ID"),
				path: normalizeMediaPath(movie.path),
				hasFile: movie.hasFile === true,
				movieFileId: movie.movieFileId ?? null,
				tags: [...(movie.tags ?? [])].sort((left, right) => left - right),
			}))
			.sort((left, right) => left.id - right.id),
	);
}

function radarrPeerNotificationCatalogWitness(notifications: RadarrNotification[]): string {
	return JSON.stringify(notifications.map((notification) => JSON.stringify(notification)).sort());
}

function radarrPeerFileCatalogWitness(
	filesByMovie: ReadonlyMap<number, VerifiedRadarrFileIdentity | null>,
): string {
	return JSON.stringify(
		[...filesByMovie]
			.map(([movieId, file]) => ({
				movieId,
				file: file
					? [
							file.movieFileId,
							file.fullPath.windows,
							comparablePath(file.fullPath, file.fullPath.windows),
							file.size,
						]
					: null,
			}))
			.sort((left, right) => left.movieId - right.movieId),
	);
}

function radarrPeerInventoriesEqual(
	left: StableRadarrPeerInventory,
	right: StableRadarrPeerInventory,
): boolean {
	return (
		radarrPeerMovieCatalogWitness(left.movieCatalog) ===
			radarrPeerMovieCatalogWitness(right.movieCatalog) &&
		radarrPeerNotificationCatalogWitness(left.notifications) ===
			radarrPeerNotificationCatalogWitness(right.notifications) &&
		radarrPeerFileCatalogWitness(left.filesByMovie) ===
			radarrPeerFileCatalogWitness(right.filesByMovie)
	);
}

function radarrPeerMovieFileId(movie: Movie): number | null {
	const movieFileId = movie.movieFileId;
	if (movie.hasFile === false && typeof movieFileId === "number" && movieFileId > 0) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
	}
	if (movie.hasFile !== false) {
		return requiredPositiveSafeInteger(movieFileId, "Radarr peer movie file ID");
	}
	return null;
}

async function readRadarrPeerFilesByMovie(
	radarr: InstanceType<typeof RadarrClient>,
	movieCatalog: Movie[],
): Promise<Map<number, VerifiedRadarrFileIdentity | null>> {
	const moviesById = new Map<number, Movie>();
	const fileOwners = new Map<number, number>();
	for (const movie of movieCatalog) {
		const movieId = requiredPositiveSafeInteger(movie.id, "Unverified Radarr peer movie ID");
		if (moviesById.has(movieId)) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
		}
		moviesById.set(movieId, movie);
		const movieFileId = radarrPeerMovieFileId(movie);
		if (movieFileId !== null) {
			if (fileOwners.has(movieFileId)) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
			}
			fileOwners.set(movieFileId, movieId);
		}
	}
	const filesByMovie = new Map<number, VerifiedRadarrFileIdentity | null>();
	const movies = [...moviesById.entries()];
	let nextMovieIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(RADARR_PEER_FILE_READ_CONCURRENCY, movies.length) }, async () => {
			while (nextMovieIndex < movies.length) {
				const [movieId, movie] = movies[nextMovieIndex++]!;
				const movieFileId = radarrPeerMovieFileId(movie);
				if (movieFileId === null) {
					filesByMovie.set(movieId, null);
					continue;
				}
				filesByMovie.set(
					movieId,
					radarrFileIdentity(movie, await radarr.movieFile.getById(movieFileId), movieFileId),
				);
			}
		}),
	);
	return filesByMovie;
}

async function readStableRadarrPeerInventory(
	radarr: InstanceType<typeof RadarrClient>,
	initialMovieCatalog?: Movie[],
	initialNotifications?: RadarrNotification[],
): Promise<StableRadarrPeerInventory> {
	const movieCatalog = initialMovieCatalog ?? (await radarr.movie.getAll());
	const notifications = initialNotifications ?? (await radarr.notification.getAll());
	const firstFilesByMovie = await readRadarrPeerFilesByMovie(radarr, movieCatalog);
	const finalFilesByMovie = await readRadarrPeerFilesByMovie(radarr, movieCatalog);
	const [finalMovieCatalog, finalNotifications] = await Promise.all([
		radarr.movie.getAll(),
		radarr.notification.getAll(),
	]);
	if (
		radarrPeerMovieCatalogWitness(finalMovieCatalog) !==
			radarrPeerMovieCatalogWitness(movieCatalog) ||
		radarrPeerNotificationCatalogWitness(finalNotifications) !==
			radarrPeerNotificationCatalogWitness(notifications) ||
		radarrPeerFileCatalogWitness(finalFilesByMovie) !==
			radarrPeerFileCatalogWitness(firstFilesByMovie)
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
	}
	return {
		movieCatalog: finalMovieCatalog,
		notifications: finalNotifications,
		filesByMovie: finalFilesByMovie,
	};
}

function assertVerifiedRadarrPeerIdentityFromInventory(
	peer: VerifiedRadarrPeerIdentity,
	inventory: StableRadarrPeerInventory,
): Movie | null {
	const matchingMovies = inventory.movieCatalog.filter((movie) => movie.tmdbId === peer.externalId);
	if (peer.arrItemId === null) {
		if (matchingMovies.length !== 0) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
		}
		return null;
	}
	const movie = matchingMovies[0];
	if (
		matchingMovies.length !== 1 ||
		!movie ||
		movie.id !== peer.arrItemId ||
		peer.mediaPath === null ||
		!pathsEqual(normalizeMediaPath(movie.path), peer.mediaPath) ||
		JSON.stringify(inventory.filesByMovie.get(peer.arrItemId) ?? null) !== JSON.stringify(peer.file)
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
	}
	return movie;
}

interface StableSonarrPeerInventory {
	seriesCatalog: Series[];
	notifications: SonarrNotification[];
	filesBySeries: Map<number, VerifiedSonarrEpisodeFileIdentity[]>;
}

function sonarrPeerSeriesCatalogWitness(seriesCatalog: Series[]): string {
	return JSON.stringify(
		seriesCatalog
			.map((series) => ({
				id: requiredPositiveSafeInteger(series.id, "Unverified Sonarr peer series ID"),
				tvdbId: series.tvdbId ?? null,
				path: normalizeMediaPath(series.path),
				tags: [...(series.tags ?? [])].sort((left, right) => left - right),
				episodeFileCount: series.statistics?.episodeFileCount ?? null,
				sizeOnDisk: series.statistics?.sizeOnDisk ?? null,
			}))
			.sort((left, right) => left.id - right.id),
	);
}

function sonarrPeerNotificationCatalogWitness(notifications: SonarrNotification[]): string {
	return JSON.stringify(notifications.map((notification) => JSON.stringify(notification)).sort());
}

function sonarrPeerFileCatalogWitness(
	filesBySeries: ReadonlyMap<number, VerifiedSonarrEpisodeFileIdentity[]>,
): string {
	return JSON.stringify(
		[...filesBySeries]
			.map(([seriesId, files]) => ({
				seriesId,
				files: files
					.map((file) => [
						file.episodeFileId,
						file.fullPath.windows,
						comparablePath(file.fullPath, file.fullPath.windows),
						file.size,
					])
					.sort((left, right) => Number(left[0]) - Number(right[0])),
			}))
			.sort((left, right) => left.seriesId - right.seriesId),
	);
}

async function readSonarrPeerFilesBySeries(
	sonarr: InstanceType<typeof SonarrClient>,
	seriesCatalog: Series[],
): Promise<Map<number, VerifiedSonarrEpisodeFileIdentity[]>> {
	const seriesById = new Map<number, Series>();
	for (const series of seriesCatalog) {
		const seriesId = requiredPositiveSafeInteger(series.id, "Unverified Sonarr peer series ID");
		if (seriesById.has(seriesId)) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		seriesById.set(seriesId, series);
	}
	const filesBySeries = new Map<number, VerifiedSonarrEpisodeFileIdentity[]>();
	const allSeries = [...seriesById.entries()];
	let nextSeriesIndex = 0;
	await Promise.all(
		Array.from(
			{
				length: Math.min(SONARR_PEER_FILE_READ_CONCURRENCY, allSeries.length),
			},
			async () => {
				while (nextSeriesIndex < allSeries.length) {
					const [seriesId, series] = allSeries[nextSeriesIndex++]!;
					const files = (await sonarr.episodeFile.getBySeries(seriesId)).map((file) => {
						if (
							requiredPositiveSafeInteger(
								file.seriesId ?? seriesId,
								"Unverified Sonarr episode file series ID",
							) !== seriesId
						) {
							throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
						}
						return sonarrEpisodeFileIdentity(series, file);
					});
					filesBySeries.set(seriesId, files);
				}
			},
		),
	);
	return filesBySeries;
}

async function readStableSonarrPeerInventory(
	sonarr: InstanceType<typeof SonarrClient>,
	initialSeriesCatalog?: Series[],
	initialNotifications?: SonarrNotification[],
): Promise<StableSonarrPeerInventory> {
	const seriesCatalog = initialSeriesCatalog ?? (await sonarr.series.getAll());
	const notifications = initialNotifications ?? (await sonarr.notification.getAll());
	const firstFilesBySeries = await readSonarrPeerFilesBySeries(sonarr, seriesCatalog);
	const finalFilesBySeries = await readSonarrPeerFilesBySeries(sonarr, seriesCatalog);
	const [finalSeriesCatalog, finalNotifications] = await Promise.all([
		sonarr.series.getAll(),
		sonarr.notification.getAll(),
	]);
	if (
		sonarrPeerSeriesCatalogWitness(finalSeriesCatalog) !==
			sonarrPeerSeriesCatalogWitness(seriesCatalog) ||
		sonarrPeerNotificationCatalogWitness(finalNotifications) !==
			sonarrPeerNotificationCatalogWitness(notifications) ||
		sonarrPeerFileCatalogWitness(finalFilesBySeries) !==
			sonarrPeerFileCatalogWitness(firstFilesBySeries)
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
	}
	return {
		seriesCatalog: finalSeriesCatalog,
		notifications: finalNotifications,
		filesBySeries: finalFilesBySeries,
	};
}

function assertNoUnverifiedSonarrPeerOwnsTargetPartsFromInventory(
	trackedSeriesIds: ReadonlySet<number>,
	ownership: VerifiedSonarrPlexOwnership[],
	inventory: StableSonarrPeerInventory,
): void {
	for (const series of inventory.seriesCatalog) {
		const seriesId = requiredPositiveSafeInteger(series.id, "Unverified Sonarr peer series ID");
		if (trackedSeriesIds.has(seriesId)) continue;
		const peerFiles = (inventory.filesBySeries.get(seriesId) ?? []).map(comparableFile);
		for (const witness of ownership) {
			if (peerFiles.length === 0) continue;
			const mappedCandidate = mappedSonarrPeerFileCandidate(
				peerFiles,
				series.tags ?? [],
				inventory.notifications,
				witness.plexServerUrl,
			);
			if (
				!mappedCandidate.hasExplicitServerCorrelation ||
				mappedCandidate.files.some((file) =>
					witness.target.some((part) => pathsEqual(file.fullPath, part.fullPath)),
				)
			) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
			}
		}
	}
}

function assertVerifiedSonarrPeerIdentityFromInventory(
	peer: VerifiedSonarrPeerIdentity,
	inventory: StableSonarrPeerInventory,
): Series | null {
	const matchingSeries = inventory.seriesCatalog.filter(
		(series) => series.tvdbId === peer.externalId,
	);
	if (peer.arrItemId === null) {
		if (matchingSeries.length !== 0) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		return null;
	}
	const series = matchingSeries[0];
	if (
		matchingSeries.length !== 1 ||
		!series ||
		series.id !== peer.arrItemId ||
		peer.mediaPath === null ||
		peer.files === null ||
		!pathsEqual(normalizeMediaPath(series.path), peer.mediaPath) ||
		sonarrPeerFileCatalogWitness(
			new Map([[peer.arrItemId, inventory.filesBySeries.get(peer.arrItemId) ?? []]]),
		) !== sonarrPeerFileCatalogWitness(new Map([[peer.arrItemId, peer.files.episodeFiles]]))
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
	}
	return series;
}

export async function assertVerifiedSonarrPeerInventoryUnchanged(
	sonarr: InstanceType<typeof SonarrClient>,
	peer: VerifiedSonarrPeerIdentity,
	ownership: VerifiedSonarrPlexOwnership[],
	seriesCatalog?: Series[],
	notifications?: SonarrNotification[],
): Promise<{ series: Series | null; notifications: SonarrNotification[] }> {
	try {
		const inventory = await readStableSonarrPeerInventory(sonarr, seriesCatalog, notifications);
		const series = assertVerifiedSonarrPeerIdentityFromInventory(peer, inventory);
		assertVerifiedSonarrTrackedPeerMappingUnchanged(
			peer,
			series,
			inventory.notifications,
			ownership,
		);
		assertNoUnverifiedSonarrPeerOwnsTargetPartsFromInventory(
			new Set(peer.arrItemId === null ? [] : [peer.arrItemId]),
			ownership,
			inventory,
		);
		return { series, notifications: inventory.notifications };
	} catch (error) {
		if (error instanceof ArrCrossInstanceOwnershipChangedDuringSafetyCheckError) throw error;
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
	}
}

async function verifyPlexMediaState(
	deps: CleanupExecutorDeps,
	context: SharedPlexSafetyContext,
	ownerChecks: Map<string, Promise<void>>,
	plexInstances: ServiceInstance[],
	movieLookups: Map<SafetyPlexClient, Map<number, Promise<PlexMovieMediaItem[]>>>,
	seriesLookups: Map<SafetyPlexClient, Map<number, Promise<PlexSeriesMediaItem[]>>>,
	input: PlexVerificationInput,
): Promise<PlexVerificationResult> {
	const ownership: VerifiedRadarrPlexOwnership[] = [];
	const sonarrOwnership: VerifiedSonarrPlexOwnership[] = [];
	if (input.files.length === 0) return { ownership, sonarrOwnership };

	for (const notification of input.notifications) {
		const notificationUrl = normalizedServerUrl(plexConnectionBaseUrl(notification));
		const matchingPlexInstances = plexInstances.filter(
			(instance) => normalizedServerUrl(instance.baseUrl) === notificationUrl,
		);
		if (!notificationUrl || matchingPlexInstances.length === 0) {
			throw new Error(
				`${serviceLabel(input.service)} Plex connection does not match a configured arr-dashboard Plex instance`,
			);
		}

		let verifiedMediaState = false;
		for (const plexInstance of matchingPlexInstances) {
			let plex: SafetyPlexClient;
			try {
				plex = await requirePlexClient(deps, context, ownerChecks, plexInstance);
			} catch (error) {
				deps.log.warn(
					{ err: getErrorMessage(error), plexInstanceId: plexInstance.id },
					"Cleanup Plex credential could not verify owner access",
				);
				continue;
			}

			try {
				if (input.service === "RADARR") {
					let clientLookups = movieLookups.get(plex);
					if (!clientLookups) {
						clientLookups = new Map();
						movieLookups.set(plex, clientLookups);
					}
					let mediaPartsPromise = clientLookups.get(input.externalId);
					if (!mediaPartsPromise) {
						mediaPartsPromise = plex.getMovieMediaPartsByTmdbId(input.externalId);
						clientLookups.set(input.externalId, mediaPartsPromise);
					}
					const mediaItems = await mediaPartsPromise;
					const targetMatches = matchingPlexItems(
						input.files,
						mediaItems,
						notification,
						input.service,
					);
					for (const targetMatch of targetMatches) {
						for (const peer of input.radarrUntrackedPeerFiles ?? []) {
							const candidate = mappedRadarrPeerFileCandidate(peer, notificationUrl, true);
							if (
								candidate &&
								candidate.size === targetMatch.part.size &&
								pathsEqual(candidate.fullPath, normalizeMediaPath(targetMatch.part.file))
							) {
								return {
									block: crossInstanceOwnershipReason("RADARR"),
									ownership,
									sonarrOwnership,
								};
							}
						}
						const targetPartKey = plexPartKey(targetMatch.part);
						const retainedPartKeys = new Set<string>();
						const retained: VerifiedRadarrPlexOwnership["retained"] = [];
						if (input.radarrPeers?.length && notificationUrl) {
							for (const peer of input.radarrPeers) {
								const peerMatch = matchingPeerPlexPart(peer, mediaItems, notificationUrl);
								if (!peerMatch) continue;
								const peerPartKey = plexPartKey(peerMatch.part);
								if (peerPartKey === targetPartKey) {
									return {
										block: crossInstanceOwnershipReason("RADARR"),
										ownership,
										sonarrOwnership,
									};
								}
								retained.push({
									instanceId: peer.identity.instanceId,
									ratingKey: peerMatch.item.ratingKey,
									fullPath: normalizeMediaPath(peerMatch.part.file),
									size: peerMatch.part.size,
									mapping: peerMatch.mapping,
								});
								if (peerMatch.item.ratingKey === targetMatch.item.ratingKey) {
									if (retainedPartKeys.has(peerPartKey)) {
										return { block: mergedItemReason(input.service), ownership, sonarrOwnership };
									}
									retainedPartKeys.add(peerPartKey);
								}
							}
						}
						if (notificationUrl) {
							ownership.push({
								plexServerUrl: notificationUrl,
								target: {
									ratingKey: targetMatch.item.ratingKey,
									fullPath: normalizeMediaPath(targetMatch.part.file),
									size: targetMatch.part.size,
								},
								retained,
							});
						}
						if (targetMatch.item.parts.length <= 1) continue;
						if (!input.radarrPeers?.length || !notificationUrl) {
							return { block: mergedItemReason(input.service), ownership, sonarrOwnership };
						}
						const unownedParts = targetMatch.item.parts.filter((part) => {
							const partKey = plexPartKey(part);
							return partKey !== targetPartKey && !retainedPartKeys.has(partKey);
						});
						if (retainedPartKeys.size === 0 || unownedParts.length > 0) {
							return { block: mergedItemReason(input.service), ownership, sonarrOwnership };
						}
					}
				} else {
					let clientLookups = seriesLookups.get(plex);
					if (!clientLookups) {
						clientLookups = new Map();
						seriesLookups.set(plex, clientLookups);
					}
					let mediaPartsPromise = clientLookups.get(input.externalId);
					if (!mediaPartsPromise) {
						mediaPartsPromise = plex.getSeriesEpisodeMediaPartsByTvdbId(input.externalId);
						clientLookups.set(input.externalId, mediaPartsPromise);
					}
					const mediaItems = await mediaPartsPromise;
					const targetMatches = matchingPlexSeriesParts(input.files, mediaItems, notification);
					const retainedTargetMatches = input.retainedSonarrTargetFiles
						? matchingPlexSeriesParts(input.retainedSonarrTargetFiles, mediaItems, notification)
						: [];
					const targetPhysicalKeys = new Set(
						targetMatches.map((match) => `${match.show.ratingKey}:${plexPartKey(match.part)}`),
					);
					if (targetPhysicalKeys.size !== targetMatches.length) {
						throw new FileMatchVerificationError(
							"Multiple Sonarr episode files matched the same Plex media part",
						);
					}
					const targetPartKeys = new Set(targetMatches.map((match) => plexPartKey(match.part)));
					const retainedMatches: Array<{
						instanceId: string;
						show: PlexSeriesMediaItem;
						part: { file: string; size: number };
						mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
					}> = [];
					const retainedPartOwners = new Map<string, string>();
					for (const peer of input.sonarrPeers ?? []) {
						for (const match of matchingSonarrPeerPlexParts(peer, mediaItems, notificationUrl)) {
							const partKey = plexPartKey(match.part);
							if (targetPartKeys.has(partKey)) {
								return {
									block: crossInstanceOwnershipReason("SONARR"),
									ownership,
									sonarrOwnership,
								};
							}
							const existingOwner = retainedPartOwners.get(partKey);
							if (existingOwner) {
								if (existingOwner !== peer.identity.instanceId) {
									return {
										block: crossInstanceOwnershipReason("SONARR"),
										ownership,
										sonarrOwnership,
									};
								}
								throw new FileMatchVerificationError(
									"Multiple Sonarr peer files matched the same Plex media part",
								);
							}
							retainedPartOwners.set(partKey, peer.identity.instanceId);
							retainedMatches.push({
								instanceId: peer.identity.instanceId,
								...match,
							});
						}
					}
					if (notificationUrl) {
						sonarrOwnership.push({
							plexServerUrl: notificationUrl,
							target: targetMatches.map((match) => ({
								ratingKey: match.show.ratingKey,
								fullPath: normalizeMediaPath(match.part.file),
								size: match.part.size,
							})),
							retained: retainedMatches.map((match) => ({
								instanceId: match.instanceId,
								ratingKey: match.show.ratingKey,
								fullPath: normalizeMediaPath(match.part.file),
								size: match.part.size,
								mapping: match.mapping,
							})),
						});
					}
					const allowedPartKeys = new Set([
						...targetMatches.map((match) => `${match.show.ratingKey}:${plexPartKey(match.part)}`),
						...retainedTargetMatches.map(
							(match) => `${match.show.ratingKey}:${plexPartKey(match.part)}`,
						),
						...retainedMatches.map((match) => `${match.show.ratingKey}:${plexPartKey(match.part)}`),
					]);
					for (const show of mediaItems) {
						const showPartKeys = new Set(
							show.episodes.flatMap((episode) => episode.parts.map(plexPartKey)),
						);
						if (
							[...showPartKeys].some(
								(partKey) => !allowedPartKeys.has(`${show.ratingKey}:${partKey}`),
							)
						) {
							return { block: mergedItemReason(input.service), ownership, sonarrOwnership };
						}
					}
				}
			} catch (error) {
				if (error instanceof FileMatchVerificationError) throw error;
				deps.log.warn(
					{
						err: getErrorMessage(error),
						plexInstanceId: plexInstance.id,
						arrItemId: input.target.arrItemId,
					},
					"Cleanup owner Plex credential could not verify media state",
				);
				context.failedPlexConnections.add(plexConnectionFingerprint(plexInstance));
				throw new Error("Owner-visible Plex media state could not be verified");
			}
			verifiedMediaState = true;
		}
		if (!verifiedMediaState) {
			throw new Error("No matching Plex credential could verify owner-visible media state");
		}
	}
	return { ownership, sonarrOwnership };
}

async function verifyEpisodePlexWatchProof(
	deps: CleanupExecutorDeps,
	context: SharedPlexSafetyContext,
	ownerChecks: Map<string, Promise<void>>,
	plexInstances: ServiceInstance[],
	seriesLookups: Map<SafetyPlexClient, Map<number, Promise<PlexSeriesMediaItem[]>>>,
	target: CleanupDeleteTarget,
	series: Series,
	tvdbId: number,
	selectedFile: VerifiedSonarrEpisodeFileIdentity,
	notifications: SonarrNotification[],
): Promise<{
	proof: VerifiedEpisodePlexWatchProof;
	liveWatchSources: VerifiedEpisodePlexWatchSource[];
}> {
	if (!target.plexWatchEvidence?.length) {
		throw new EpisodeWatchProofError("No Plex episode watch evidence was carried to safety");
	}
	const showTmdbId = requiredPositiveSafeInteger(series.tmdbId, "Sonarr series TMDb ID");
	const seasonNumber = target.seasonNumber;
	const episodeNumber = target.episodeNumber;
	if (typeof seasonNumber !== "number" || !Number.isSafeInteger(seasonNumber) || seasonNumber < 0) {
		throw new EpisodeWatchProofError("Sonarr episode season coordinate is invalid");
	}
	const exactEpisodeNumber = requiredPositiveSafeInteger(episodeNumber, "Sonarr episode number");
	const selectedComparable = comparableFile(selectedFile);
	const enabledPlexInstances = plexInstances.filter(
		(instance) => instance.service === "PLEX" && instance.enabled === true,
	);
	const policyRows = await deps.prisma.plexEpisodeCache.findMany({
		where: {
			instanceId: { in: enabledPlexInstances.map((instance) => instance.id) },
			showTmdbId,
			seasonNumber,
			episodeNumber: exactEpisodeNumber,
		},
		select: {
			instanceId: true,
			ratingKey: true,
			watchCount: true,
			refreshedAt: true,
			sourceFingerprint: true,
		},
	});
	if (policyRows.length === 0) {
		throw new EpisodeWatchProofError(
			"No complete Plex episode policy evidence was available at the mutation boundary",
		);
	}
	const deletesFile = target.action === "delete" || target.action === "delete_files";
	const verifiedPolicySources = new Map<
		string,
		{
			source: VerifiedEpisodePlexWatchSource;
			sourceFingerprint: string;
			serverUrl: string;
			match: {
				part: { file: string; size: number };
				mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
			};
		}
	>();
	for (const row of policyRows) {
		const plexInstance = enabledPlexInstances.find((instance) => instance.id === row.instanceId);
		const sourceFingerprint = plexInstance ? plexEvidenceSourceFingerprint(plexInstance) : null;
		const sourceUpdatedAt = plexInstance?.updatedAt.getTime();
		if (
			!plexInstance ||
			typeof sourceFingerprint !== "string" ||
			typeof row.ratingKey !== "string" ||
			row.ratingKey.trim().length === 0 ||
			row.watchCount === null ||
			row.refreshedAt === null ||
			row.sourceFingerprint !== sourceFingerprint ||
			!Number.isFinite(sourceUpdatedAt) ||
			row.refreshedAt.getTime() > Date.now() ||
			row.refreshedAt.getTime() < Date.now() - 24 * 60 * 60 * 1000 ||
			row.refreshedAt.getTime() < sourceUpdatedAt!
		) {
			continue;
		}
		let plex: SafetyPlexClient;
		try {
			plex = await requirePlexClient(deps, context, ownerChecks, plexInstance);
		} catch {
			throw new EpisodeWatchProofError(
				"Plex episode policy source was unavailable at the mutation boundary",
			);
		}
		if (!plex.getEpisodeWatchCount) {
			throw new EpisodeWatchProofError(
				"Plex episode policy watch counts were unavailable at the mutation boundary",
			);
		}
		let liveWatchCount: number;
		try {
			liveWatchCount = await plex.getEpisodeWatchCount(row.ratingKey);
		} catch {
			throw new EpisodeWatchProofError(
				"Plex episode policy watch counts were unavailable at the mutation boundary",
			);
		}
		if (!Number.isSafeInteger(liveWatchCount) || liveWatchCount < 0) {
			throw new EpisodeWatchProofError(
				"Plex returned an invalid episode policy watch count at the mutation boundary",
			);
		}
		const serverUrl = normalizedServerUrl(plexInstance.baseUrl);
		if (!serverUrl) {
			throw new EpisodeWatchProofError(
				"Plex episode policy source was invalid at the mutation boundary",
			);
		}
		let clientLookups = seriesLookups.get(plex);
		if (!clientLookups) {
			clientLookups = new Map();
			seriesLookups.set(plex, clientLookups);
		}
		let mediaPartsPromise = clientLookups.get(tvdbId);
		if (!mediaPartsPromise) {
			mediaPartsPromise = plex.getSeriesEpisodeMediaPartsByTvdbId(tvdbId);
			clientLookups.set(tvdbId, mediaPartsPromise);
		}
		let mediaItems: PlexSeriesMediaItem[];
		try {
			mediaItems = await mediaPartsPromise;
		} catch {
			throw new EpisodeWatchProofError(
				"Plex episode policy media paths were unavailable at the mutation boundary",
			);
		}
		const allMediaEpisodes = mediaItems.flatMap((show) => show.episodes);
		const hasEpisodeCoordinates = allMediaEpisodes.some(
			(episode) => episode.seasonNumber !== undefined || episode.episodeNumber !== undefined,
		);
		const sourceEpisodes = allMediaEpisodes.filter(
			(episode) =>
				episode.ratingKey === row.ratingKey &&
				(!hasEpisodeCoordinates ||
					(episode.seasonNumber === seasonNumber && episode.episodeNumber === exactEpisodeNumber)),
		);
		if (sourceEpisodes.length === 0) continue;
		if (sourceEpisodes.length > 1) {
			throw new EpisodeWatchProofError(
				"Plex episode policy media identity was ambiguous at the mutation boundary",
			);
		}
		const pathEpisodes = hasEpisodeCoordinates
			? allMediaEpisodes.filter(
					(episode) =>
						episode.seasonNumber === seasonNumber && episode.episodeNumber === exactEpisodeNumber,
				)
			: sourceEpisodes;
		if (pathEpisodes.length === 0) continue;
		const matchingNotifications = notifications.filter((notification) => {
			if (
				mediaServerNotificationKind(notification) !== "plex" ||
				(notification as NotificationLike).enable === false ||
				(deletesFile &&
					(notification.onEpisodeFileDelete !== true ||
						!sonarrNotificationApplies(notification, series, target.action ?? "delete")))
			) {
				return false;
			}
			try {
				return (
					normalizedServerUrl(plexConnectionBaseUrl(notification)) === serverUrl &&
					notificationTagsApply(notification, series.tags)
				);
			} catch {
				return false;
			}
		});
		let pathCandidates: Array<{
			fullPath: NormalizedMediaPath;
			mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
		}>;
		try {
			pathCandidates =
				!deletesFile && matchingNotifications.length === 0
					? [{ fullPath: selectedComparable.fullPath, mapping: null }]
					: matchingNotifications.map((notification) => ({
							fullPath: mappedArrPathForNotification(selectedComparable, notification, "SONARR"),
							mapping: notificationPathMapping(notification, "Sonarr target"),
						}));
		} catch {
			throw new EpisodeWatchProofError(
				"Plex episode policy media path mapping was invalid at the mutation boundary",
			);
		}
		const matches = new Map<
			string,
			{
				part: { file: string; size: number };
				mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
			}
		>();
		for (const candidate of pathCandidates) {
			const mappedFile = { ...selectedComparable, fullPath: candidate.fullPath };
			for (const episode of pathEpisodes) {
				for (const part of episode.parts) {
					if (mediaPartMatchesTarget(mappedFile, part)) {
						matches.set(plexPartKey(part), { part, mapping: candidate.mapping });
					}
				}
			}
		}
		if (matches.size > 1) {
			throw new EpisodeWatchProofError(
				"Plex episode policy media path was ambiguous at the mutation boundary",
			);
		}
		if (matches.size === 1) {
			verifiedPolicySources.set(`${row.instanceId}:${row.ratingKey}`, {
				source: { plexInstanceId: row.instanceId, ratingKey: row.ratingKey, liveWatchCount },
				sourceFingerprint,
				serverUrl,
				match: [...matches.values()][0]!,
			});
		}
	}
	for (const evidence of target.plexWatchEvidence) {
		const approvedRefreshedAt =
			evidence.refreshedAt instanceof Date ? evidence.refreshedAt : new Date(evidence.refreshedAt);
		if (!Number.isFinite(approvedRefreshedAt.getTime())) continue;
		const plexInstance = plexInstances.find(
			(instance) =>
				instance.id === evidence.plexInstanceId &&
				instance.service === "PLEX" &&
				instance.enabled === true,
		);
		if (!plexInstance) continue;
		const plexUpdatedAt = plexInstance.updatedAt.getTime();
		const currentPlexFingerprint = plexEvidenceSourceFingerprint(plexInstance);
		if (evidence.sourceFingerprint !== currentPlexFingerprint) continue;
		if (
			!Number.isFinite(plexUpdatedAt) ||
			approvedRefreshedAt.getTime() > Date.now() ||
			approvedRefreshedAt.getTime() < plexUpdatedAt
		) {
			continue;
		}
		const currentEvidence = await deps.prisma.plexEpisodeCache.findFirst({
			where: {
				instanceId: plexInstance.id,
				showTmdbId,
				seasonNumber,
				episodeNumber: exactEpisodeNumber,
				ratingKey: evidence.ratingKey,
			},
			select: { watchCount: true, refreshedAt: true, sourceFingerprint: true },
		});
		if (
			!currentEvidence ||
			currentEvidence.watchCount === null ||
			currentEvidence.refreshedAt === null ||
			currentEvidence.sourceFingerprint !== currentPlexFingerprint ||
			currentEvidence.watchCount < evidence.watchCount ||
			currentEvidence.refreshedAt.getTime() > Date.now() ||
			currentEvidence.refreshedAt.getTime() < Date.now() - 24 * 60 * 60 * 1000 ||
			currentEvidence.refreshedAt.getTime() < plexUpdatedAt
		) {
			continue;
		}
		const verifiedSource = verifiedPolicySources.get(`${plexInstance.id}:${evidence.ratingKey}`);
		if (
			!verifiedSource ||
			verifiedSource.sourceFingerprint !== currentPlexFingerprint ||
			verifiedSource.source.liveWatchCount <= 0 ||
			verifiedSource.source.liveWatchCount < evidence.watchCount
		) {
			continue;
		}
		const match = verifiedSource.match;
		return {
			proof: {
				plexInstanceId: plexInstance.id,
				sourceFingerprint: currentPlexFingerprint,
				plexServerUrl: verifiedSource.serverUrl,
				ratingKey: evidence.ratingKey,
				watchCount: Math.min(currentEvidence.watchCount, verifiedSource.source.liveWatchCount),
				refreshedAt: currentEvidence.refreshedAt.toISOString(),
				fullPath: normalizeMediaPath(match.part.file),
				size: match.part.size,
				mapping: match.mapping,
			},
			liveWatchSources: [...verifiedPolicySources.values()].map(({ source }) => source),
		};
	}
	throw new EpisodeWatchProofError(
		"No watched Plex episode media part mapped to the selected Sonarr episode file",
	);
}

async function verifyFreshEpisodeQuiState(
	deps: CleanupExecutorDeps,
	context: SharedPlexSafetyContext,
	userId: string,
	filePath: string,
	options: { refresh?: boolean } = {},
): Promise<void> {
	let quiInstances: ServiceInstance[];
	if (options.refresh) {
		quiInstances = await deps.prisma.serviceInstance.findMany({
			where: { userId, service: "QUI", enabled: true },
		});
	} else {
		context.quiInstances ??= deps.prisma.serviceInstance.findMany({
			where: { userId, service: "QUI", enabled: true },
		});
		quiInstances = await context.quiInstances;
	}
	if (quiInstances.length === 0) return;
	if (!deps.quiClientFactory || !deps.quiFileHashIndexFactory) {
		throw new FileMatchVerificationError(
			"Target Sonarr episode qUI state could not be verified live",
		);
	}
	const hashes = new Set<string>();
	for (const instance of quiInstances) {
		if (instance.hasLocalFilesystemAccess !== true) {
			throw new FileMatchVerificationError(
				"Target Sonarr episode qUI state could not be verified live",
			);
		}
		let index = options.refresh ? undefined : context.quiFileIndexes.get(instance.id);
		if (!index) {
			index = deps.quiFileHashIndexFactory(instance);
			if (!options.refresh) context.quiFileIndexes.set(instance.id, index);
		}
		try {
			const resolution = await (await index).resolve(filePath);
			if (resolution.complete !== true) throw new Error("Incomplete qUI inode resolution");
			for (const hash of resolution.hashes) hashes.add(hash.toLowerCase());
		} catch {
			throw new FileMatchVerificationError(
				"Target Sonarr episode qUI state could not be verified live",
			);
		}
	}
	if (hashes.size === 0) return;
	for (const hash of hashes) {
		for (const instance of quiInstances) {
			const cacheKey = `${instance.id}\0${hash}`;
			let torrents = options.refresh ? undefined : context.quiHashTorrents.get(cacheKey);
			if (!torrents) {
				torrents = deps.quiClientFactory(instance).getTorrentsByHash(hash);
				if (!options.refresh) context.quiHashTorrents.set(cacheKey, torrents);
			}
			let exactResults: Awaited<typeof torrents>;
			try {
				exactResults = await torrents;
			} catch {
				throw new FileMatchVerificationError(
					"Target Sonarr episode qUI state could not be verified live",
				);
			}
			if (
				exactResults.some((torrent) =>
					isQuiSeedingTorrentState(normalizeTorrentState(torrent.state)),
				)
			) {
				throw new FileMatchVerificationError(
					"Target Sonarr episode is actively seeding or downloading in qUI",
				);
			}
		}
	}
}

/**
 * Fail-closed preflight for shared Plex library deletions initiated through
 * either Radarr or Sonarr. The live ARR file set is correlated to exact Plex
 * media parts after applying the target ARR connection's path mapping. A
 * shared Radarr movies and Sonarr shows are allowed only when every retained
 * Plex part is backed by an exact peer ARR file and every configured peer is
 * snapshotted.
 */
export async function findSharedPlexDeleteBlocks(
	deps: CleanupExecutorDeps,
	userId: string,
	targets: CleanupDeleteTarget[],
	context: SharedPlexSafetyContext = createSharedPlexSafetyContext(),
): Promise<Map<string, string>> {
	const safetyTargets = targets.filter(isSafetyTarget);
	const deleteTargets = targets.filter(isDestructiveTarget);
	const blocks = new Map<string, string>();
	if (safetyTargets.length === 0) return blocks;

	let instances: ServiceInstance[];
	let plexInstances: ServiceInstance[];
	try {
		instances = await deps.prisma.serviceInstance.findMany({
			where: {
				userId,
				service: { in: ["RADARR", "SONARR"] },
			},
		});
		plexInstances =
			deleteTargets.length === 0 &&
			!safetyTargets.some((target) => target.targetScope === "episode")
				? []
				: await deps.prisma.serviceInstance.findMany({
						where: { userId, service: "PLEX" },
					});
	} catch (error) {
		deps.log.warn(
			{ err: getErrorMessage(error) },
			"Cleanup shared-Plex safety check could not load ARR instances",
		);
		for (const target of safetyTargets) {
			const targetKey = cleanupDeleteTargetKey(target);
			const service = target.itemType === "series" ? "SONARR" : "RADARR";
			const reason = verificationFailedReason(service);
			blocks.set(targetKey, reason);
			context.plans.set(targetKey, { kind: "blocked", reason });
		}
		return blocks;
	}

	const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
	const radarrClients = new Map<string, InstanceType<typeof RadarrClient>>();
	const sonarrClients = new Map<string, InstanceType<typeof SonarrClient>>();
	const radarrNotifications = new Map<string, Promise<RadarrNotification[]>>();
	const radarrPeerInventories = new Map<string, Promise<StableRadarrPeerInventory>>();
	const sonarrSeries = new Map<string, Promise<Series[]>>();
	const sonarrNotifications = new Map<string, Promise<SonarrNotification[]>>();
	const plexOwnerChecks = new Map<string, Promise<void>>();
	const plexMovieLookups = new Map<SafetyPlexClient, Map<number, Promise<PlexMovieMediaItem[]>>>();
	const plexSeriesLookups = new Map<
		SafetyPlexClient,
		Map<number, Promise<PlexSeriesMediaItem[]>>
	>();
	const pendingSonarrPlans: Array<{
		target: CleanupDeleteTarget;
		targetKey: string;
		client: InstanceType<typeof SonarrClient>;
		action: string;
		targetIdentity: VerifiedArrTargetIdentity;
		verifiedFiles: VerifiedSonarrFileIdentity;
		peers: NonNullable<PlexVerificationInput["sonarrPeers"]>;
		peerCatalogs: Array<{
			client: InstanceType<typeof SonarrClient>;
			peer: VerifiedSonarrPeerIdentity;
		}>;
		ownership: VerifiedSonarrPlexOwnership[];
		targetDeleteNotifications: VerifiedSonarrTargetDeleteNotification[];
		episodePlan?: {
			episode: VerifiedSonarrEpisodeIdentity;
			selectedFile: VerifiedSonarrEpisodeFileIdentity;
			retainedTargetFiles: VerifiedSonarrEpisodeFileIdentity[];
			watchProof: VerifiedEpisodePlexWatchProof;
			quiIdentity: VerifiedEpisodeQuiIdentity;
		};
	}> = [];
	const pendingRadarrPlans: Array<{
		target: CleanupDeleteTarget;
		targetKey: string;
		client: InstanceType<typeof RadarrClient>;
		targetIdentity: VerifiedArrTargetIdentity;
		targetFile: VerifiedRadarrFileIdentity;
		peers: NonNullable<PlexVerificationInput["radarrPeers"]>;
		peerCatalogs: Array<{
			instanceId: string;
			serviceFingerprint: string;
			client: InstanceType<typeof RadarrClient>;
			inventory: StableRadarrPeerInventory;
		}>;
		ownership: VerifiedRadarrPlexOwnership[];
		targetDeleteNotifications: VerifiedRadarrTargetDeleteNotification[];
	}> = [];

	const getRadarrClient = (instance: ServiceInstance): InstanceType<typeof RadarrClient> => {
		let client = radarrClients.get(instance.id);
		if (!client) {
			client = deps.arrClientFactory.create(instance) as InstanceType<typeof RadarrClient>;
			radarrClients.set(instance.id, client);
		}
		return client;
	};

	const getSonarrClient = (instance: ServiceInstance): InstanceType<typeof SonarrClient> => {
		let client = sonarrClients.get(instance.id);
		if (!client) {
			client = deps.arrClientFactory.create(instance) as InstanceType<typeof SonarrClient>;
			sonarrClients.set(instance.id, client);
		}
		return client;
	};

	const getRadarrNotifications = (
		instance: ServiceInstance,
		client: InstanceType<typeof RadarrClient>,
	): Promise<RadarrNotification[]> => {
		let notifications = radarrNotifications.get(instance.id);
		if (!notifications) {
			notifications = client.notification.getAll();
			radarrNotifications.set(instance.id, notifications);
		}
		return notifications;
	};

	const getRadarrPeerInventory = (
		instance: ServiceInstance,
		client: InstanceType<typeof RadarrClient>,
	): Promise<StableRadarrPeerInventory> => {
		let inventory = radarrPeerInventories.get(instance.id);
		if (!inventory) {
			inventory = readStableRadarrPeerInventory(client);
			radarrPeerInventories.set(instance.id, inventory);
		}
		return inventory;
	};

	const getSonarrNotifications = (
		instance: ServiceInstance,
		client: InstanceType<typeof SonarrClient>,
	): Promise<SonarrNotification[]> => {
		let notifications = sonarrNotifications.get(instance.id);
		if (!notifications) {
			notifications = client.notification.getAll();
			sonarrNotifications.set(instance.id, notifications);
		}
		return notifications;
	};

	const getSonarrSeries = (
		instance: ServiceInstance,
		client: InstanceType<typeof SonarrClient>,
	): Promise<Series[]> => {
		let series = sonarrSeries.get(instance.id);
		if (!series) {
			series = client.series.getAll();
			sonarrSeries.set(instance.id, series);
		}
		return series;
	};

	const otherInstanceMayOwnFile = (
		instance: ServiceInstance,
		service: "RADARR" | "SONARR",
		targetFileCount: number,
	): boolean => {
		if (targetFileCount === 0) return false;
		return instances.some(
			(otherInstance) => otherInstance.id !== instance.id && otherInstance.service === service,
		);
	};

	for (const target of safetyTargets) {
		const targetKey = cleanupDeleteTargetKey(target);
		context.verifiedRadarrFiles.delete(targetKey);
		context.verifiedSonarrFiles.delete(targetKey);
		context.plans.delete(targetKey);
		const targetInstance = instancesById.get(target.instanceId);
		const service =
			targetInstance?.service === "SONARR"
				? "SONARR"
				: targetInstance?.service === "RADARR"
					? "RADARR"
					: target.itemType === "series"
						? "SONARR"
						: "RADARR";
		if (!targetInstance) {
			const reason = verificationFailedReason(service);
			blocks.set(targetKey, reason);
			context.plans.set(targetKey, { kind: "blocked", reason });
			continue;
		}
		if (targetInstance.enabled !== true) {
			const reason = `Skipped for safety: the target ${serviceLabel(service)} instance is disabled. Enable it and run cleanup again before mutating it.`;
			blocks.set(targetKey, reason);
			context.plans.set(targetKey, { kind: "blocked", reason });
			continue;
		}

		try {
			const action = target.action ?? "delete";
			if (service === "RADARR") {
				if (target.itemType !== "movie") {
					throw new Error("Radarr cleanup target is not a movie");
				}
				const radarr = getRadarrClient(targetInstance);
				const movie = await radarr.movie.getById(target.arrItemId);
				const tmdbId = movie.tmdbId;
				if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) {
					throw new Error("Target movie has no valid TMDb ID");
				}
				const targetIdentity = buildTargetIdentity(targetInstance, tmdbId, movie.path);
				if (action === "unmonitor") {
					context.plans.set(targetKey, {
						kind: "verified_arr_target",
						target: targetIdentity,
					});
					continue;
				}
				const movieFileId = movie.movieFileId;
				let verifiedPlan: Extract<
					ExecutableSharedMediaSafetyPlan,
					{ kind: "verified_radarr" | "verified_radarr_empty" }
				>;
				if (movie.hasFile === false && (typeof movieFileId !== "number" || movieFileId <= 0)) {
					verifiedPlan = { kind: "verified_radarr_empty", target: targetIdentity };
				} else {
					if (
						typeof movieFileId !== "number" ||
						!Number.isSafeInteger(movieFileId) ||
						movieFileId <= 0
					) {
						throw new FileMatchVerificationError("Target movie has no valid movie file ID");
					}
					verifiedPlan = {
						kind: "verified_radarr",
						target: targetIdentity,
						file: radarrFileIdentity(
							movie,
							await radarr.movieFile.getById(movieFileId),
							movieFileId,
						),
						peers: [],
						ownership: [],
						targetDeleteNotifications: [],
					};
				}
				const notifications = (await getRadarrNotifications(targetInstance, radarr)).filter(
					(notification) => radarrNotificationApplies(notification, movie, action),
				);
				if (notifications.length === 0) {
					if (
						verifiedPlan.kind === "verified_radarr" &&
						otherInstanceMayOwnFile(targetInstance, service, 1)
					) {
						const reason = crossInstanceOwnershipReason(service);
						blocks.set(targetKey, reason);
						context.plans.set(targetKey, { kind: "blocked", reason });
						continue;
					}
					if (verifiedPlan.kind === "verified_radarr") {
						verifiedPlan.peerInventoryComplete = true;
						context.verifiedRadarrFiles.set(targetKey, verifiedPlan.file);
					}
					context.plans.set(targetKey, verifiedPlan);
					continue;
				}
				const unsupported = notifications.find(
					(notification) => mediaServerNotificationKind(notification) !== "plex",
				);
				if (unsupported) {
					const reason = unsupportedMediaServerReason(service, unsupportedDestination(unsupported));
					blocks.set(targetKey, reason);
					context.plans.set(targetKey, { kind: "blocked", reason });
					continue;
				}
				const plexNotifications = notifications.filter(
					(notification) => mediaServerNotificationKind(notification) === "plex",
				);
				if (
					action === "delete" &&
					verifiedPlan.kind === "verified_radarr_empty" &&
					plexNotifications.some((notification) => notification.onMovieDelete === true)
				) {
					const reason = filelessEntityDeleteRefreshReason(service);
					blocks.set(targetKey, reason);
					context.plans.set(targetKey, { kind: "blocked", reason });
					continue;
				}
				if (
					action === "delete" &&
					plexNotifications.some(
						(notification) =>
							notification.onMovieDelete === true && notification.onMovieFileDelete !== true,
					)
				) {
					const reason = entityDeleteRefreshReason(service);
					blocks.set(targetKey, reason);
					context.plans.set(targetKey, { kind: "blocked", reason });
					continue;
				}
				if (verifiedPlan.kind === "verified_radarr_empty") {
					context.plans.set(targetKey, verifiedPlan);
					continue;
				}
				const peerInstances = instances.filter(
					(candidate) => candidate.id !== targetInstance.id && candidate.service === "RADARR",
				);
				const radarrPeers: NonNullable<PlexVerificationInput["radarrPeers"]> = [];
				const radarrUntrackedPeerFiles: NonNullable<
					PlexVerificationInput["radarrUntrackedPeerFiles"]
				> = [];
				const radarrPeerCatalogs: Array<{
					instanceId: string;
					serviceFingerprint: string;
					client: InstanceType<typeof RadarrClient>;
					inventory: StableRadarrPeerInventory;
				}> = [];
				for (const peerInstance of peerInstances) {
					const peerClient = getRadarrClient(peerInstance);
					const inventory = await getRadarrPeerInventory(peerInstance, peerClient);
					radarrPeerCatalogs.push({
						instanceId: peerInstance.id,
						serviceFingerprint: createArrServiceFingerprint(peerInstance),
						client: peerClient,
						inventory,
					});
					const peerMovies = inventory.movieCatalog.filter(
						(candidate) => candidate.tmdbId === tmdbId,
					);
					if (peerMovies.length > 1) {
						throw new FileMatchVerificationError("Radarr peer returned multiple matching movies");
					}
					if (peerMovies.length === 0) {
						radarrPeers.push({
							identity: {
								instanceId: peerInstance.id,
								serviceFingerprint: createArrServiceFingerprint(peerInstance),
								externalId: tmdbId,
								arrItemId: null,
								mediaPath: null,
								file: null,
							},
							movieTags: [],
							notifications: [],
						});
					} else {
						const peerMovie = peerMovies[0]!;
						const peerMovieId = requiredPositiveSafeInteger(peerMovie.id, "Radarr peer movie ID");
						radarrPeers.push({
							identity: {
								instanceId: peerInstance.id,
								serviceFingerprint: createArrServiceFingerprint(peerInstance),
								externalId: tmdbId,
								arrItemId: peerMovieId,
								mediaPath: normalizeMediaPath(peerMovie.path),
								file: inventory.filesByMovie.get(peerMovieId) ?? null,
							},
							movieTags: peerMovie.tags ?? [],
							notifications: inventory.notifications,
						});
					}
					const trackedPeerMovieId = peerMovies[0]
						? requiredPositiveSafeInteger(peerMovies[0].id, "Radarr peer movie ID")
						: null;
					for (const peerMovie of inventory.movieCatalog) {
						const peerMovieId = requiredPositiveSafeInteger(
							peerMovie.id,
							"Unverified Radarr peer movie ID",
						);
						if (peerMovieId === trackedPeerMovieId) continue;
						const peerFile = inventory.filesByMovie.get(peerMovieId);
						if (!peerFile) continue;
						radarrUntrackedPeerFiles.push({
							file: peerFile,
							movieTags: peerMovie.tags ?? [],
							notifications: inventory.notifications,
						});
					}
				}
				const targetFile = verifiedPlan.file;
				const verification = await verifyPlexMediaState(
					deps,
					context,
					plexOwnerChecks,
					plexInstances,
					plexMovieLookups,
					plexSeriesLookups,
					{
						service,
						target,
						notifications: plexNotifications,
						externalId: tmdbId,
						files: [comparableFile(targetFile)],
						radarrPeers,
						radarrUntrackedPeerFiles,
					},
				);
				if (verification.block) {
					blocks.set(targetKey, verification.block);
					context.plans.set(targetKey, { kind: "blocked", reason: verification.block });
				} else {
					const targetDeleteNotifications = radarrTargetDeleteNotificationWitnesses(
						plexNotifications,
						movie,
					);
					pendingRadarrPlans.push({
						target,
						targetKey,
						client: radarr,
						targetIdentity,
						targetFile,
						peers: radarrPeers,
						peerCatalogs: radarrPeerCatalogs,
						ownership: verification.ownership,
						targetDeleteNotifications,
					});
				}
				continue;
			}

			if (target.itemType !== "series") {
				throw new Error("Sonarr cleanup target is not a series");
			}
			const sonarr = getSonarrClient(targetInstance);
			const series = await sonarr.series.getById(target.arrItemId);
			const tvdbId = series.tvdbId;
			if (typeof tvdbId !== "number" || !Number.isInteger(tvdbId) || tvdbId <= 0) {
				throw new Error("Target series has no valid TVDB ID");
			}
			const targetIdentity = buildTargetIdentity(targetInstance, tvdbId, series.path);
			if (action === "unmonitor" && target.targetScope !== "episode") {
				context.plans.set(targetKey, {
					kind: "verified_arr_target",
					target: targetIdentity,
				});
				continue;
			}
			const verifiedFiles: VerifiedSonarrFileIdentity = {
				seriesPath: normalizeMediaPath(series.path),
				episodeFiles: (await sonarr.episodeFile.getBySeries(target.arrItemId)).map((file) =>
					sonarrEpisodeFileIdentity(series, file),
				),
			};
			const allNotifications = await getSonarrNotifications(targetInstance, sonarr);
			let episodePlan:
				| {
						episode: VerifiedSonarrEpisodeIdentity;
						selectedFile: VerifiedSonarrEpisodeFileIdentity;
						retainedTargetFiles: VerifiedSonarrEpisodeFileIdentity[];
						watchProof: VerifiedEpisodePlexWatchProof;
						quiIdentity: VerifiedEpisodeQuiIdentity;
				  }
				| undefined;
			if (target.targetScope === "episode") {
				const requestedEpisodeId = requiredPositiveSafeInteger(
					target.arrEpisodeId,
					"Target Sonarr episode ID",
				);
				const requestedSeasonNumber = target.seasonNumber;
				if (
					typeof requestedSeasonNumber !== "number" ||
					!Number.isSafeInteger(requestedSeasonNumber) ||
					requestedSeasonNumber < 0
				) {
					throw new FileMatchVerificationError("Target Sonarr season number is invalid");
				}
				const requestedEpisodeNumber = requiredPositiveSafeInteger(
					target.episodeNumber,
					"Target Sonarr episode number",
				);
				const liveEpisodes = (await sonarr.episode.getAll({
					seriesId: target.arrItemId,
					includeEpisodeFile: true,
				})) as unknown as Array<Record<string, unknown>>;
				const selectedEpisode = liveEpisodes.find(
					(episode) =>
						episode.id === requestedEpisodeId &&
						episode.seasonNumber === requestedSeasonNumber &&
						episode.episodeNumber === requestedEpisodeNumber,
				);
				if (!selectedEpisode) {
					throw new FileMatchVerificationError("Target Sonarr episode identity changed");
				}
				if (typeof selectedEpisode.monitored !== "boolean") {
					throw new FileMatchVerificationError(
						"Target Sonarr episode monitored state is unavailable",
					);
				}
				const selectedEpisodeFileId = requiredPositiveSafeInteger(
					selectedEpisode.episodeFileId,
					"Target Sonarr episode file ID",
				);
				if (
					typeof target.episodeFileId === "number" &&
					target.episodeFileId !== selectedEpisodeFileId
				) {
					throw new FileMatchVerificationError("Target Sonarr episode file changed");
				}
				const consumerIds = liveEpisodes
					.filter((episode) => episode.episodeFileId === selectedEpisodeFileId)
					.map((episode) => requiredPositiveSafeInteger(episode.id, "Sonarr episode consumer ID"))
					.sort((left, right) => left - right);
				if (consumerIds.length !== 1 || consumerIds[0] !== requestedEpisodeId) {
					throw new FileMatchVerificationError("Target Sonarr file belongs to multiple episodes");
				}
				const selectedFile = verifiedFiles.episodeFiles.find(
					(file) => file.episodeFileId === selectedEpisodeFileId,
				);
				if (!selectedFile) {
					throw new FileMatchVerificationError("Target Sonarr episode file is unavailable");
				}
				const cachedEpisodeFile = await deps.prisma.episodeFileCache.findFirst({
					where: {
						instanceId: target.instanceId,
						arrEpisodeFileId: selectedEpisodeFileId,
					},
					select: { infoHash: true, torrentState: true },
				});
				if (!cachedEpisodeFile) {
					throw new FileMatchVerificationError("Target Sonarr episode qUI identity is unavailable");
				}
				const quiIdentity: VerifiedEpisodeQuiIdentity = {
					enabled: target.respectQuiSeeding === true,
					infoHash: cachedEpisodeFile.infoHash,
					torrentState: cachedEpisodeFile.torrentState,
				};
				if (
					quiIdentity.enabled &&
					(target.episodeFileInfoHash !== quiIdentity.infoHash ||
						target.episodeFileTorrentState !== quiIdentity.torrentState)
				) {
					throw new FileMatchVerificationError("Target Sonarr episode qUI state changed");
				}
				if (quiIdentity.enabled) {
					await verifyFreshEpisodeQuiState(deps, context, userId, selectedFile.fullPath.value);
				}
				const verifiedWatch = await verifyEpisodePlexWatchProof(
					deps,
					context,
					plexOwnerChecks,
					plexInstances,
					plexSeriesLookups,
					target,
					series,
					tvdbId,
					selectedFile,
					allNotifications,
				);
				context.liveEpisodeWatchSources.set(targetKey, verifiedWatch.liveWatchSources);
				episodePlan = {
					episode: {
						arrEpisodeId: requestedEpisodeId,
						seasonNumber: requestedSeasonNumber,
						episodeNumber: requestedEpisodeNumber,
						episodeFileId: selectedEpisodeFileId,
						episodeFileConsumerIds: consumerIds,
						monitored: selectedEpisode.monitored,
					},
					selectedFile,
					retainedTargetFiles: verifiedFiles.episodeFiles.filter(
						(file) => file.episodeFileId !== selectedEpisodeFileId,
					),
					watchProof: verifiedWatch.proof,
					quiIdentity,
				};
				if (action === "unmonitor") {
					context.plans.set(targetKey, {
						kind: "verified_sonarr_episode",
						target: targetIdentity,
						...episodePlan,
						peers: [],
						ownership: [],
						targetDeleteNotifications: [],
					});
					continue;
				}
			}
			const notifications = allNotifications.filter(
				(notification) =>
					sonarrNotificationApplies(notification, series, action) &&
					(!episodePlan || notification.onEpisodeFileDelete === true),
			);
			if (notifications.length === 0) {
				const mutationFileCount = episodePlan
					? 1
					: action === "delete"
						? Math.max(1, verifiedFiles.episodeFiles.length)
						: verifiedFiles.episodeFiles.length;
				if (otherInstanceMayOwnFile(targetInstance, service, mutationFileCount)) {
					const reason = crossInstanceOwnershipReason(service);
					blocks.set(targetKey, reason);
					context.plans.set(targetKey, { kind: "blocked", reason });
					continue;
				}
				if (episodePlan) {
					if (episodePlan.quiIdentity.enabled) {
						await verifyFreshEpisodeQuiState(
							deps,
							context,
							userId,
							episodePlan.selectedFile.fullPath.value,
							{ refresh: true },
						);
					}
					await assertVerifiedSonarrEpisodeUnchanged(sonarr, target.arrItemId, {
						target: targetIdentity,
						...episodePlan,
					});
				}
				context.verifiedSonarrFiles.set(targetKey, verifiedFiles);
				context.plans.set(
					targetKey,
					episodePlan
						? {
								kind: "verified_sonarr_episode",
								target: targetIdentity,
								...episodePlan,
								peers: [],
								ownership: [],
								targetDeleteNotifications: [],
							}
						: {
								kind: "verified_sonarr",
								target: targetIdentity,
								files: verifiedFiles,
								peers: [],
								ownership: [],
								targetDeleteNotifications: [],
							},
				);
				continue;
			}
			const unsupported = notifications.find(
				(notification) => mediaServerNotificationKind(notification) !== "plex",
			);
			if (unsupported) {
				const reason = unsupportedMediaServerReason(service, unsupportedDestination(unsupported));
				blocks.set(targetKey, reason);
				context.plans.set(targetKey, { kind: "blocked", reason });
				continue;
			}
			const plexNotifications = notifications.filter(
				(notification) => mediaServerNotificationKind(notification) === "plex",
			);
			if (
				action === "delete" &&
				verifiedFiles.episodeFiles.length === 0 &&
				plexNotifications.some((notification) => notification.onSeriesDelete === true)
			) {
				const reason = filelessEntityDeleteRefreshReason(service);
				blocks.set(targetKey, reason);
				context.plans.set(targetKey, { kind: "blocked", reason });
				continue;
			}
			if (
				action === "delete" &&
				plexNotifications.some(
					(notification) =>
						notification.onSeriesDelete === true && notification.onEpisodeFileDelete !== true,
				)
			) {
				const reason = entityDeleteRefreshReason(service);
				blocks.set(targetKey, reason);
				context.plans.set(targetKey, { kind: "blocked", reason });
				continue;
			}
			const peerInstances = instances.filter(
				(candidate) => candidate.id !== targetInstance.id && candidate.service === "SONARR",
			);
			const sonarrPeers: NonNullable<PlexVerificationInput["sonarrPeers"]> = [];
			const sonarrPeerCatalogs: Array<{
				client: InstanceType<typeof SonarrClient>;
				peer: VerifiedSonarrPeerIdentity;
			}> = [];
			for (const peerInstance of peerInstances) {
				const peerClient = getSonarrClient(peerInstance);
				const peerSeriesCatalog = await getSonarrSeries(peerInstance, peerClient);
				const peerSeriesItems = peerSeriesCatalog.filter(
					(candidate) => candidate.tvdbId === tvdbId,
				);
				const peerNotifications = await getSonarrNotifications(peerInstance, peerClient);
				if (peerSeriesItems.length > 1) {
					throw new FileMatchVerificationError("Sonarr peer returned multiple matching series");
				}
				if (peerSeriesItems.length === 0) {
					const peerIdentity: VerifiedSonarrPeerIdentity = {
						instanceId: peerInstance.id,
						serviceFingerprint: createArrServiceFingerprint(peerInstance),
						externalId: tvdbId,
						arrItemId: null,
						mediaPath: null,
						files: null,
					};
					sonarrPeerCatalogs.push({ client: peerClient, peer: peerIdentity });
					sonarrPeers.push({
						identity: peerIdentity,
						seriesTags: [],
						notifications: [],
					});
					continue;
				}
				const peerSeries = peerSeriesItems[0]!;
				const peerSeriesId = requiredPositiveSafeInteger(peerSeries.id, "Sonarr peer series ID");
				const peerFiles: VerifiedSonarrFileIdentity = {
					seriesPath: normalizeMediaPath(peerSeries.path),
					episodeFiles: (await peerClient.episodeFile.getBySeries(peerSeriesId)).map((file) =>
						sonarrEpisodeFileIdentity(peerSeries, file),
					),
				};
				const peerIdentity: VerifiedSonarrPeerIdentity = {
					instanceId: peerInstance.id,
					serviceFingerprint: createArrServiceFingerprint(peerInstance),
					externalId: tvdbId,
					arrItemId: peerSeriesId,
					mediaPath: normalizeMediaPath(peerSeries.path),
					files: peerFiles,
				};
				sonarrPeerCatalogs.push({ client: peerClient, peer: peerIdentity });
				sonarrPeers.push({
					identity: peerIdentity,
					seriesTags: peerSeries.tags ?? [],
					notifications: peerFiles.episodeFiles.length === 0 ? [] : peerNotifications,
				});
			}
			const targetDeleteNotifications = sonarrTargetDeleteNotificationWitnesses(
				plexNotifications,
				series,
				action,
			);
			const verification = await verifyPlexMediaState(
				deps,
				context,
				plexOwnerChecks,
				plexInstances,
				plexMovieLookups,
				plexSeriesLookups,
				{
					service,
					target,
					notifications: plexNotifications,
					externalId: tvdbId,
					files: (episodePlan ? [episodePlan.selectedFile] : verifiedFiles.episodeFiles).map(
						comparableFile,
					),
					retainedSonarrTargetFiles: episodePlan
						? episodePlan.retainedTargetFiles.map(comparableFile)
						: undefined,
					sonarrPeers,
				},
			);
			if (verification.block) {
				blocks.set(targetKey, verification.block);
				context.plans.set(targetKey, { kind: "blocked", reason: verification.block });
			} else {
				pendingSonarrPlans.push({
					target,
					targetKey,
					client: sonarr,
					action,
					targetIdentity,
					verifiedFiles,
					peers: sonarrPeers,
					peerCatalogs: sonarrPeerCatalogs,
					ownership: verification.sonarrOwnership,
					targetDeleteNotifications,
					episodePlan,
				});
			}
		} catch (error) {
			const reason =
				error instanceof ArrFileChangedDuringSafetyCheckError
					? error.message
					: error instanceof EpisodeWatchProofError
						? "Skipped for safety: the watched Plex episode could not be mapped to the exact selected Sonarr episode file. Refresh Plex episode data and verify path mappings."
						: error instanceof FileMatchVerificationError
							? fileMatchFailedReason(service)
							: verificationFailedReason(service);
			blocks.set(targetKey, reason);
			context.plans.set(targetKey, { kind: "blocked", reason });
			deps.log.warn(
				{
					err: getErrorMessage(error),
					instanceId: target.instanceId,
					arrItemId: target.arrItemId,
					service,
				},
				"Cleanup shared-Plex safety check failed closed",
			);
		}
	}

	const terminalRadarrPeerInventories = new Map<string, Promise<StableRadarrPeerInventory>>();
	const terminalRadarrNotifications = new Map<string, Promise<RadarrNotification[]>>();
	for (const pending of pendingRadarrPlans) {
		try {
			for (const peerCatalog of pending.peerCatalogs) {
				const inventoryKey = `${peerCatalog.instanceId}:${peerCatalog.serviceFingerprint}`;
				let inventoryPromise = terminalRadarrPeerInventories.get(inventoryKey);
				if (!inventoryPromise) {
					inventoryPromise = readStableRadarrPeerInventory(peerCatalog.client);
					terminalRadarrPeerInventories.set(inventoryKey, inventoryPromise);
				}
				const freshInventory = await inventoryPromise;
				if (!radarrPeerInventoriesEqual(peerCatalog.inventory, freshInventory)) {
					throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
				}
			}
			let notificationsPromise = terminalRadarrNotifications.get(
				pending.targetIdentity.serviceFingerprint,
			);
			if (!notificationsPromise) {
				notificationsPromise = pending.client.notification.getAll();
				terminalRadarrNotifications.set(
					pending.targetIdentity.serviceFingerprint,
					notificationsPromise,
				);
			}
			const freshTargetDeleteNotifications = radarrTargetDeleteNotificationWitnesses(
				await notificationsPromise,
				await pending.client.movie.getById(pending.target.arrItemId),
			);
			if (
				JSON.stringify(freshTargetDeleteNotifications) !==
				JSON.stringify(pending.targetDeleteNotifications)
			) {
				throw new ArrTargetChangedDuringSafetyCheckError();
			}
			await assertVerifiedRadarrFileUnchanged(
				pending.client,
				pending.target.arrItemId,
				pending.targetIdentity,
				pending.targetFile,
			);
			context.verifiedRadarrFiles.set(pending.targetKey, pending.targetFile);
			context.plans.set(pending.targetKey, {
				kind: "verified_radarr",
				target: pending.targetIdentity,
				file: pending.targetFile,
				peers: pending.peers.map((peer) => peer.identity),
				peerInventoryComplete: true,
				ownership: pending.ownership,
				targetDeleteNotifications: pending.targetDeleteNotifications,
			});
		} catch (error) {
			const reason =
				error instanceof ArrFileChangedDuringSafetyCheckError
					? error.message
					: error instanceof FileMatchVerificationError
						? fileMatchFailedReason("RADARR")
						: verificationFailedReason("RADARR");
			blocks.set(pending.targetKey, reason);
			context.plans.set(pending.targetKey, { kind: "blocked", reason });
			deps.log.warn(
				{
					err: getErrorMessage(error),
					instanceId: pending.target.instanceId,
					arrItemId: pending.target.arrItemId,
					service: "RADARR",
				},
				"Cleanup shared-Plex safety check failed closed",
			);
		}
	}

	const sonarrPeerInventories = new Map<string, Promise<StableSonarrPeerInventory>>();
	for (const pending of pendingSonarrPlans) {
		try {
			for (const peerCatalog of pending.peerCatalogs) {
				const inventoryKey = `${peerCatalog.peer.instanceId}:${peerCatalog.peer.serviceFingerprint}`;
				let inventoryPromise = sonarrPeerInventories.get(inventoryKey);
				if (!inventoryPromise) {
					inventoryPromise = readStableSonarrPeerInventory(peerCatalog.client);
					sonarrPeerInventories.set(inventoryKey, inventoryPromise);
				}
				const inventory = await inventoryPromise;
				const freshPeerSeries = assertVerifiedSonarrPeerIdentityFromInventory(
					peerCatalog.peer,
					inventory,
				);
				assertVerifiedSonarrTrackedPeerMappingUnchanged(
					peerCatalog.peer,
					freshPeerSeries,
					inventory.notifications,
					pending.ownership,
				);
				assertNoUnverifiedSonarrPeerOwnsTargetPartsFromInventory(
					new Set(peerCatalog.peer.arrItemId === null ? [] : [peerCatalog.peer.arrItemId]),
					pending.ownership,
					inventory,
				);
			}
			const freshTargetDeleteNotifications = sonarrTargetDeleteNotificationWitnesses(
				(await pending.client.notification.getAll()).filter(
					(notification) => !pending.episodePlan || notification.onEpisodeFileDelete === true,
				),
				await pending.client.series.getById(pending.target.arrItemId),
				pending.action,
			);
			if (
				JSON.stringify(freshTargetDeleteNotifications) !==
				JSON.stringify(pending.targetDeleteNotifications)
			) {
				throw new ArrTargetChangedDuringSafetyCheckError();
			}
			if (pending.episodePlan) {
				if (pending.episodePlan.quiIdentity.enabled) {
					await verifyFreshEpisodeQuiState(
						deps,
						context,
						userId,
						pending.episodePlan.selectedFile.fullPath.value,
						{ refresh: true },
					);
				}
				await assertVerifiedSonarrEpisodeUnchanged(pending.client, pending.target.arrItemId, {
					target: pending.targetIdentity,
					...pending.episodePlan,
				});
			}
			context.verifiedSonarrFiles.set(pending.targetKey, pending.verifiedFiles);
			context.plans.set(
				pending.targetKey,
				pending.episodePlan
					? {
							kind: "verified_sonarr_episode",
							target: pending.targetIdentity,
							...pending.episodePlan,
							peers: pending.peers.map((peer) => peer.identity),
							peerInventoryComplete: true,
							ownership: pending.ownership,
							targetDeleteNotifications: pending.targetDeleteNotifications,
						}
					: {
							kind: "verified_sonarr",
							target: pending.targetIdentity,
							files: pending.verifiedFiles,
							peers: pending.peers.map((peer) => peer.identity),
							peerInventoryComplete: true,
							ownership: pending.ownership,
							targetDeleteNotifications: pending.targetDeleteNotifications,
						},
			);
		} catch (error) {
			const reason =
				error instanceof ArrCrossInstanceOwnershipChangedDuringSafetyCheckError
					? error.message
					: error instanceof FileMatchVerificationError
						? fileMatchFailedReason("SONARR")
						: verificationFailedReason("SONARR");
			blocks.set(pending.targetKey, reason);
			context.plans.set(pending.targetKey, { kind: "blocked", reason });
			deps.log.warn(
				{
					err: getErrorMessage(error),
					instanceId: pending.target.instanceId,
					arrItemId: pending.target.arrItemId,
					service: "SONARR",
				},
				"Cleanup shared-Plex safety check failed closed",
			);
		}
	}

	return blocks;
}

/**
 * Revalidate the retained side of a verified multi-Radarr ownership proof after
 * the selected target file is gone. This deliberately does not require the
 * deleted target Plex part to remain visible, so it can guard the subsequent
 * fileless Radarr record deletion and its notification.
 */
export async function assertVerifiedRadarrPeerOwnershipRetained(
	deps: CleanupExecutorDeps,
	userId: string,
	targetArrItemId: number,
	plan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>,
): Promise<void> {
	if (plan.peerInventoryComplete !== true) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
	}
	const [arrInstances, plexInstances] = await Promise.all([
		deps.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["RADARR", "SONARR"] } },
		}),
		deps.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
		}),
	]);
	const peerInstances = arrInstances.filter(
		(instance) =>
			instance.service === "RADARR" &&
			createArrServiceFingerprint(instance) !== plan.target.serviceFingerprint,
	);
	const targetInstances = arrInstances.filter(
		(instance) =>
			instance.service === "RADARR" &&
			createArrServiceFingerprint(instance) === plan.target.serviceFingerprint,
	);
	const peerIds = new Set(plan.peers.map((peer) => peer.instanceId));
	if (
		targetInstances.length !== 1 ||
		peerInstances.length !== peerIds.size ||
		peerInstances.some((instance) => !peerIds.has(instance.id))
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
	}

	const targetClient = deps.arrClientFactory.create(targetInstances[0]!) as InstanceType<
		typeof RadarrClient
	>;
	await assertVerifiedRadarrEmptyUnchanged(targetClient, targetArrItemId, plan.target);
	const currentTargetMovie = await targetClient.movie.getById(targetArrItemId);
	const currentTargetDeleteNotifications = radarrTargetDeleteNotificationWitnesses(
		await targetClient.notification.getAll(),
		currentTargetMovie,
	);
	if (
		JSON.stringify(currentTargetDeleteNotifications) !==
		JSON.stringify(plan.targetDeleteNotifications)
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
	}

	const livePeers = new Map<string, NonNullable<PlexVerificationInput["radarrPeers"]>[number]>();
	const untrackedPeerFiles: NonNullable<PlexVerificationInput["radarrUntrackedPeerFiles"]> = [];
	const peerInventories: Array<{
		client: InstanceType<typeof RadarrClient>;
		inventory: StableRadarrPeerInventory;
	}> = [];
	for (const peer of plan.peers) {
		const peerInstance = peerInstances.find((instance) => instance.id === peer.instanceId);
		if (!peerInstance || createArrServiceFingerprint(peerInstance) !== peer.serviceFingerprint) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
		}
		const client = deps.arrClientFactory.create(peerInstance) as InstanceType<typeof RadarrClient>;
		const inventory = await readStableRadarrPeerInventory(client);
		peerInventories.push({ client, inventory });
		const movie = assertVerifiedRadarrPeerIdentityFromInventory(peer, inventory);
		const trackedMovieId = peer.arrItemId;
		for (const catalogMovie of inventory.movieCatalog) {
			const movieId = requiredPositiveSafeInteger(
				catalogMovie.id,
				"Unverified Radarr peer movie ID",
			);
			if (movieId === trackedMovieId) continue;
			const file = inventory.filesByMovie.get(movieId);
			if (!file) continue;
			untrackedPeerFiles.push({
				file,
				movieTags: catalogMovie.tags ?? [],
				notifications: inventory.notifications,
			});
		}
		if (movie) {
			livePeers.set(peer.instanceId, {
				identity: peer,
				movieTags: movie.tags ?? [],
				notifications: inventory.notifications,
			});
		}
	}

	const context = createSharedPlexSafetyContext();
	const ownerChecks = new Map<string, Promise<void>>();
	for (const ownership of plan.ownership) {
		const matchingPlexInstances = plexInstances.filter(
			(instance) => normalizedServerUrl(instance.baseUrl) === ownership.plexServerUrl,
		);
		if (matchingPlexInstances.length === 0) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
		}
		for (const plexInstance of matchingPlexInstances) {
			const plex = await requirePlexClient(deps, context, ownerChecks, plexInstance);
			let mediaItems: PlexMovieMediaItem[];
			try {
				mediaItems = await plex.getMovieMediaPartsByTmdbId(plan.target.externalId);
			} catch (error) {
				if (error instanceof PlexMovieNotFoundError && ownership.retained.length === 0) {
					mediaItems = [];
				} else {
					throw error;
				}
			}
			const targetItems = mediaItems.filter(
				(item) => item.ratingKey === ownership.target.ratingKey,
			);
			if (targetItems.length > 1) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
			}
			for (const peer of untrackedPeerFiles) {
				const candidate = mappedRadarrPeerFileCandidate(peer, ownership.plexServerUrl, true);
				if (
					candidate &&
					candidate.size === ownership.target.size &&
					pathsEqual(candidate.fullPath, ownership.target.fullPath)
				) {
					throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
				}
			}
			for (const expected of ownership.retained) {
				const peer = livePeers.get(expected.instanceId);
				if (!peer) throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
				const match = matchingPeerPlexPart(peer, mediaItems, ownership.plexServerUrl);
				if (
					!match ||
					match.item.ratingKey !== expected.ratingKey ||
					match.part.size !== expected.size ||
					!pathsEqual(normalizeMediaPath(match.part.file), expected.fullPath) ||
					JSON.stringify(match.mapping) !== JSON.stringify(expected.mapping)
				) {
					throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
				}
			}
			const allowedPartsByRatingKey = new Map<string, Set<string>>();
			allowedPartsByRatingKey.set(
				ownership.target.ratingKey,
				new Set([
					plexPartKey({
						file: ownership.target.fullPath.value,
						size: ownership.target.size,
					}),
				]),
			);
			for (const retained of ownership.retained) {
				const allowedParts = allowedPartsByRatingKey.get(retained.ratingKey) ?? new Set<string>();
				allowedParts.add(plexPartKey({ file: retained.fullPath.value, size: retained.size }));
				allowedPartsByRatingKey.set(retained.ratingKey, allowedParts);
			}
			for (const item of mediaItems) {
				const allowedParts = allowedPartsByRatingKey.get(item.ratingKey);
				const partKeys = item.parts.map(plexPartKey);
				if (
					!allowedParts ||
					new Set(partKeys).size !== partKeys.length ||
					partKeys.some((partKey) => !allowedParts.has(partKey))
				) {
					throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
				}
			}
		}
	}
	for (const peerInventory of peerInventories) {
		const freshInventory = await readStableRadarrPeerInventory(peerInventory.client);
		if (!radarrPeerInventoriesEqual(peerInventory.inventory, freshInventory)) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
		}
	}
	const finalTargetDeleteNotifications = radarrTargetDeleteNotificationWitnesses(
		await targetClient.notification.getAll(),
		await targetClient.movie.getById(targetArrItemId),
	);
	if (
		JSON.stringify(finalTargetDeleteNotifications) !==
		JSON.stringify(plan.targetDeleteNotifications)
	) {
		throw new ArrTargetChangedDuringSafetyCheckError();
	}
	await assertVerifiedRadarrEmptyUnchanged(targetClient, targetArrItemId, plan.target);
}

/**
 * Revalidate every retained Sonarr episode-file witness after the selected
 * target files are gone and immediately before the fileless series record is
 * deleted. The final target-file read is deliberately last.
 */
export async function assertVerifiedSonarrPeerOwnershipRetained(
	deps: CleanupExecutorDeps,
	userId: string,
	targetArrItemId: number,
	plan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>,
): Promise<void> {
	if (plan.peerInventoryComplete !== true) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
	}
	const [arrInstances, plexInstances] = await Promise.all([
		deps.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["RADARR", "SONARR"] } },
		}),
		deps.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
		}),
	]);
	const peerInstances = arrInstances.filter(
		(instance) =>
			instance.service === "SONARR" &&
			createArrServiceFingerprint(instance) !== plan.target.serviceFingerprint,
	);
	const targetInstances = arrInstances.filter(
		(instance) =>
			instance.service === "SONARR" &&
			createArrServiceFingerprint(instance) === plan.target.serviceFingerprint,
	);
	const peerIds = new Set(plan.peers.map((peer) => peer.instanceId));
	if (
		targetInstances.length !== 1 ||
		peerInstances.length !== peerIds.size ||
		peerInstances.some((instance) => !peerIds.has(instance.id))
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
	}
	const targetClient = deps.arrClientFactory.create(targetInstances[0]!) as InstanceType<
		typeof SonarrClient
	>;
	const emptyTargetFiles: VerifiedSonarrFileIdentity = {
		seriesPath: plan.files.seriesPath,
		episodeFiles: [],
	};
	const expectedTargetSeriesDeleteNotifications = plan.targetDeleteNotifications.filter(
		(notification) => notification.onSeriesDelete,
	);
	await assertVerifiedSonarrFilesUnchanged(
		targetClient,
		targetArrItemId,
		plan.target,
		emptyTargetFiles,
	);
	const currentTargetSeries = await targetClient.series.getById(targetArrItemId);
	const currentTargetDeleteNotifications = sonarrTargetDeleteNotificationWitnesses(
		await targetClient.notification.getAll(),
		currentTargetSeries,
		"delete",
		true,
	);
	if (
		JSON.stringify(currentTargetDeleteNotifications) !==
		JSON.stringify(expectedTargetSeriesDeleteNotifications)
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
	}

	const livePeers = new Map<string, NonNullable<PlexVerificationInput["sonarrPeers"]>[number]>();
	for (const peer of plan.peers) {
		const peerInstance = peerInstances.find((instance) => instance.id === peer.instanceId);
		if (!peerInstance || createArrServiceFingerprint(peerInstance) !== peer.serviceFingerprint) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		const client = deps.arrClientFactory.create(peerInstance) as InstanceType<typeof SonarrClient>;
		const seriesCatalog = await client.series.getAll();
		const peerNotifications = await client.notification.getAll();
		const verifiedPeer = await assertVerifiedSonarrPeerInventoryUnchanged(
			client,
			peer,
			plan.ownership,
			seriesCatalog,
			peerNotifications,
		);
		if (peer.arrItemId === null || peer.files === null || verifiedPeer.series === null) continue;
		livePeers.set(peer.instanceId, {
			identity: peer,
			seriesTags: verifiedPeer.series.tags ?? [],
			notifications: peer.files.episodeFiles.length ? verifiedPeer.notifications : [],
		});
	}

	const context = createSharedPlexSafetyContext();
	const ownerChecks = new Map<string, Promise<void>>();
	for (const ownership of plan.ownership) {
		const matchingPlexInstances = plexInstances.filter(
			(instance) => normalizedServerUrl(instance.baseUrl) === ownership.plexServerUrl,
		);
		if (matchingPlexInstances.length === 0) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		for (const plexInstance of matchingPlexInstances) {
			const plex = await requirePlexClient(deps, context, ownerChecks, plexInstance);
			let mediaItems: PlexSeriesMediaItem[];
			try {
				mediaItems = await plex.getSeriesEpisodeMediaPartsByTvdbId(plan.target.externalId);
			} catch (error) {
				if (error instanceof PlexSeriesNotFoundError && ownership.retained.length === 0) {
					mediaItems = [];
				} else {
					throw error;
				}
			}
			const liveRetained: VerifiedSonarrPlexOwnership["retained"] = [];
			for (const expectedPeer of plan.peers) {
				const peer = livePeers.get(expectedPeer.instanceId);
				if (!peer) continue;
				for (const match of matchingSonarrPeerPlexParts(
					peer,
					mediaItems,
					ownership.plexServerUrl,
				)) {
					liveRetained.push({
						instanceId: expectedPeer.instanceId,
						ratingKey: match.show.ratingKey,
						fullPath: normalizeMediaPath(match.part.file),
						size: match.part.size,
						mapping: match.mapping,
					});
				}
			}
			const expectedRetained = [...ownership.retained].sort((left, right) =>
				JSON.stringify(left).localeCompare(JSON.stringify(right)),
			);
			liveRetained.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
			if (JSON.stringify(liveRetained) !== JSON.stringify(expectedRetained)) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
			}

			const allowedPartKeys = new Set([
				...ownership.target.map(
					(part) =>
						`${part.ratingKey}:${plexPartKey({ file: part.fullPath.value, size: part.size })}`,
				),
				...ownership.retained.map(
					(part) =>
						`${part.ratingKey}:${plexPartKey({ file: part.fullPath.value, size: part.size })}`,
				),
			]);
			for (const show of mediaItems) {
				for (const partKey of new Set(
					show.episodes.flatMap((episode) => episode.parts.map(plexPartKey)),
				)) {
					if (!allowedPartKeys.has(`${show.ratingKey}:${partKey}`)) {
						throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
					}
				}
			}
		}
	}
	for (const peer of plan.peers) {
		const peerInstance = peerInstances.find((instance) => instance.id === peer.instanceId);
		if (!peerInstance || createArrServiceFingerprint(peerInstance) !== peer.serviceFingerprint) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		const client = deps.arrClientFactory.create(peerInstance) as InstanceType<typeof SonarrClient>;
		const seriesCatalog = await client.series.getAll();
		const currentPeerNotifications = await client.notification.getAll();
		await assertVerifiedSonarrPeerInventoryUnchanged(
			client,
			peer,
			plan.ownership,
			seriesCatalog,
			currentPeerNotifications,
		);
	}
	const finalTargetDeleteNotifications = sonarrTargetDeleteNotificationWitnesses(
		await targetClient.notification.getAll(),
		await targetClient.series.getById(targetArrItemId),
		"delete",
		true,
	);
	if (
		JSON.stringify(finalTargetDeleteNotifications) !==
		JSON.stringify(expectedTargetSeriesDeleteNotifications)
	) {
		throw new ArrTargetChangedDuringSafetyCheckError();
	}
	await assertVerifiedSonarrFilesUnchanged(
		targetClient,
		targetArrItemId,
		plan.target,
		emptyTargetFiles,
	);
}
