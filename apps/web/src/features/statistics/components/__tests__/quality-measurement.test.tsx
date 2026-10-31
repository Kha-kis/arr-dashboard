import type { QualityScoreAnalytics, QualityScoreMeasurementSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinQualityScore } from "../../../../hooks/api/useJellyfin";
import { useQualityScore } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QualityScoreChart } from "../quality-score-chart";

function measurement(
	overrides: Partial<QualityScoreMeasurementSummary> = {},
): QualityScoreMeasurementSummary {
	return {
		version: 1,
		methodAxis: "video",
		status: "partial",
		observedSessions: 3,
		methodMeasuredSessions: 2,
		resolutionMeasuredSessions: 2,
		scoredSessions: 1,
		invalidDetailSnapshots: 0,
		unattributedSessions: 0,
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
const unavailable = { directPlayScore: null, resolutionScore: null, transcodeScore: null };
function data(overrides: Partial<QualityScoreAnalytics> = {}): QualityScoreAnalytics {
	return {
		overallScore: 93,
		breakdown: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
		components: { directPlayScore: 50, resolutionScore: 75, transcodeScore: 100 },
		measurement: measurement(),
		trend: [{ date: "2026-10-05", score: 93 }],
		perUser: [],
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

describe("native video/resolution quality measurement presentation", () => {
	it("explains matched-cohort score and independent component coverage without equating them", () => {
		providers(<QualityScoreChart data={data()} isLoading={false} isError={false} />);
		expect(screen.getByRole("img", { name: /overall: 93 out of 100/i })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /direct play: 50 out of 100/i })).toBeInTheDocument();
		expect(screen.getByText(/1 of 3.*jointly.*score/i)).toBeInTheDocument();
		expect(screen.getByText(/2 of 3.*video.*2 of 3.*resolution/i)).toBeInTheDocument();
		expect(screen.getByText(/40%.*30%.*30%/i)).toBeInTheDocument();
		expect(screen.getByText(/heuristic.*not.*playback/i)).toBeInTheDocument();
	});
	it("keeps composite unknown for disjoint evidence while rendering known independent components", () => {
		providers(
			<QualityScoreChart
				data={data({
					overallScore: null,
					breakdown: unavailable,
					measurement: measurement({
						status: "unavailable",
						observedSessions: 2,
						methodMeasuredSessions: 1,
						resolutionMeasuredSessions: 1,
						scoredSessions: 0,
					}),
					components: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByRole("img", { name: /overall: unknown/i })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /resolution: 75 out of 100/i })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /direct play: 100 out of 100/i })).toBeInTheDocument();
		expect(screen.getByText(/composite.*unavailable.*known components/i)).toBeInTheDocument();
	});
	it("does not render missing resolution as SD or unknown methods as healthy low transcoding", () => {
		providers(
			<QualityScoreChart
				data={data({
					overallScore: null,
					breakdown: unavailable,
					components: unavailable,
					measurement: measurement({
						status: "unavailable",
						methodMeasuredSessions: 0,
						resolutionMeasuredSessions: 0,
						scoredSessions: 0,
					}),
					trend: [{ date: "2026-10-05", score: null }],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByRole("img", { name: /resolution: unknown/i })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /low transcode: unknown/i })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /overall: unknown/i })).toBeInTheDocument();
		expect(screen.queryByText("No Quality Data Yet")).not.toBeInTheDocument();
		expect(screen.getByText(/check.*settings/i)).toBeInTheDocument();
	});
	it("marks old API scores unverified instead of displaying authoritative numeric gauges", () => {
		providers(
			<QualityScoreChart
				data={data({ measurement: undefined, components: undefined })}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/legacy.*unverified/i)).toBeInTheDocument();
		expect(screen.getByRole("img", { name: /overall: unknown/i })).toBeInTheDocument();
		expect(screen.queryByText("93")).not.toBeInTheDocument();
	});
	it("breaks the trend at unknown scores and missing calendar days", () => {
		const { container } = providers(
			<QualityScoreChart
				data={data({
					trend: [
						{ date: "2026-10-01", score: 93 },
						{ date: "2026-10-03", score: null },
						{ date: "2026-10-05", score: 8 },
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const trend = screen.getByRole("img", { name: /quality.*trend.*gaps indicate unknown/i });
		expect(trend.querySelector('path[fill="none"]')).toHaveAttribute(
			"d",
			expect.stringMatching(/^M0,4 M600,[\d.]+$/),
		);
		expect(trend.querySelectorAll("circle")).toHaveLength(2);
		expect(container.querySelectorAll('svg[height="50"]')).toHaveLength(1);
	});
	it("retains separately keyed same-name users and qualifies their scored observation counts", () => {
		providers(
			<QualityScoreChart
				data={data({
					perUser: [
						{
							key: "source-a-user",
							username: "Synthetic same name",
							score: 93,
							sessions: 3,
							coverage: {
								observedSessions: 3,
								methodMeasuredSessions: 2,
								resolutionMeasuredSessions: 2,
								scoredSessions: 1,
							},
						},
						{
							key: "source-b-user",
							username: "Synthetic same name",
							score: null,
							sessions: 2,
							coverage: {
								observedSessions: 2,
								methodMeasuredSessions: 0,
								resolutionMeasuredSessions: 1,
								scoredSessions: 0,
							},
						},
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getAllByText("Synthetic same name")).toHaveLength(2);
		expect(screen.getByText(/1 of 3 scored/i)).toBeInTheDocument();
		expect(screen.getByText(/0 of 2 scored/i)).toBeInTheDocument();
	});
	it.each([
		{ label: /no configured/i, sources: 0, idle: 0, failed: 0 },
		{ label: /no observations/i, sources: 1, idle: 0, failed: 0 },
		{ label: /successful idle/i, sources: 1, idle: 2, failed: 0 },
		{ label: /collection failed/i, sources: 1, idle: 0, failed: 2 },
	])("distinguishes empty quality collection state $label", ({ label, sources, idle, failed }) => {
		providers(
			<QualityScoreChart
				data={data({
					overallScore: null,
					breakdown: unavailable,
					components: unavailable,
					trend: [],
					measurement: measurement({
						status: "unavailable",
						observedSessions: 0,
						methodMeasuredSessions: 0,
						resolutionMeasuredSessions: 0,
						scoredSessions: 0,
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
		expect(screen.getByRole("img", { name: /overall: unknown/i })).toBeInTheDocument();
	});
	it("renders initial failure as actionable unavailable", () => {
		providers(<QualityScoreChart data={undefined} isLoading={false} isError />);
		expect(screen.getByText("Failed to Load Quality Score")).toBeInTheDocument();
		expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
	});
});
function HookPanel({ service }: { service: "plex" | "jellyfin" }) {
	const plex = useQualityScore(30, service === "plex");
	const jellyfin = useJellyfinQualityScore(30, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<QualityScoreChart
			service={service}
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
		/>
	);
}
describe("real quality hooks, transport and recovery", () => {
	it.each(["plex", "jellyfin"] as const)(
		"retains labeled last-known %s score on 503 and replaces it on recovery",
		async (service) => {
			let outcome: "initial" | "failed" | "recovered" = "initial";
			vi.stubGlobal("fetch", async (url: string) => {
				if (url !== `/api/${service}/analytics/quality-score?days=30`)
					throw new Error("Unexpected test route");
				if (outcome === "failed")
					return new Response(JSON.stringify({ error: "Unavailable" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				return new Response(
					JSON.stringify(
						data({
							overallScore: outcome === "recovered" ? 8 : 93,
							breakdown:
								outcome === "recovered"
									? { directPlayScore: 0, resolutionScore: 25, transcodeScore: 0 }
									: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
						}),
					),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});
			const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
			const queryKey =
				service === "plex" ? plexKeys.qualityScore(30) : jellyfinKeys.qualityScore(30);
			try {
				providers(<HookPanel service={service} />, client);
				await waitFor(() =>
					expect(screen.getByRole("img", { name: /overall: 93 out of 100/i })).toBeInTheDocument(),
				);
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(screen.getByRole("img", { name: /overall: 93 out of 100/i })).toBeInTheDocument();
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByRole("img", { name: /overall: 8 out of 100/i })).toBeInTheDocument(),
				);
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
			} finally {
				cleanup();
				client.clear();
			}
		},
	);
});
