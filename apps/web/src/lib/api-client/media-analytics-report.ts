import type { MediaAnalyticsReport } from "@arr/shared";
import { apiRequest } from "./base";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchMediaAnalyticsReport(
	provider: MediaAnalyticsReport["provider"],
	days: number,
	signal?: AbortSignal,
): Promise<MediaAnalyticsReport> {
	const report = await apiRequest<unknown>(`/api/${provider}/analytics/report?days=${days}`, {
		signal,
		expectedSuccessStatus: 200,
		requireJsonSuccess: true,
	});
	// Validate the envelope and scope before publishing any section. Individual
	// metric DTOs retain their existing contracts; this is not nested schema validation.
	if (
		!isRecord(report) ||
		report.version !== 1 ||
		report.provider !== provider ||
		report.days !== days ||
		typeof report.generatedAt !== "string" ||
		![
			"transcode",
			"bandwidth",
			"userAnalytics",
			"watchHistory",
			"codec",
			"devices",
			"qualityScore",
			"forecast",
		].every((section) => isRecord(report[section])) ||
		!["topMedia", "popularMedia"].every((section) => {
			const media = report[section];
			return isRecord(media) && ["movie", "series", "music"].every((type) => isRecord(media[type]));
		})
	) {
		throw new Error("Statistics report response could not be verified.");
	}
	return report as unknown as MediaAnalyticsReport;
}
