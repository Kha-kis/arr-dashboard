import type { BandwidthForecast, QualityScoreAnalytics } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { Sparkline } from "../chart-primitives";
import { ForecastChart } from "../forecast-chart";
import { QualityScoreChart } from "../quality-score-chart";

const forecast: BandwidthForecast = {
	historicalDaily: [
		{ date: "2026-09-01", avgBandwidth: 100, peakBandwidth: 200 },
		{ date: "2026-09-02", avgBandwidth: 120, peakBandwidth: 240 },
		{ date: "2026-09-03", avgBandwidth: 140, peakBandwidth: 280 },
	],
	forecast: [
		{ date: "2026-09-04", predictedPeak: 300 },
		{ date: "2026-09-05", predictedPeak: 320 },
	],
	peakHours: [],
	trend: "increasing",
};

const quality: QualityScoreAnalytics = {
	overallScore: 84,
	breakdown: { directPlayScore: 90, resolutionScore: 80, transcodeScore: 82 },
	trend: [
		{ date: "2026-09-01", score: 78 },
		{ date: "2026-09-02", score: 84 },
	],
	perUser: [],
};

function withProviders(ui: React.ReactNode) {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>{ui}</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

function expectResponsiveSvg(svg: SVGSVGElement, viewBox: string, height: string) {
	expect(svg).toHaveAttribute("width", "100%");
	expect(svg).toHaveAttribute("height", height);
	expect(svg).toHaveAttribute("viewBox", viewBox);
	expect(svg).toHaveAttribute("preserveAspectRatio", "none");
	expect(svg).toHaveClass("block", "max-w-full");
}

describe("responsive populated statistics charts", () => {
	it("fits the populated shared Sparkline into its parent without changing logical coordinates", () => {
		const { container } = render(
			<div style={{ width: 260 }}>
				<Sparkline data={[10, 30, 20]} color="#38bdf8" fillColor="#38bdf8" />
			</div>,
		);

		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		expectResponsiveSvg(svg!, "0 0 280 60", "60");
		expect(svg?.querySelector("path")).toHaveAttribute("d", expect.stringContaining("280,60"));
	});

	it("fits the populated ForecastLine into its parent without cropping forecast data", () => {
		withProviders(<ForecastChart data={forecast} isLoading={false} isError={false} />);

		const svg = document.querySelector<SVGSVGElement>('svg[height="80"]');
		expect(svg).not.toBeNull();
		expectResponsiveSvg(svg!, "0 0 600 80", "80");
		expect(svg?.querySelectorAll("path")[2]).toHaveAttribute("d", expect.stringContaining("600,"));
		expect(screen.getByText("2026-09-05")).toBeInTheDocument();
	});

	it("fits the populated TrendSparkline into its parent without cropping the trend", () => {
		withProviders(<QualityScoreChart data={quality} isLoading={false} isError={false} />);

		const svg = document.querySelector<SVGSVGElement>('svg[height="50"]');
		expect(svg).not.toBeNull();
		expectResponsiveSvg(svg!, "0 0 600 50", "50");
		expect(svg?.querySelector("path")).toHaveAttribute("d", expect.stringContaining("600,50"));
		expect(screen.getByText("2026-09-02")).toBeInTheDocument();
	});
});
