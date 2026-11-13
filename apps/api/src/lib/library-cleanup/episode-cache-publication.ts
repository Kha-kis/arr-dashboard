import { monitoringSourceWhere } from "../library/monitoring-confirmation.js";
import { buildSeriesItem } from "../library/series-normalizer.js";
import type { ServiceInstance } from "../prisma.js";
import {
	assertVerifiedArrTargetUnchanged,
	createArrServiceFingerprint,
	type ExecutableSharedMediaSafetyPlan,
} from "./shared-plex-safety.js";
import type { CleanupExecutorDeps } from "./types.js";

export const EPISODE_CACHE_PUBLICATION_WARNING =
	"The confirmed episode-file removal was recorded, but the Library cache could not be verified or updated. Run a normal Library refresh before relying on its file totals.";

type EpisodePlan = Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr_episode" }>;
type PublicationResult = { published: true } | { published: false; warning: string };
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid object");
	return value as Record<string, unknown>;
};
const count = (value: unknown): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid observation count");
	return value;
};
const positive = (value: unknown): number => {
	const number = count(value);
	if (number === 0) throw new Error("Invalid observation identity");
	return number;
};
const array = (value: unknown): unknown[] => {
	if (!Array.isArray(value)) throw new Error("Missing observation inventory");
	return value;
};

