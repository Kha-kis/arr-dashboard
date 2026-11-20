import { arrPolicyEvidenceFromRaw } from "../library-cleanup/arr-policy-evidence.js";
import type { CacheItemForEval } from "../library-cleanup/types.js";

/** Normalize only evaluation evidence; never use this projection as a PUT body. */
export function normalizeLiveMovieFile(file: Record<string, unknown>): Record<string, unknown> {
	const info =
		typeof file.mediaInfo === "object" && file.mediaInfo !== null && !Array.isArray(file.mediaInfo)
			? (file.mediaInfo as Record<string, unknown>)
			: {};
	const normalized = { ...file };
	for (const key of ["videoCodec", "audioCodec", "resolution", "videoDynamicRange"] as const) {
		const direct = file[key];
		const nested = info[key];
		normalized[key] =
			typeof direct === "string" && direct.trim()
				? direct
				: typeof nested === "string" && nested.trim()
					? nested
					: undefined;
	}
	if (!normalized.resolution) {
		if (typeof info.screenSize === "string" && info.screenSize.trim())
			normalized.resolution = info.screenSize;
		else if (
			typeof info.width === "number" &&
			Number.isFinite(info.width) &&
			info.width > 0 &&
			typeof info.height === "number" &&
			Number.isFinite(info.height) &&
			info.height > 0
		)
			normalized.resolution = `${info.width}x${info.height}`;
	}
	return normalized;
}

export function adaptLiveArrItemForAutoTag(
	raw: Record<string, unknown>,
	target: {
		instanceId: string;
		arrItemId: number;
		itemType: "movie" | "series";
	},
): CacheItemForEval {
	if (raw.id !== target.arrItemId) {
		throw new Error("Live ARR item identity did not match the auto-tag target");
	}
	if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
		throw new Error("Live ARR item title was unavailable at the auto-tag write boundary");
	}

	const service = target.itemType === "series" ? "sonarr" : "radarr";
	const statistics =
		typeof raw.statistics === "object" && raw.statistics !== null && !Array.isArray(raw.statistics)
			? (raw.statistics as Record<string, unknown>)
			: null;
	const rawSize = target.itemType === "series" ? statistics?.sizeOnDisk : raw.sizeOnDisk;
	const sizeOnDisk =
		typeof rawSize === "number" && Number.isSafeInteger(rawSize) && rawSize >= 0
			? BigInt(rawSize)
			: 0n;
	const addedAt = typeof raw.added === "string" ? new Date(raw.added) : null;
	const nestedQualityProfile =
		typeof raw.qualityProfile === "object" &&
		raw.qualityProfile !== null &&
		!Array.isArray(raw.qualityProfile)
			? (raw.qualityProfile as Record<string, unknown>)
			: null;
	const nestedQualityProfileName =
		typeof nestedQualityProfile?.name === "string" ? nestedQualityProfile.name : null;
	const monitored = typeof raw.monitored === "boolean" ? raw.monitored : true;
	const hasFile =
		target.itemType === "movie"
			? typeof raw.hasFile === "boolean"
				? raw.hasFile
				: false
			: typeof statistics?.episodeFileCount === "number"
				? statistics.episodeFileCount > 0
				: false;

	return {
		id: `live-auto-tag:${target.instanceId}:${target.itemType}:${target.arrItemId}`,
		instanceId: target.instanceId,
		arrItemId: target.arrItemId,
		itemType: target.itemType,
		title: raw.title,
		year: typeof raw.year === "number" ? raw.year : null,
		monitored,
		hasFile,
		status: typeof raw.status === "string" ? raw.status : null,
		qualityProfileId: typeof raw.qualityProfileId === "number" ? raw.qualityProfileId : null,
		qualityProfileName:
			typeof raw.profileName === "string" ? raw.profileName : nestedQualityProfileName,
		sizeOnDisk,
		arrAddedAt: addedAt && !Number.isNaN(addedAt.getTime()) ? addedAt : null,
		data: JSON.stringify({
			...raw,
			...(target.itemType === "movie" &&
			typeof raw.movieFile === "object" &&
			raw.movieFile !== null &&
			!Array.isArray(raw.movieFile)
				? { movieFile: normalizeLiveMovieFile(raw.movieFile as Record<string, unknown>) }
				: {}),
			service,
			_arrDashboardEvidence: arrPolicyEvidenceFromRaw(raw, service),
		}),
	};
}
