import type { CodecAnalytics, CodecAnalyticsMeasurementSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinCodecAnalytics } from "../../../../hooks/api/useJellyfin";
import { useCodecAnalytics } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { CodecChart } from "../codec-chart";

function measurement(
	overrides: Partial<CodecAnalyticsMeasurementSummary> = {},
): CodecAnalyticsMeasurementSummary {
	return {
		version: 1,
		status: "partial",
		observedSessions: 3,
		videoCodecMeasuredSessions: 1,
		audioCodecMeasuredSessions: 2,
		resolutionMeasuredSessions: 2,
		invalidDetailSnapshots: 0,
		configuredSources: 1,
		collection: {
			activeSnapshots: 1,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
		...overrides,
	};
}
function data(overrides: Partial<CodecAnalytics> = {}): CodecAnalytics {
	return {
		totalSessions: 3,
		measurement: measurement(),
		videoCodecs: [
			{ codec: "unknown", count: 2, percent: 66.7 },
			{ codec: "h264", count: 1, percent: 33.3 },
		],
		audioCodecs: [
			{ codec: "aac", count: 2, percent: 66.7 },
			{ codec: "unknown", count: 1, percent: 33.3 },
		],
		resolutions: [
			{ resolution: "1080", count: 2, percent: 66.7 },
			{ resolution: "unknown", count: 1, percent: 33.3 },
		],
		...overrides,
	};
}
function providers(ui: React.ReactNode, client?: QueryClient) {
	const content = (
		<ColorThemeProvider>
			<IncognitoProvider>{ui}</IncognitoProvider>
		</ColorThemeProvider>
	);
	return render(
		client ? <QueryClientProvider client={client}>{content}</QueryClientProvider> : content,
	);
}
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("codec observation coverage presentation", () => {
	it("keeps the complete donut stroke inside its viewport", () => {
		providers(<CodecChart data={data()} isLoading={false} isError={false} />);
		const graph = screen.getByRole("img", { name: /video codecs/i });
		for (const circle of graph.querySelectorAll("circle")) {
			const radius = Number(circle.getAttribute("r"));
			const halfStroke = Number(circle.getAttribute("stroke-width")) / 2;
			for (const [coordinate, bound] of [
				["cx", "width"],
				["cy", "height"],
			] as const) {
				const center = Number(circle.getAttribute(coordinate));
				expect(center - radius - halfStroke).toBeGreaterThanOrEqual(0);
				expect(center + radius + halfStroke).toBeLessThanOrEqual(Number(graph.getAttribute(bound)));
			}
		}
	});
	it("does not blank cached observations while a request is loading", () => {
		providers(<CodecChart data={data()} isLoading isError={false} />);
		expect(screen.getByRole("img", { name: /video codecs.*3 observations/i })).toBeInTheDocument();
		expect(screen.getByText("h264")).toBeInTheDocument();
	});
	it("keeps unknown categories in denominators and reports independent field coverage", () => {
		providers(<CodecChart data={data()} isLoading={false} isError={false} />);
		expect(
			screen.getByText(/video codec.*1 of 3.*audio codec.*2 of 3.*resolution.*2 of 3/i),
		).toBeInTheDocument();
		expect(screen.getByText(/sample observations.*not.*continuous.*history/i)).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: /video codecs.*3 observations.*2 unknown.*1 h264/i }),
		).toBeInTheDocument();
	});
	it("conserves smaller codec categories instead of changing the donut denominator", () => {
		providers(
			<CodecChart
				data={data({
					totalSessions: 8,
					measurement: measurement({
						status: "complete",
						observedSessions: 8,
						videoCodecMeasuredSessions: 8,
						audioCodecMeasuredSessions: 8,
						resolutionMeasuredSessions: 8,
					}),
					videoCodecs: Array.from({ length: 8 }, (_, i) => ({
						codec: `c${i}`,
						count: 1,
						percent: 12.5,
					})),
					audioCodecs: [{ codec: "aac", count: 8, percent: 100 }],
					resolutions: [{ resolution: "1080", count: 8, percent: 100 }],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const graph = screen.getByRole("img", {
			name: /video codecs.*8 observations.*3 other codecs/i,
		});
		expect(graph.querySelectorAll("circle")).toHaveLength(6);
		expect(screen.getByText("Other codecs")).toBeInTheDocument();
		const firstDash = graph
			.querySelector("circle")!
			.getAttribute("stroke-dasharray")!
			.split(" ")
			.map(Number);
		expect(firstDash[0]! / (firstDash[0]! + firstDash[1]!)).toBeCloseTo(1 / 8);
	});
	it("retains all resolution categories and avoids an invented p suffix for dimensions or SD", () => {
		providers(
			<CodecChart
				data={data({
					totalSessions: 8,
					measurement: measurement({
						observedSessions: 8,
						videoCodecMeasuredSessions: 0,
						audioCodecMeasuredSessions: 0,
						resolutionMeasuredSessions: 7,
					}),
					videoCodecs: [{ codec: "unknown", count: 8, percent: 100 }],
					audioCodecs: [{ codec: "unknown", count: 8, percent: 100 }],
					resolutions: ["1920x1080", "sd", "unknown", "2160", "720", "480", "360", "240"].map(
						(resolution) => ({ resolution, count: 1, percent: 12.5 }),
					),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText("1920x1080")).toBeInTheDocument();
		expect(screen.getByText("SD")).toBeInTheDocument();
		expect(screen.getByText("240p")).toBeInTheDocument();
		expect(screen.queryByText(/1920x1080p|sdp/)).not.toBeInTheDocument();
	});
	it("keeps legacy API distributions unverified instead of certifying their categories", () => {
		providers(
			<CodecChart data={data({ measurement: undefined })} isLoading={false} isError={false} />,
		);
		expect(screen.getByText(/legacy.*unverified/i)).toBeInTheDocument();
		expect(screen.queryByText("h264")).not.toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: /video codecs.*3 observations.*3 unknown/i }),
		).toBeInTheDocument();
	});
	it("discloses failed, legacy and invalid collection beside usable measurements", () => {
		providers(
			<CodecChart
				data={data({
					measurement: measurement({
						invalidDetailSnapshots: 2,
						collection: {
							activeSnapshots: 1,
							idleSnapshots: 3,
							failedSnapshots: 2,
							legacySnapshots: 4,
							invalidSnapshots: 1,
						},
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/2 failed.*4 legacy.*1 invalid.*3 idle/i)).toBeInTheDocument();
		expect(screen.getByText(/2.*invalid.*detail/i)).toBeInTheDocument();
	});
	it.each([
		{ label: /no configured/i, sources: 0, idle: 0, failed: 0 },
		{ label: /no observations/i, sources: 1, idle: 0, failed: 0 },
		{ label: /successful idle/i, sources: 1, idle: 2, failed: 0 },
		{ label: /collection failed/i, sources: 1, idle: 0, failed: 2 },
		{ label: /some samples failed/i, sources: 1, idle: 2, failed: 2 },
	])("distinguishes empty collection $label", ({ label, sources, idle, failed }) => {
		providers(
			<CodecChart
				data={data({
					totalSessions: 0,
					videoCodecs: [],
					audioCodecs: [],
					resolutions: [],
					measurement: measurement({
						status: "unavailable",
						observedSessions: 0,
						videoCodecMeasuredSessions: 0,
						audioCodecMeasuredSessions: 0,
						resolutionMeasuredSessions: 0,
						configuredSources: sources,
						collection: {
							activeSnapshots: 0,
							idleSnapshots: idle,
							failedSnapshots: failed,
							legacySnapshots: 0,
							invalidSnapshots: 0,
						},
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(label)).toBeInTheDocument();
	});
	it("makes initial failure actionable without exposing provider error details", () => {
		providers(<CodecChart data={undefined} isLoading={false} isError />);
		expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
	});
});

function HookPanel({ service }: { service: "plex" | "jellyfin" }) {
	const plex = useCodecAnalytics(30, service === "plex");
	const jellyfin = useJellyfinCodecAnalytics(30, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<CodecChart
			service={service}
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
		/>
	);
}
describe("real codec hooks and transport recovery", () => {
	it.each(["plex", "jellyfin"] as const)(
		"retains labelled last-known %s distributions on503 and recovers",
		async (service) => {
			let outcome: "initial" | "failed" | "recovered" = "initial";
			vi.stubGlobal("fetch", async (url: string) => {
				if (url !== `/api/${service}/analytics/codec?days=30`)
					throw new Error("Unexpected fixture route");
				if (outcome === "failed")
					return new Response(JSON.stringify({ error: "PRIVATE_DETAILS" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				return new Response(
					JSON.stringify(
						outcome === "recovered"
							? data({
									videoCodecs: [{ codec: "av1", count: 3, percent: 100 }],
									measurement: measurement({ videoCodecMeasuredSessions: 3 }),
								})
							: data(),
					),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});
			const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
			const queryKey =
				service === "plex" ? plexKeys.codecAnalytics(30) : jellyfinKeys.codecAnalytics(30);
			try {
				providers(<HookPanel service={service} />, client);
				await screen.findByText("h264");
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(screen.getByText("h264")).toBeInTheDocument();
				expect(screen.queryByText(/PRIVATE_DETAILS/)).not.toBeInTheDocument();
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await screen.findByText("av1");
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
				expect(screen.queryByText("h264")).not.toBeInTheDocument();
			} finally {
				client.clear();
			}
		},
	);
});
