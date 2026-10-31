import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { PlexTab } from "../plex-tab";

const mockServicesQuery = vi.hoisted(() => vi.fn());

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: mockServicesQuery,
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#2563eb" } }),
}));

vi.mock("../../../../hooks/api/usePlex", () => {
	const query = () => ({ data: undefined, isLoading: false, isError: false });
	return {
		useLastWatched: query,
		useMostConcurrent: query,
		usePlaysByDate: query,
		useBandwidthAnalytics: query,
		useBandwidthForecast: query,
		useCodecAnalytics: query,
		useDeviceAnalytics: query,
		usePopularMedia: query,
		useQualityScore: query,
		useTopMedia: query,
		useTranscodeAnalytics: query,
		useUserAnalytics: query,
		useWatchHistory: query,
	};
});

vi.mock("../bandwidth-chart", () => ({ BandwidthChart: () => null }));
vi.mock("../codec-chart", () => ({ CodecChart: () => null }));
vi.mock("../device-chart", () => ({ DeviceChart: () => null }));
vi.mock("../forecast-chart", () => ({ ForecastChart: () => null }));
vi.mock("../quality-score-chart", () => ({ QualityScoreChart: () => null }));
vi.mock("../top-media-chart", () => ({ TopMediaChart: () => null }));
vi.mock("../transcode-chart", () => ({ TranscodeChart: () => null }));
vi.mock("../user-analytics-chart", () => ({ UserAnalyticsChart: () => null }));
vi.mock("../watch-history-widget", () => ({ WatchHistoryWidget: () => null }));

afterEach(() => {
	cleanup();
	mockServicesQuery.mockReset();
});

describe("Plex statistics source banner", () => {
	it("describes enabled Tautulli as optional rather than verified-active enrichment", () => {
		mockServicesQuery.mockReturnValue({
			data: [{ service: "tautulli", enabled: true }],
		});
		render(
			<IncognitoProvider>
				<PlexTab />
			</IncognitoProvider>,
		);

		expect(screen.getByText(/Tautulli is configured as optional enrichment/i)).toBeInTheDocument();
		expect(screen.queryByText(/Tautulli enrichment active/i)).not.toBeInTheDocument();
	});

	it("does not claim Tautulli enrichment when the source is disabled", () => {
		mockServicesQuery.mockReturnValue({
			data: [{ service: "tautulli", enabled: false }],
		});
		render(
			<IncognitoProvider>
				<PlexTab />
			</IncognitoProvider>,
		);

		expect(screen.queryByText(/Tautulli.*enrichment/i)).not.toBeInTheDocument();
	});
});
