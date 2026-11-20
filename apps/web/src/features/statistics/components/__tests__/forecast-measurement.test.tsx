import type { BandwidthForecast, ForecastMeasurementSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinBandwidthForecast } from "../../../../hooks/api/useJellyfin";
import { useBandwidthForecast } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ForecastChart } from "../forecast-chart";

function measurement(
	overrides: Partial<ForecastMeasurementSummary> = {},
): ForecastMeasurementSummary {
	return {
		version: 1,
		status: "complete",
		bandwidthBasis: "provider-reported",
		observedSessions: 2,
		measuredSessions: 2,
		observedSnapshots: 2,
		measuredSnapshots: 2,
		completeTotalSnapshots: 2,
		eligibleDays: 2,
		projectionStatus: "available",
		configuredSources: 1,
		collection: {
			activeSnapshots: 2,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
		...overrides,
	};
}
function data(overrides: Partial<BandwidthForecast> = {}): BandwidthForecast {
	return {
		historicalDaily: [
			{
				date: "2026-10-01",
				avgBandwidth: 100,
				peakBandwidth: 100,
				avgKnownSubtotal: 100,
				peakKnownSubtotal: 100,
			},
			{
				date: "2026-10-03",
				avgBandwidth: 300,
				peakBandwidth: 300,
				avgKnownSubtotal: 300,
				peakKnownSubtotal: 300,
			},
		],
		forecast: [{ date: "2026-10-04", predictedPeak: 400 }],
		peakHours: [],
		trend: "increasing",
		measurement: measurement(),
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

describe("forecast measurement truth and presentation", () => {
	it("retains one-day partial known subtotals when a complete-total projection is unavailable", () => {
		providers(
			<ForecastChart
				data={data({
					historicalDaily: [
						{
							date: "2026-10-01",
							avgBandwidth: null,
							peakBandwidth: null,
							avgKnownSubtotal: 100,
							peakKnownSubtotal: 100,
						},
					],
					forecast: [],
					trend: "unknown",
					measurement: measurement({
						status: "partial",
						measuredSessions: 1,
						completeTotalSnapshots: 0,
						eligibleDays: 0,
						projectionStatus: "insufficient-data",
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/projection unavailable.*two.*complete/i)).toBeInTheDocument();
		expect(screen.getByRole("list", { name: "Daily bandwidth observations" })).toHaveTextContent(
			/100 kbps/,
		);
		expect(
			screen.getByRole("list", { name: "Daily bandwidth observations" }).closest("details"),
		).toHaveAttribute("open");
		expect(screen.getByText(/known subtotals.*not complete totals/i)).toBeInTheDocument();
		expect(screen.queryByText(/stable/i)).not.toBeInTheDocument();
	});
	it("discloses estimated rates, coverage, and per-source sampling instead of network capacity", () => {
		providers(
			<ForecastChart
				service="jellyfin"
				data={data({ measurement: measurement({ bandwidthBasis: "encoding-estimate" }) })}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(
			screen.getByText(/encoding estimate.*not measured network traffic/i),
		).toBeInTheDocument();
		expect(screen.getByText(/2 of 2.*session observations.*known rates/i)).toBeInTheDocument();
		expect(
			screen.getByText(/sampled peaks.*not.*continuous.*simultaneous.*guarantee/i),
		).toBeInTheDocument();
	});
	it("keeps cached observations visible during refetch loading", () => {
		providers(<ForecastChart data={data()} isLoading isError={false} />);
		expect(screen.getByRole("list", { name: "Daily bandwidth observations" })).toHaveTextContent(
			"300 kbps",
		);
	});
	it("keeps an old API projection unverified rather than presenting a certified trend", () => {
		providers(
			<ForecastChart
				data={data({ measurement: undefined, trend: "stable" })}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/legacy.*unverified/i)).toBeInTheDocument();
		expect(screen.queryByText(/stable|300 kbps|400 kbps/i)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: "Sampled bandwidth peaks and projection" }),
		).not.toBeInTheDocument();
	});
	it("distinguishes verified zero rates from unknown daily rates", () => {
		providers(
			<ForecastChart
				data={data({
					historicalDaily: [
						{
							date: "2026-10-01",
							avgBandwidth: 0,
							peakBandwidth: 0,
							avgKnownSubtotal: 0,
							peakKnownSubtotal: 0,
						},
						{
							date: "2026-10-02",
							avgBandwidth: null,
							peakBandwidth: null,
							avgKnownSubtotal: null,
							peakKnownSubtotal: null,
						},
					],
					forecast: [],
					trend: "unknown",
					measurement: measurement({ projectionStatus: "insufficient-data", eligibleDays: 1 }),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const rows = within(
			screen.getByRole("list", { name: "Daily bandwidth observations" }),
		).getAllByRole("listitem");
		expect(rows[0]).toHaveTextContent("0 kbps");
		expect(rows[1]).toHaveTextContent(/unknown/i);
		expect(rows[1]).not.toHaveTextContent("0 kbps");
	});
	it("positions days by calendar time and does not bridge an unknown day", () => {
		providers(<ForecastChart data={data()} isLoading={false} isError={false} />);
		const graph = screen.getByRole("img", { name: "Sampled bandwidth peaks and projection" });
		expect(graph).toHaveAttribute("viewBox", "0 0 600 80");
		expect(graph).toHaveAttribute("aria-description", expect.stringMatching(/gaps.*unknown/i));
		const historical = graph.querySelectorAll("path")[1]!;
		expect(historical.getAttribute("d")?.match(/M/g)).toHaveLength(2);
		expect(historical.getAttribute("d")).toContain("400,");
		expect(historical.getAttribute("d")).not.toContain("L");
		expect(graph.querySelectorAll("path")[2]).toHaveAttribute("d", expect.stringContaining("600,"));
	});
	it("positions sparse hours on all24 UTC slots and distinguishes missing hours from zero", () => {
		providers(
			<ForecastChart
				data={data({
					peakHours: [
						{ hour: 5, avgConcurrent: 1, avgBandwidth: 0, avgKnownSubtotal: 0 },
						{ hour: 20, avgConcurrent: 2, avgBandwidth: null, avgKnownSubtotal: 150 },
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const rows = within(
			screen.getByRole("list", { name: "Hourly bandwidth observations (UTC)" }),
		).getAllByRole("listitem");
		expect(rows).toHaveLength(24);
		expect(rows[5]).toHaveAccessibleName(/5:00 UTC.*0 kbps/i);
		expect(rows[20]).toHaveAccessibleName(/20:00 UTC.*known subtotal.*150 kbps/i);
		expect(rows[6]).toHaveAccessibleName(/6:00 UTC.*unknown/i);
		expect(rows[6]).not.toHaveAccessibleName(/0 kbps/);
	});
	it("discloses failed, legacy, invalid and idle collection without dropping useful history", () => {
		providers(
			<ForecastChart
				data={data({
					measurement: measurement({
						status: "partial",
						collection: {
							activeSnapshots: 2,
							failedSnapshots: 3,
							legacySnapshots: 4,
							invalidSnapshots: 1,
							idleSnapshots: 5,
						},
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/3 failed.*4 legacy.*1 invalid.*5 idle/i)).toBeInTheDocument();
		expect(screen.getByRole("list", { name: "Daily bandwidth observations" })).toHaveTextContent(
			"300 kbps",
		);
	});
	it.each([
		{ sources: 0, idle: 0, failed: 0, expected: /no configured/i },
		{ sources: 1, idle: 0, failed: 0, expected: /no observations.*scheduler/i },
		{ sources: 1, idle: 2, failed: 0, expected: /successful idle/i },
		{ sources: 1, idle: 0, failed: 2, expected: /collection failed.*settings/i },
		{ sources: 1, idle: 2, failed: 2, expected: /some samples failed/i },
	])("distinguishes collection-only window $expected", ({ sources, idle, failed, expected }) => {
		providers(
			<ForecastChart
				data={data({
					historicalDaily: [],
					forecast: [],
					trend: "unknown",
					measurement: measurement({
						status: "unavailable",
						observedSessions: 0,
						measuredSessions: 0,
						observedSnapshots: 0,
						measuredSnapshots: 0,
						completeTotalSnapshots: 0,
						eligibleDays: 0,
						projectionStatus: "insufficient-data",
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
		expect(screen.getByText(expected)).toBeInTheDocument();
	});
	it("makes an initial request failure actionable", () => {
		providers(<ForecastChart data={undefined} isLoading={false} isError />);
		expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
	});
	it("does not fit or display a single line across mixed rate bases", () => {
		providers(
			<ForecastChart
				data={data({
					measurement: measurement({ bandwidthBasis: "mixed", projectionStatus: "mixed-basis" }),
					trend: "unknown",
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/mixed.*bases.*cannot.*combined/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: "Sampled bandwidth peaks and projection" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/stable|increasing/i)).not.toBeInTheDocument();
	});
});

function HookPanel({ service }: { service: "plex" | "jellyfin" }) {
	const plex = useBandwidthForecast(30, service === "plex");
	const jellyfin = useJellyfinBandwidthForecast(30, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<ForecastChart
			service={service}
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
		/>
	);
}
describe("real forecast hooks and transport recovery", () => {
	it.each(["plex", "jellyfin"] as const)(
		"retains last-known %s history after503 and replaces it on200",
		async (service) => {
			let outcome: "initial" | "failed" | "recovered" = "initial";
			vi.stubGlobal("fetch", async (url: string) => {
				if (url !== `/api/${service}/analytics/forecast?days=30`)
					throw new Error("Unexpected fixture route");
				if (outcome === "failed")
					return new Response(JSON.stringify({ error: "PRIVATE_FAILURE_BODY" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				const value = data({
					measurement: measurement({
						bandwidthBasis: service === "plex" ? "provider-reported" : "encoding-estimate",
					}),
					...(outcome === "recovered"
						? {
								historicalDaily: [
									{
										date: "2026-10-05",
										avgBandwidth: 500,
										peakBandwidth: 500,
										peakKnownSubtotal: 500,
									},
								],
								forecast: [],
								trend: "unknown",
							}
						: {}),
				});
				return new Response(JSON.stringify(value), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
			const queryKey =
				service === "plex" ? plexKeys.bandwidthForecast(30) : jellyfinKeys.bandwidthForecast(30);
			try {
				providers(<HookPanel service={service} />, client);
				await screen.findByRole("list", { name: "Daily bandwidth observations" });
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(
					screen.getByRole("list", { name: "Daily bandwidth observations" }),
				).toHaveTextContent("300 kbps");
				expect(screen.queryByText(/PRIVATE_FAILURE_BODY/)).not.toBeInTheDocument();
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(
						screen.getByRole("list", { name: "Daily bandwidth observations" }),
					).toHaveTextContent("500 kbps"),
				);
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
				expect(
					screen.getByRole("list", { name: "Daily bandwidth observations" }),
				).not.toHaveTextContent("300 kbps");
			} finally {
				client.clear();
			}
		},
	);
});
