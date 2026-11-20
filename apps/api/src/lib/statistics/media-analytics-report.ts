import type { MediaAnalyticsReport, TopMediaResponse, TopMediaType } from "@arr/shared";
import { activityCollectionMeasurement } from "../../routes/plex/lib/activity-collection-helpers.js";
import { createBandwidthAnalyticsAccumulator } from "../../routes/plex/lib/bandwidth-analytics-helpers.js";
import { createCodecAnalyticsAccumulator } from "../../routes/plex/lib/codec-analytics-helpers.js";
import { createDeviceAnalyticsAccumulator } from "../../routes/plex/lib/device-analytics-helpers.js";
import { createForecastAccumulator } from "../../routes/plex/lib/forecast-helpers.js";
import { createQualityScoreAccumulator } from "../../routes/plex/lib/quality-score-helpers.js";
import { createTopMediaAccumulator } from "../../routes/plex/lib/top-media-helpers.js";
import { createTranscodeAnalyticsAccumulator } from "../../routes/plex/lib/transcode-analytics-helpers.js";
import { createUserAnalyticsAccumulator } from "../../routes/plex/lib/user-analytics-helpers.js";
import { createWatchHistoryAccumulator } from "../../routes/plex/lib/watch-history-helpers.js";
import type { PrismaClient } from "../prisma.js";
import { readSessionSnapshotReportPages } from "./session-snapshot-pages.js";

const MEDIA_TYPES = ["movie", "series", "music"] as const;
interface ParseDiagnostic {
	metric: string;
	parseFailures: number;
	totalSnapshots: number;
}

/** Reuse existing aggregators; a failed scan never yields a successful partial report. */
export async function readMediaAnalyticsReport(
	prisma: PrismaClient,
	input: {
		userId: string;
		provider: MediaAnalyticsReport["provider"];
		days: number;
		onParseFailure?: (diagnostic: ParseDiagnostic) => void;
	},
): Promise<MediaAnalyticsReport> {
	const assembledAt = new Date();
	const transcode = createTranscodeAnalyticsAccumulator();
	const bandwidth = createBandwidthAnalyticsAccumulator();
	const users = createUserAnalyticsAccumulator();
	const history = createWatchHistoryAccumulator(20);
	const codec = createCodecAnalyticsAccumulator();
	const devices = createDeviceAnalyticsAccumulator();
	const quality = createQualityScoreAccumulator();
	const forecast = createForecastAccumulator();
	const media = MEDIA_TYPES.map((type) => ({ type, accumulator: createTopMediaAccumulator(type) }));
	const read = await readSessionSnapshotReportPages(prisma, {
		userId: input.userId,
		services: input.provider === "plex" ? ["PLEX"] : ["JELLYFIN", "EMBY"],
		cutoff: new Date(assembledAt.getTime() - input.days * 86_400_000),
		onChronologicalPage(page) {
			transcode.addSnapshots(page);
			bandwidth.addSnapshots(page);
			users.addSnapshots(page);
			codec.addSnapshots(page);
			devices.addSnapshots(page);
			quality.addBatch(page);
			forecast.addSnapshots(page);
		},
		onReverseChronologicalPage(page) {
			history.addBatch(page);
			for (const entry of media) entry.accumulator.addBatch(page);
		},
	});

	function publicResult<
		T extends { parseFailures: number; totalSnapshots: number; failedPreviews?: unknown },
	>(value: T, metric: string) {
		const { parseFailures, totalSnapshots, failedPreviews: _privatePreviews, ...result } = value;
		if (parseFailures > 0) input.onParseFailure?.({ metric, parseFailures, totalSnapshots });
		return result;
	}
	function withSources<T extends { measurement?: object }>(value: T) {
		if (!value.measurement) return value;
		return {
			...value,
			measurement: { ...value.measurement, configuredSources: read.instanceCount },
		};
	}
	// Existing activity routes do not expose daily collection data in this DTO.
	const activity = activityCollectionMeasurement({ ...read, collectionByDate: undefined });
	const topMedia = {} as Record<TopMediaType, TopMediaResponse>;
	const popularMedia = {} as Record<TopMediaType, TopMediaResponse>;
	for (const { type, accumulator } of media) {
		topMedia[type] = {
			...publicResult(accumulator.getResult("top", 10), `top-${type}`),
			measurement: activity,
		};
		popularMedia[type] = {
			...publicResult(accumulator.getResult("popular", 10), `popular-${type}`),
			measurement: activity,
		};
	}
	const deviceResult = withSources(publicResult(devices.getResult(read.collection), "devices"));
	return {
		version: 1,
		provider: input.provider,
		days: input.days,
		generatedAt: assembledAt.toISOString(),
		transcode: withSources(
			publicResult(transcode.getResult(read.collection, read.collectionByDate), "transcode"),
		),
		bandwidth: withSources(
			publicResult(bandwidth.getResult(read.collection, read.collectionByDate), "bandwidth"),
		),
		userAnalytics: withSources(
			publicResult(users.getResult(read.collection, read.collectionByDate), "users"),
		),
		watchHistory: { ...publicResult(history.getResult(), "history"), measurement: activity },
		codec: withSources(publicResult(codec.getResult(read.collection), "codec")),
		devices: {
			...deviceResult,
			measurement: {
				...deviceResult.measurement,
				platformAxis: input.provider === "jellyfin" ? "client" : "platform",
			},
		},
		qualityScore: withSources(
			publicResult(quality.getResult(read.collection, read.collectionByDate), "quality-score"),
		),
		forecast: withSources(forecast.getResult(7, read.collection, read.collectionByDate)),
		topMedia,
		popularMedia,
	};
}
