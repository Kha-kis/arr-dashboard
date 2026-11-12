import type { BandwidthAnalytics, BandwidthMeasurementSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinBandwidthAnalytics } from "../../../../hooks/api/useJellyfin";
import { useBandwidthAnalytics } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BandwidthChart } from "../bandwidth-chart";
import { Sparkline } from "../chart-primitives";

function measurement(
	overrides: Partial<BandwidthMeasurementSummary> = {},
): BandwidthMeasurementSummary {
	return {
		version: 1,
		status: "complete",
		bandwidthBasis: "provider-reported",
		observedSessions: 1,
		measuredSessions: 1,
		observedSnapshots: 1,
		measuredSnapshots: 1,
		collection: {
			activeSnapshots: 1,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
		configuredSources: 1,
		...overrides,
	};
}

function data(overrides: Partial<BandwidthAnalytics> = {}): BandwidthAnalytics {
	return {
		peakConcurrent: 1,
		peakBandwidth: 1000,
		avgBandwidth: 1000,
		timeSeries: [
			{
				date: "2026-10-05",
				concurrent: 1,
				bandwidth: overrides.avgBandwidth === undefined ? 1000 : overrides.avgBandwidth,
				lanBandwidth: null,
				wanBandwidth: null,
			},
		],
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

describe("historical bandwidth measurement presentation", () => {
	it.each(["failed", "empty"] as const)(
		"renders unknown concurrency for a %s collection rather than a blank or false zero",
		(kind) => {
			providers(
				<BandwidthChart
					data={data({
						peakConcurrent: null,
						peakBandwidth: null,
						avgBandwidth: null,
						timeSeries: [],
						measurement: measurement({
							status: "unavailable",
							bandwidthBasis: null,
							observedSessions: 0,
							observedSnapshots: 0,
							measuredSessions: 0,
							measuredSnapshots: 0,
							collection: {
								activeSnapshots: 0,
								idleSnapshots: 0,
								failedSnapshots: kind === "failed" ? 1 : 0,
								legacySnapshots: 0,
								invalidSnapshots: 0,
							},
						}),
					})}
					isLoading={false}
					isError={false}
				/>,
			);
			expect(screen.getByText("Peak Observed Concurrent").closest(".rounded-xl")).toHaveTextContent(
				"Unknown",
			);
		},
	);
	it("shows observed idle zero independently from unknown active rates", () => {
		providers(
			<BandwidthChart
				data={data({
					peakConcurrent: 0,
					peakBandwidth: null,
					avgBandwidth: null,
					timeSeries: [],
					measurement: measurement({
						status: "unavailable",
						bandwidthBasis: null,
						observedSessions: 0,
						observedSnapshots: 0,
						measuredSessions: 0,
						measuredSnapshots: 0,
						collection: {
							activeSnapshots: 0,
							idleSnapshots: 1,
							failedSnapshots: 0,
							legacySnapshots: 0,
							invalidSnapshots: 0,
						},
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText("Peak Observed Concurrent").closest(".rounded-xl")).toHaveTextContent(
			/0$/,
		);
		expect(screen.getAllByText("Unknown")).toHaveLength(2);
	});
	it("preserves explicit measured zero instead of hiding it as no data", () => {
		providers(
			<BandwidthChart
				data={data({ peakBandwidth: 0, avgBandwidth: 0 })}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getAllByText("0 kbps")).toHaveLength(2);
		expect(screen.queryByText("No Bandwidth Data Yet")).not.toBeInTheDocument();
		expect(screen.getByText(/provider-reported/i)).toBeInTheDocument();
	});

	it("displays unknown rates without hiding observed activity or inventing zero", () => {
		providers(
			<BandwidthChart
				data={data({
					peakBandwidth: null,
					avgBandwidth: null,
					measurement: measurement({
						status: "unavailable",
						measuredSessions: 0,
						measuredSnapshots: 0,
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getAllByText("Unknown")).toHaveLength(2);
		expect(screen.queryByText("0 kbps")).not.toBeInTheDocument();
		expect(screen.getByText(/0 of 1.*session observations/i)).toBeInTheDocument();
		expect(screen.getByText(/check.*settings/i)).toBeInTheDocument();
	});

	it("qualifies the known subtotal and active-sample denominator for partial estimates", () => {
		providers(
			<BandwidthChart
				service="jellyfin"
				data={data({
					measurement: measurement({
						status: "partial",
						bandwidthBasis: "encoding-estimate",
						observedSessions: 3,
						measuredSessions: 1,
						observedSnapshots: 2,
						measuredSnapshots: 1,
						collection: {
							activeSnapshots: 2,
							idleSnapshots: 4,
							failedSnapshots: 1,
							legacySnapshots: 2,
							invalidSnapshots: 1,
						},
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/encoding estimate/i)).toBeInTheDocument();
		expect(screen.getByText(/1 of 3.*session observations/i)).toBeInTheDocument();
		expect(screen.getByText(/known subtotal/i)).toBeInTheDocument();
		expect(screen.getByText(/1 of 2.*active snapshots/i)).toBeInTheDocument();
		expect(screen.getByText(/1 failed.*2 legacy.*1 invalid/i)).toBeInTheDocument();
		expect(screen.getByText(/not continuous.*history/i)).toBeInTheDocument();
	});

	it("marks old API measurements unverified and does not claim LAN/WAN authority", () => {
		providers(
			<BandwidthChart
				data={data({
					measurement: undefined,
					timeSeries: [
						{
							date: "2026-10-04",
							concurrent: 1,
							bandwidth: 1000,
							lanBandwidth: 600,
							wanBandwidth: 400,
						},
						{
							date: "2026-10-05",
							concurrent: 1,
							bandwidth: 1000,
							lanBandwidth: 600,
							wanBandwidth: 400,
						},
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/legacy.*unverified/i)).toBeInTheDocument();
		expect(screen.queryByText("LAN Bandwidth")).not.toBeInTheDocument();
		expect(screen.queryByText("WAN Bandwidth")).not.toBeInTheDocument();
	});

	it.each([
		{
			label: /no configured/i,
			configuredSources: 0,
			counts: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
		{
			label: /no observations/i,
			configuredSources: 1,
			counts: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
		{
			label: /successful idle/i,
			configuredSources: 1,
			counts: {
				activeSnapshots: 0,
				idleSnapshots: 2,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
		{
			label: /collection failed/i,
			configuredSources: 1,
			counts: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 2,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
		{
			label: /some samples failed.*no active-stream bandwidth measurements/i,
			configuredSources: 1,
			counts: {
				activeSnapshots: 0,
				idleSnapshots: 2,
				failedSnapshots: 2,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
	])(
		"distinguishes collection state $label without presenting missing rate as zero",
		({ label, configuredSources, counts }) => {
			providers(
				<BandwidthChart
					data={data({
						peakConcurrent: counts.idleSnapshots > 0 ? 0 : null,
						peakBandwidth: null,
						avgBandwidth: null,
						timeSeries: [],
						measurement: measurement({
							status: "unavailable",
							bandwidthBasis: null,
							observedSessions: 0,
							measuredSessions: 0,
							observedSnapshots: 0,
							measuredSnapshots: 0,
							configuredSources,
							collection: counts,
						}),
					})}
					isLoading={false}
					isError={false}
				/>,
			);
			expect(screen.getByText(label)).toBeInTheDocument();
			expect(screen.queryByText("0 kbps")).not.toBeInTheDocument();
			expect(screen.getByText("Peak Observed Concurrent").closest(".rounded-xl")).toHaveTextContent(
				counts.idleSnapshots > 0 ? /0$/ : "Unknown",
			);
		},
	);

	it("renders initial request failure as actionable unavailable, not a healthy empty result", () => {
		providers(<BandwidthChart data={undefined} isLoading={false} isError />);
		expect(screen.getByText("Failed to Load Bandwidth Data")).toBeInTheDocument();
		expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
	});

	it("breaks the rate line at unknown observations without converting them to zero or bridging", () => {
		const { container } = render(
			<Sparkline data={[10, null, 20, 30]} width={300} color="red" fillColor="red" />,
		);
		const line = container.querySelector('path[fill="none"]');
		expect(screen.getByRole("img", { name: /gaps indicate unknown data/i })).toBeInTheDocument();
		expect(line).toHaveAttribute("d", expect.stringMatching(/^M0,[\d.]+ M200,[\d.]+ L300,4$/));
		expect(container.querySelectorAll("circle")).toHaveLength(2);
		expect(container.querySelector('path[fill="red"]')).toHaveAttribute(
			"d",
			expect.not.stringContaining("L100,"),
		);
	});

	it("does not draw an all-unknown rate line", () => {
		const { container } = render(<Sparkline data={[null, null]} color="red" />);
		expect(container.querySelector("svg")).toBeNull();
	});

	it("leaves missing calendar days unknown rather than bridging daily observations", () => {
		const { container } = providers(
			<BandwidthChart
				data={data({
					peakBandwidth: 20,
					avgBandwidth: 15,
					measurement: measurement({
						observedSessions: 2,
						measuredSessions: 2,
						observedSnapshots: 2,
						measuredSnapshots: 2,
						collection: {
							activeSnapshots: 2,
							idleSnapshots: 0,
							failedSnapshots: 0,
							legacySnapshots: 0,
							invalidSnapshots: 0,
						},
					}),
					timeSeries: [
						{
							date: "2026-10-01",
							concurrent: 1,
							bandwidth: 10,
							lanBandwidth: null,
							wanBandwidth: null,
						},
						{
							date: "2026-10-03",
							concurrent: 1,
							bandwidth: 20,
							lanBandwidth: null,
							wanBandwidth: null,
						},
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const svg = container.querySelector('svg[height="60"]');
		expect(svg?.querySelector('path[fill="none"]')).toHaveAttribute(
			"d",
			expect.stringMatching(/^M0,[\d.]+ M600,4$/),
		);
		expect(svg?.querySelectorAll("circle")).toHaveLength(2);
	});
});

function HookPanel({ service }: { service: "plex" | "jellyfin" }) {
	const plex = useBandwidthAnalytics(30, service === "plex");
	const jellyfin = useJellyfinBandwidthAnalytics(30, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<BandwidthChart
			service={service}
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
		/>
	);
}

describe("real bandwidth hooks, transport, and refetch recovery", () => {
	it.each(["plex", "jellyfin"] as const)(
		"retains and labels last-known %s data on failure, then replaces it on recovery",
		async (service) => {
			let outcome: "initial" | "failed" | "recovered" = "initial";
			const expectedUrl = `/api/${service}/analytics/bandwidth?days=30`;
			vi.stubGlobal("fetch", async (url: string) => {
				if (url !== expectedUrl) throw new Error("Unexpected test route");
				if (outcome === "failed")
					return new Response(JSON.stringify({ error: "Unavailable" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				return new Response(
					JSON.stringify(
						data({
							peakBandwidth: outcome === "recovered" ? 2000 : 1000,
							avgBandwidth: outcome === "recovered" ? 2000 : 1000,
						}),
					),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});
			const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
			try {
				providers(<HookPanel service={service} />, client);
				await waitFor(() => expect(screen.getAllByText("1.0 Mbps")).toHaveLength(2));
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({
						queryKey:
							service === "plex"
								? plexKeys.bandwidthAnalytics(30)
								: jellyfinKeys.bandwidthAnalytics(30),
					});
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(screen.getAllByText("1.0 Mbps")).toHaveLength(2);
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({
						queryKey:
							service === "plex"
								? plexKeys.bandwidthAnalytics(30)
								: jellyfinKeys.bandwidthAnalytics(30),
					});
				});
				await waitFor(() => expect(screen.getAllByText("2.0 Mbps")).toHaveLength(2));
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
			} finally {
				cleanup();
				client.clear();
			}
		},
	);
});
