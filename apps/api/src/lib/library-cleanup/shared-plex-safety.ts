import type {
	Movie,
	MovieFile,
	Notification as RadarrNotification,
	RadarrClient,
} from "arr-sdk/radarr";
import type {
	EpisodeFile,
	Notification as SonarrNotification,
	Series,
	SonarrClient,
} from "arr-sdk/sonarr";
import {
	createPlexClient,
	type PlexClient,
	type PlexMovieMediaItem,
	type PlexSeriesMediaItem,
} from "../plex/plex-client.js";
import type { ServiceInstance } from "../prisma.js";
export { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { CleanupExecutorDeps } from "./types.js";

export interface CleanupDeleteTarget {
	instanceId: string;
	arrItemId: number;
	itemType: string;
	action?: string | null;
}

type SafetyPlexClient = Pick<
	PlexClient,
	"getAccounts" | "getMovieMediaPartsByTmdbId" | "getSeriesEpisodeMediaPartsByTvdbId"
>;

export interface SharedPlexSafetyContext {
	plexClients: Map<string, SafetyPlexClient>;
	failedPlexConnections: Set<string>;
	verifiedRadarrFiles: Map<string, VerifiedRadarrFileIdentity>;
	verifiedSonarrFiles: Map<string, VerifiedSonarrFileIdentity>;
	plans: Map<string, SharedMediaSafetyPlan>;
}

export function createSharedPlexSafetyContext(): SharedPlexSafetyContext {
	return {
		plexClients: new Map(),
		failedPlexConnections: new Set(),
		verifiedRadarrFiles: new Map(),
		verifiedSonarrFiles: new Map(),
		plans: new Map(),
	};
}

class FileMatchVerificationError extends Error {}

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
			ownership: VerifiedRadarrPlexOwnership[];
			targetDeleteNotifications: VerifiedRadarrTargetDeleteNotification[];
	  }
	| {
			kind: "verified_sonarr";
			target: VerifiedArrTargetIdentity;
			files: VerifiedSonarrFileIdentity;
	  };

export type ExecutableSharedMediaSafetyPlan = Extract<
	SharedMediaSafetyPlan,
	{
		kind: "verified_arr_target" | "verified_radarr_empty" | "verified_radarr" | "verified_sonarr";
	}
>;

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
			ownership: canonicalRadarrOwnership(candidate.ownership),
			targetDeleteNotifications: canonicalRadarrTargetDeleteNotifications(
				candidate.targetDeleteNotifications,
			),
		};
	}
	if (candidate.kind === "verified_sonarr") {
		const files = candidate.files as Record<string, unknown> | undefined;
		if (!files || !Array.isArray(files.episodeFiles)) {
			throw new FileMatchVerificationError("Sonarr safety snapshot is invalid");
		}
		const episodeFiles = files.episodeFiles
			.map((entry) => {
				const file = entry as Record<string, unknown>;
				return {
					episodeFileId: requiredPositiveSafeInteger(file.episodeFileId, "Sonarr episode file ID"),
					fullPath: normalizeMediaPath(
						(file.fullPath as Record<string, unknown> | undefined)?.value,
					),
					size: requiredPositiveSafeInteger(file.size, "Sonarr episode file size"),
				};
			})
			.sort((left, right) => left.episodeFileId - right.episodeFileId);
		const uniqueIds = new Set(episodeFiles.map((file) => file.episodeFileId));
		if (uniqueIds.size !== episodeFiles.length) {
			throw new FileMatchVerificationError("Sonarr safety snapshot contains duplicate file IDs");
		}
		return {
			kind: "verified_sonarr",
			target: canonicalTargetIdentity(candidate.target),
			files: {
				seriesPath: normalizeMediaPath(
					(files.seriesPath as Record<string, unknown> | undefined)?.value,
				),
				episodeFiles,
			},
		};
	}
	throw new FileMatchVerificationError("Cleanup safety snapshot is not executable");
}

export function serializeExecutableSafetyPlan(plan: ExecutableSharedMediaSafetyPlan): string {
	return JSON.stringify(canonicalExecutableSafetyPlan(plan));
}

export function parseExecutableSafetyPlan(value: unknown): ExecutableSharedMediaSafetyPlan | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	try {
		return canonicalExecutableSafetyPlan(JSON.parse(value));
	} catch {
		return null;
	}
}