/** Read-model repair only: this helper never establishes mutation authority or retries a write. */
export async function publishSonarrEpisodeDeletion(
	options: Pick<CleanupExecutorDeps, "prisma" | "log" | "arrClientFactory"> & {
		instance: ServiceInstance;
		arrItemId: number;
		plan: EpisodePlan;
		deletedFileIds: number[];
	},
): Promise<PublicationResult> {
	const { prisma, instance, arrItemId, plan, deletedFileIds } = options;
	try {
		if (
			instance.service !== "SONARR" ||
			!positive(arrItemId) ||
			deletedFileIds.length !== 1 ||
			positive(deletedFileIds[0]) !== plan.selectedFile.episodeFileId
		)
			throw new Error("Invalid publication scope");
		const source = monitoringSourceWhere(instance);
		const where = {
			instanceId: instance.id,
			arrItemId,
			itemType: "series" as const,
			instance: source,
		};
		// Capture before HTTP, and compare the exact preimage after HTTP in the transaction.
		const cached = await prisma.libraryCache.findFirst({ where });
		if (!cached) throw new Error("Missing parent projection");
		const prior = object(JSON.parse(cached.data));
		if (
			prior.id !== arrItemId ||
			object(prior._arrDashboardSource).serviceFingerprint !== createArrServiceFingerprint(instance)
		)
			throw new Error("Invalid cached source");
		assertVerifiedArrTargetUnchanged(
			instance,
			object(prior.remoteIds).tvdbId,
			prior.path,
			plan.target,
		);
		const client = options.arrClientFactory.createSonarrClient(instance);
		const series = object(await client.series.getById(arrItemId));
		const files = array(await client.episodeFile.getBySeries(arrItemId)).map(object);
		if (series.id !== arrItemId) throw new Error("Invalid current series");
		assertVerifiedArrTargetUnchanged(instance, series.tvdbId, series.path, plan.target);
		const stats = object(series.statistics);
		const size = count(stats.sizeOnDisk),
			fileCount = count(stats.episodeFileCount);
		const seasons = array(series.seasons).map(object);
		const oldSeasons = array(prior.seasons).map(object);
		const oldStats = object(prior.statistics);
		const seenFiles = new Set<number>(),
			seenSeasons = new Set<number>();
		const sizes = new Map<number, number>();
		for (const file of files) {
			const id = positive(file.id),
				season = count(file.seasonNumber);
			if (
				seenFiles.has(id) ||
				deletedFileIds.includes(id) ||
				file.seriesId !== arrItemId ||
				typeof file.path !== "string" ||
				!file.path.trim() ||
				file.path.includes("\0") ||
				!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(file.path)
			)
				throw new Error("Invalid file inventory");
			seenFiles.add(id);
			sizes.set(season, count((sizes.get(season) ?? 0) + count(file.size)));
		}
		let observedSize = 0,
			observedFiles = 0;
		for (const season of seasons) {
			const number = count(season.seasonNumber),
				seasonStats = object(season.statistics);
			if (seenSeasons.has(number)) throw new Error("Duplicate season");
			seenSeasons.add(number);
			const seasonSize = count(seasonStats.sizeOnDisk),
				seasonFiles = count(seasonStats.episodeFileCount);
			const total = count(seasonStats.totalEpisodeCount ?? seasonStats.episodeCount);
			if (
				seasonFiles > total ||
				seasonSize !== (sizes.get(number) ?? 0) ||
				(seasonFiles === 0) !== !files.some((file) => file.seasonNumber === number)
			)
				throw new Error("Contradictory season inventory");
			observedSize = count(observedSize + seasonSize);
			observedFiles = count(observedFiles + seasonFiles);
		}
		if (
			[...sizes.keys()].some((number) => !seenSeasons.has(number)) ||
			observedSize !== size ||
			observedFiles !== fileCount ||
			(fileCount === 0) !== (files.length === 0)
		)
			throw new Error("Contradictory series inventory");
		if (stats.totalEpisodeCount !== undefined && fileCount > count(stats.totalEpisodeCount))
			throw new Error("Contradictory episode count");
		if (stats.episodeCount !== undefined) count(stats.episodeCount);
		const oldNumbers = new Set(oldSeasons.map((season) => count(season.seasonNumber)));
		if (
			oldNumbers.size !== oldSeasons.length ||
			oldNumbers.size !== seenSeasons.size ||
			[...oldNumbers].some((number) => !seenSeasons.has(number))
		)
			throw new Error("Incomplete season projection");
		// Preserve cached monitoring and total-episode metadata; normalize only the observed file facts.
		const normalized = buildSeriesItem(instance, "sonarr", {
			...series,
			seasons: seasons.map((season) => {
				const old = oldSeasons.find((row) => row.seasonNumber === season.seasonNumber)!;
				if (typeof old.monitored !== "boolean") throw new Error("Invalid cached season");
				return {
					...season,
					monitored: old.monitored,
					statistics: { ...object(season.statistics), totalEpisodeCount: count(old.episodeCount) },
				};
			}),
		});
		const data = JSON.stringify({
			...prior,
			hasFile: normalized.hasFile,
			sizeOnDisk: normalized.sizeOnDisk,
			statistics: { ...oldStats, episodeFileCount: normalized.statistics?.episodeFileCount },
			seasons: oldSeasons.map((old) => {
				const observed = normalized.seasons?.find((row) => row.seasonNumber === old.seasonNumber);
				if (!observed) throw new Error("Missing normalized season");
				return {
					...old,
					episodeFileCount: observed.episodeFileCount,
					missingEpisodeCount: observed.missingEpisodeCount,
				};
			}),
		});
		await prisma.$transaction(async (tx) => {
			const changed = await tx.libraryCache.updateMany({
				where: { ...where, id: cached.id, data: cached.data, updatedAt: cached.updatedAt },
				data: { hasFile: normalized.hasFile!, sizeOnDisk: BigInt(size), data },
			});
			if (changed.count !== 1) throw new Error("Projection/source changed during observation");
			await tx.episodeFileCache.deleteMany({
				where: {
					instanceId: instance.id,
					arrSeriesId: arrItemId,
					arrEpisodeFileId: { in: deletedFileIds },
					instance: source,
				},
			});
		});
		return { published: true };
	} catch {
		// Do not expose provider bodies, credentials, paths or titles in action feedback.
		options.log.warn("Confirmed episode deletion cache publication could not be verified");
		return { published: false, warning: EPISODE_CACHE_PUBLICATION_WARNING };
	}
}
