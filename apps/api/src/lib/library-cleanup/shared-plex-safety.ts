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
	plexOwnerChecks: Map<string, Promise<void>>;
	failedPlexConnections: Set<string>;
	verifiedRadarrFiles: Map<string, VerifiedRadarrFileIdentity>;
	verifiedSonarrFiles: Map<string, VerifiedSonarrFileIdentity>;
	plans: Map<string, SharedMediaSafetyPlan>;
}

export function createSharedPlexSafetyContext(): SharedPlexSafetyContext {
	return {
		plexClients: new Map(),
		plexOwnerChecks: new Map(),
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
		const file = candidate.file as Record<string, unknown> | undefined;
		if (!file) throw new FileMatchVerificationError("Radarr safety snapshot is invalid");
		return {
			kind: "verified_radarr",
			target: canonicalTargetIdentity(candidate.target),
			file: {
				movieFileId: requiredPositiveSafeInteger(file.movieFileId, "Radarr movie file ID"),
				fullPath: normalizeMediaPath((file.fullPath as Record<string, unknown> | undefined)?.value),
				size: requiredPositiveSafeInteger(file.size, "Radarr movie file size"),
			},
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

export class ArrTargetChangedDuringSafetyCheckError extends ArrFileChangedDuringSafetyCheckError {
	constructor() {
		super(
			"Skipped for safety: the ARR target changed during live verification. Run cleanup again before mutating it.",
		);
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
): PlexMovieMediaItem[] {
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
		return matches[0]!.item;
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

	let ownerCheck = context.plexOwnerChecks.get(fingerprint);
	if (!ownerCheck) {
		ownerCheck = plex.getAccounts().then(() => undefined);
		context.plexOwnerChecks.set(fingerprint, ownerCheck);
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
}

async function verifyPlexMediaState(
	deps: CleanupExecutorDeps,
	context: SharedPlexSafetyContext,
	plexInstances: ServiceInstance[],
	movieLookups: Map<SafetyPlexClient, Map<number, Promise<PlexMovieMediaItem[]>>>,
	seriesLookups: Map<SafetyPlexClient, Map<number, Promise<PlexSeriesMediaItem[]>>>,
	input: PlexVerificationInput,
): Promise<string | undefined> {
	if (input.files.length === 0) return undefined;

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
				plex = await requirePlexClient(deps, context, plexInstance);
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
					const matchedItems = matchingPlexItems(
						input.files,
						await mediaPartsPromise,
						notification,
						input.service,
					);
					if (matchedItems.some((item) => item.parts.length > 1)) {
						return mergedItemReason(input.service);
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
							return mergedItemReason(input.service);
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
	return undefined;
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
	verifiedInstances?: ServiceInstance[],
	context: SharedPlexSafetyContext = createSharedPlexSafetyContext(),
): Promise<Map<string, string>> {
	const safetyTargets = targets.filter(isSafetyTarget);
	const deleteTargets = targets.filter(isDestructiveTarget);
	const blocks = new Map<string, string>();
	if (safetyTargets.length === 0) return blocks;

	let instances: ServiceInstance[];
	let plexInstances: ServiceInstance[];
	try {
		instances = verifiedInstances
			? verifiedInstances.filter(
					(instance) =>
						instance.userId === userId &&
						(instance.service === "RADARR" || instance.service === "SONARR"),
				)
			: await deps.prisma.serviceInstance.findMany({
					where: {
						id: { in: [...new Set(safetyTargets.map((target) => target.instanceId))] },
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
					};
				}
				const notifications = (await radarr.notification.getAll()).filter((notification) =>
					radarrNotificationApplies(notification, movie, action),
				);
				if (notifications.length === 0) {
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
				const targetFile = verifiedPlan.file;
				const block = await verifyPlexMediaState(
					deps,
					context,
					plexInstances,
					plexMovieLookups,
					plexSeriesLookups,
					{
						service,
						target,
						notifications: plexNotifications,
						externalId: tmdbId,
						files: [comparableFile(targetFile)],
					},
				);
				if (block) {
					blocks.set(targetKey, block);
					context.plans.set(targetKey, { kind: "blocked", reason: block });
				} else {
					context.verifiedRadarrFiles.set(targetKey, targetFile);
					context.plans.set(targetKey, {
						kind: "verified_radarr",
						target: targetIdentity,
						file: targetFile,
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
			const notifications = (await sonarr.notification.getAll()).filter((notification) =>
				sonarrNotificationApplies(notification, series, action),
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
			const block = await verifyPlexMediaState(
				deps,
				context,
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
			if (block) {
				blocks.set(targetKey, block);
				context.plans.set(targetKey, { kind: "blocked", reason: block });
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