export function executableSafetyPlansEqual(
	left: ExecutableSharedMediaSafetyPlan,
	right: ExecutableSharedMediaSafetyPlan,
): boolean {
	return serializeExecutableSafetyPlan(left) === serializeExecutableSafetyPlan(right);
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
	const movieFile = item.movieFile as Record<string, unknown> | null | undefined;
	const movieFileId = movieFile?.id;
	if (!hasFile) {
		return typeof movieFileId !== "number" || movieFileId <= 0
			? { kind: "verified_radarr_empty", target }
			: null;
	}
	if (!movieFile) return null;
	try {
		const pathValue =
			typeof movieFile.path === "string" && movieFile.path.trim()
				? movieFile.path
				: joinMediaPath(item.path, movieFile.relativePath, "RADARR");
		return canonicalExecutableSafetyPlan({
			kind: "verified_radarr",
			target,
			file: {
				movieFileId,
				fullPath: { value: pathValue },
				size: movieFile.size,
			},
			peers: [],
			ownership: [],
			targetDeleteNotifications: [],
		});
	} catch {
		return null;
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
	const rawMapFrom = fieldValue(notification, "mapFrom");
	const rawMapTo = fieldValue(notification, "mapTo");
	const hasMapFrom = typeof rawMapFrom === "string" && rawMapFrom.trim() !== "";
	const hasMapTo = typeof rawMapTo === "string" && rawMapTo.trim() !== "";
	if (!hasMapFrom && !hasMapTo) return target.fullPath;
	if (!hasMapFrom || !hasMapTo) {
		throw new FileMatchVerificationError(
			`${serviceLabel(service)} Plex path mapping is incomplete`,
		);
	}

	const mapFrom = normalizeMediaPath(rawMapFrom);
	const mapTo = normalizeMediaPath(rawMapTo);
	if (mapFrom.windows !== target.fullPath.windows) {
		throw new FileMatchVerificationError(
			`${serviceLabel(service)} Plex source mapping uses a different path type`,
		);
	}
	const caseInsensitive = target.fullPath.windows;
	const targetPath = comparablePath(target.fullPath, caseInsensitive);
	const sourceValue = mapFrom.value.replace(/\/+$/, "");
	const sourcePrefix = comparablePath({ ...mapFrom, value: sourceValue }, caseInsensitive);
	if (!targetPath.startsWith(`${sourcePrefix}/`)) {
		throw new FileMatchVerificationError(
			`${serviceLabel(service)} path is outside its Plex source mapping`,
		);
	}
	const relativePath = target.fullPath.value.slice(sourceValue.length + 1);
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

function matchingPlexSeriesShows(
	targets: MediaFileIdentity[],
	seriesItems: PlexSeriesMediaItem[],
	notification: NotificationLike,
): PlexSeriesMediaItem[] {
	const mappedTargets = targets.map((target) => ({
		...target,
		fullPath: mappedArrPathForNotification(target, notification, "SONARR"),
	}));
	const matchedShows = new Map<string, PlexSeriesMediaItem>();

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
		matchedShows.set(match.show.ratingKey, match.show);
	}

	const targetKeys = new Set(
		mappedTargets.map((target) => plexPartKey({ file: target.fullPath.value, size: target.size })),
	);
	for (const show of matchedShows.values()) {
		const showPartKeys = new Set(
			show.episodes.flatMap((episode) => episode.parts.map((part) => plexPartKey(part))),
		);
		for (const partKey of showPartKeys) {
			if (!targetKeys.has(partKey)) {
				throw new SharedPlexItemError();
			}
		}
	}
	return [...matchedShows.values()];
}

class SharedPlexItemError extends Error {}

export function cleanupDeleteTargetKey(
	target: Pick<CleanupDeleteTarget, "instanceId" | "arrItemId" | "itemType">,
): string {
	return `${target.instanceId}:${target.arrItemId}:${target.itemType}`;
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
	radarrPeers?: Array<{
		identity: VerifiedRadarrPeerIdentity;
		movieTags: number[];
		notifications: RadarrNotification[];
	}>;
}

interface PlexVerificationResult {
	block?: string;
	ownership: VerifiedRadarrPlexOwnership[];
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
	if (!peer.identity.file) return null;
	const file = comparableFile(peer.identity.file);
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
	if (matchingNotifications.length === 0 && unusableConfiguredMapping) {
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
	const pathCandidate = [...pathCandidates.values()][0]!;
	const matches = new Map<
		string,
		{
			item: PlexMovieMediaItem;
			part: { file: string; size: number };
			mapping: { from: NormalizedMediaPath; to: NormalizedMediaPath } | null;
		}
	>();
	const mappedFile = { ...file, fullPath: pathCandidate.fullPath };
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
	if (input.files.length === 0) return { ownership };

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
										return { block: mergedItemReason(input.service), ownership };
									}
									retainedPartKeys.add(peerPartKey);
								}
							}
						}
						if (input.radarrPeers?.length && notificationUrl) {
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
							return { block: mergedItemReason(input.service), ownership };
						}
						const unownedParts = targetMatch.item.parts.filter((part) => {
							const partKey = plexPartKey(part);
							return partKey !== targetPartKey && !retainedPartKeys.has(partKey);
						});
						if (retainedPartKeys.size === 0 || unownedParts.length > 0) {
							return { block: mergedItemReason(input.service), ownership };
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
					try {
						matchingPlexSeriesShows(input.files, await mediaPartsPromise, notification);
					} catch (error) {
						if (error instanceof SharedPlexItemError) {
							return { block: mergedItemReason(input.service), ownership };
						}
						throw error;
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
	return { ownership };
}

/**
 * Fail-closed preflight for shared Plex library deletions initiated through
 * either Radarr or Sonarr. The live ARR file set is correlated to exact Plex
 * media parts after applying the target ARR connection's path mapping.
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
			deleteTargets.length === 0
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
	const radarrMovies = new Map<string, Promise<Movie[]>>();
	const radarrPeerFiles = new Map<string, Promise<VerifiedRadarrFileIdentity | null>>();
	const sonarrNotifications = new Map<string, Promise<SonarrNotification[]>>();
	const plexOwnerChecks = new Map<string, Promise<void>>();
	const plexMovieLookups = new Map<SafetyPlexClient, Map<number, Promise<PlexMovieMediaItem[]>>>();
	const plexSeriesLookups = new Map<
		SafetyPlexClient,
		Map<number, Promise<PlexSeriesMediaItem[]>>
	>();

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

	const getRadarrMovies = (
		instance: ServiceInstance,
		client: InstanceType<typeof RadarrClient>,
		tmdbId: number,
	): Promise<Movie[]> => {
		const lookupKey = `${instance.id}:${tmdbId}`;
		let movies = radarrMovies.get(lookupKey);
		if (!movies) {
			movies = client.movie.getAll({ tmdbId });
			radarrMovies.set(lookupKey, movies);
		}
		return movies;
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
				for (const peerInstance of peerInstances) {
					const peerClient = getRadarrClient(peerInstance);
					const peerMovies = (await getRadarrMovies(peerInstance, peerClient, tmdbId)).filter(
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
						continue;
					}
					const peerMovie = peerMovies[0]!;
					const peerMovieId = requiredPositiveSafeInteger(peerMovie.id, "Radarr peer movie ID");
					const peerMovieFileId = peerMovie.movieFileId;
					let peerFile: VerifiedRadarrFileIdentity | null = null;
					if (
						peerMovie.hasFile !== false ||
						(typeof peerMovieFileId === "number" && peerMovieFileId > 0)
					) {
						const verifiedPeerFileId = requiredPositiveSafeInteger(
							peerMovieFileId,
							"Radarr peer movie file ID",
						);
						const peerFileKey = `${peerInstance.id}:${tmdbId}:${verifiedPeerFileId}`;
						let peerFilePromise = radarrPeerFiles.get(peerFileKey);
						if (!peerFilePromise) {
							peerFilePromise = peerClient.movieFile
								.getById(verifiedPeerFileId)
								.then((file) => radarrFileIdentity(peerMovie, file, verifiedPeerFileId));
							radarrPeerFiles.set(peerFileKey, peerFilePromise);
						}
						peerFile = await peerFilePromise;
					}
					radarrPeers.push({
						identity: {
							instanceId: peerInstance.id,
							serviceFingerprint: createArrServiceFingerprint(peerInstance),
							externalId: tmdbId,
							arrItemId: peerMovieId,
							mediaPath: normalizeMediaPath(peerMovie.path),
							file: peerFile,
						},
						movieTags: peerMovie.tags ?? [],
						notifications: await getRadarrNotifications(peerInstance, peerClient),
					});
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
					},
				);
				if (verification.block) {
					blocks.set(targetKey, verification.block);
					context.plans.set(targetKey, { kind: "blocked", reason: verification.block });
				} else {
					context.verifiedRadarrFiles.set(targetKey, targetFile);
					context.plans.set(targetKey, {
						kind: "verified_radarr",
						target: targetIdentity,
						file: targetFile,
						peers: radarrPeers.map((peer) => peer.identity),
						ownership: verification.ownership,
						targetDeleteNotifications: radarrTargetDeleteNotificationWitnesses(
							plexNotifications,
							movie,
						),
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
			if (action === "unmonitor") {
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
			if (otherInstanceMayOwnFile(targetInstance, service, verifiedFiles.episodeFiles.length)) {
				const reason = crossInstanceOwnershipReason(service);
				blocks.set(targetKey, reason);
				context.plans.set(targetKey, { kind: "blocked", reason });
				continue;
			}
			const notifications = (await getSonarrNotifications(targetInstance, sonarr)).filter(
				(notification) => sonarrNotificationApplies(notification, series, action),
			);
			if (notifications.length === 0) {
				context.verifiedSonarrFiles.set(targetKey, verifiedFiles);
				context.plans.set(targetKey, {
					kind: "verified_sonarr",
					target: targetIdentity,
					files: verifiedFiles,
				});
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
					files: verifiedFiles.episodeFiles.map(comparableFile),
				},
			);
			if (verification.block) {
				blocks.set(targetKey, verification.block);
				context.plans.set(targetKey, { kind: "blocked", reason: verification.block });
			} else {
				context.verifiedSonarrFiles.set(targetKey, verifiedFiles);
				context.plans.set(targetKey, {
					kind: "verified_sonarr",
					target: targetIdentity,
					files: verifiedFiles,
				});
			}
		} catch (error) {
			const reason =
				error instanceof FileMatchVerificationError
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

	return blocks;
}
