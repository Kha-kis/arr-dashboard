import type { SessionMethodMeasurementSummary, TranscodeAnalytics } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinTranscodeAnalytics } from "../../../../hooks/api/useJellyfin";
import { useTranscodeAnalytics } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { TranscodeChart } from "../transcode-chart";

function measurement(
	overrides: Partial<SessionMethodMeasurementSummary> = {},
): SessionMethodMeasurementSummary {
	return {
		version: 1,
		methodAxis: "video",
		status: "partial",
		observedSessions: 6,
		measuredSessions: 4,
		invalidDetailSnapshots: 0,
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
function data(overrides: Partial<TranscodeAnalytics> = {}): TranscodeAnalytics {
	return {
		directPlay: 2,
		directStream: 1,
		transcode: 1,
		unknown: 2,
		totalSessions: 6,
		measurement: measurement(),
		dailyBreakdown: [
			{ date: "2026-10-04", directPlay: 2, directStream: 1, transcode: 1, unknown: 1 },
			{ date: "2026-10-05", directPlay: 0, directStream: 0, transcode: 0, unknown: 1 },
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

describe("native video processing measurement presentation", () => {
	it("retains missing calendar days as unsampled gaps rather than adjacent observations", () => {
		const { container } = providers(
			<TranscodeChart
				data={data({
					dailyBreakdown: [
						{ date: "2026-10-01", directPlay: 1, directStream: 0, transcode: 0, unknown: 0 },
						{ date: "2026-10-03", directPlay: 1, directStream: 0, transcode: 0, unknown: 0 },
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(container.querySelectorAll('[title^="2026-10-"]')).toHaveLength(3);
		expect(screen.getByTitle(/2026-10-02: no observations/i)).toBeInTheDocument();
	});
	it("keeps unknown observations in the chart and qualifies known-only percentages", () => {
		providers(<TranscodeChart data={data()} isLoading={false} isError={false} />);
		expect(screen.getByText("Video Processing")).toBeInTheDocument();
		expect(screen.getByText(/4 of 6.*session observations/i)).toBeInTheDocument();
		expect(screen.getByText(/50%.*known video decisions/i)).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: /2 direct play.*1 direct stream.*1 transcode.*2 unknown/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: /daily video processing.*unknown/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/audio-only transcoding.*video copy/i)).toBeInTheDocument();
		expect(screen.getByText(/not continuous.*history/i)).toBeInTheDocument();
	});
	it("describes mixed idle and failed samples in a daily video processing tooltip", () => {
		const dailyMeasurement = measurement();
		providers(
			<TranscodeChart
				data={data({
					dailyBreakdown: [
						{ date: "2026-10-04", directPlay: 2, directStream: 1, transcode: 1, unknown: 2 },
						{
							date: "2026-10-05",
							directPlay: 0,
							directStream: 0,
							transcode: 0,
							unknown: 0,
							measurement: {
								...dailyMeasurement,
								status: "unavailable",
								observedSessions: 0,
								measuredSessions: 0,
								collection: {
									...dailyMeasurement.collection,
									activeSnapshots: 0,
									idleSnapshots: 2,
									failedSnapshots: 1,
								},
							},
						},
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(
			screen.getByTitle(/2026-10-05: some samples failed.*no observed video decisions/i),
		).toBeInTheDocument();
	});
	it("retains observed activity when every method is unknown instead of claiming no data or a zero rate", () => {
		providers(
			<TranscodeChart
				data={data({
					directPlay: 0,
					directStream: 0,
					transcode: 0,
					unknown: 6,
					dailyBreakdown: [],
					measurement: measurement({ status: "unavailable", measuredSessions: 0 }),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByRole("img", { name: /6 unknown/i })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /6 unknown/i }).querySelectorAll("circle")).toHaveLength(
			1,
		);
		expect(screen.getByText(/direct play rate: unknown/i)).toBeInTheDocument();
		expect(screen.getByText(/check.*settings/i)).toBeInTheDocument();
		expect(screen.queryByText(/0%.*direct play/i)).not.toBeInTheDocument();
		expect(screen.queryByText("No Transcode Data Yet")).not.toBeInTheDocument();
	});
	it("does not certify legacy API scalar categories or claim a direct-play rate", () => {
		providers(
			<TranscodeChart
				data={data({ measurement: undefined, unknown: undefined })}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/legacy.*unverified/i)).toBeInTheDocument();
		expect(
			screen.getByRole("img", { name: /0 direct play.*0 direct stream.*0 transcode.*6 unknown/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/direct play rate: unknown/i)).toBeInTheDocument();
	});
	it("discloses failed, legacy, invalid, and invalid-detail coverage alongside usable evidence", () => {
		providers(
			<TranscodeChart
				data={data({
					measurement: measurement({
						invalidDetailSnapshots: 2,
						collection: {
							activeSnapshots: 3,
							idleSnapshots: 1,
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
		expect(screen.getByText(/2 failed.*4 legacy.*1 invalid.*1 idle/i)).toBeInTheDocument();
		expect(screen.getByText(/2.*invalid.*detail/i)).toBeInTheDocument();
		expect(screen.getByText(/4 of 6.*session observations/i)).toBeInTheDocument();
	});
	it.each([
		{ label: /no configured/i, sources: 0, idle: 0, failed: 0 },
		{ label: /no observations/i, sources: 1, idle: 0, failed: 0 },
		{ label: /successful idle/i, sources: 1, idle: 2, failed: 0 },
		{ label: /collection failed/i, sources: 1, idle: 0, failed: 2 },
		{ label: /some samples failed/i, sources: 1, idle: 2, failed: 2 },
	])("distinguishes empty collection state $label", ({ label, sources, idle, failed }) => {
		providers(
			<TranscodeChart
				data={data({
					directPlay: 0,
					directStream: 0,
					transcode: 0,
					unknown: 0,
					totalSessions: 0,
					dailyBreakdown: [],
					measurement: measurement({
						status: "unavailable",
						observedSessions: 0,
						measuredSessions: 0,
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
		expect(screen.getByText(/direct play rate: unknown/i)).toBeInTheDocument();
	});
	it("renders initial request failure as actionable unavailable", () => {
		providers(<TranscodeChart data={undefined} isLoading={false} isError />);
		expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
		expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
	});
});

function HookPanel({ service }: { service: "plex" | "jellyfin" }) {
	const plex = useTranscodeAnalytics(30, service === "plex");
	const jellyfin = useJellyfinTranscodeAnalytics(30, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<TranscodeChart
			service={service}
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
		/>
	);
}
describe("real video processing hooks, transport and recovery", () => {
	it.each(["plex", "jellyfin"] as const)(
		"retains last-known %s observations on 503 and replaces them on recovery",
		async (service) => {
			let outcome: "initial" | "failed" | "recovered" = "initial";
			vi.stubGlobal("fetch", async (url: string) => {
				if (url !== `/api/${service}/analytics/transcode?days=30`)
					throw new Error("Unexpected test route");
				if (outcome === "failed")
					return new Response(JSON.stringify({ error: "Unavailable" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				return new Response(
					JSON.stringify(
						outcome === "initial" ? data() : data({ directPlay: 3, directStream: 0, transcode: 1 }),
					),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});
			const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
			const queryKey =
				service === "plex" ? plexKeys.transcodeAnalytics(30) : jellyfinKeys.transcodeAnalytics(30);
			try {
				providers(<HookPanel service={service} />, client);
				await waitFor(() =>
					expect(screen.getByText(/50%.*known video decisions/i)).toBeInTheDocument(),
				);
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(screen.getByText(/50%.*known video decisions/i)).toBeInTheDocument();
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/75%.*known video decisions/i)).toBeInTheDocument(),
				);
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
			} finally {
				cleanup();
				client.clear();
			}
		},
	);
});
