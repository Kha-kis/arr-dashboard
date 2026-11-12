import type { UserAnalytics, UserAnalyticsMeasurementSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinUserAnalytics } from "../../../../hooks/api/useJellyfin";
import { useUserAnalytics } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { UserAnalyticsChart } from "../user-analytics-chart";

function measurement(
	overrides: Partial<UserAnalyticsMeasurementSummary> = {},
): UserAnalyticsMeasurementSummary {
	return {
		version: 1,
		attribution: "source-provider-user-id",
		status: "partial",
		observedSessions: 3,
		attributedSessions: 2,
		unattributedSessions: 1,
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
function data(overrides: Partial<UserAnalytics> = {}): UserAnalytics {
	return {
		users: [
			{
				key: "source-one",
				username: "Synthetic same name",
				totalSessions: 1,
				totalBandwidth: null,
				estimatedWatchTimeMinutes: 5,
				mostRecentActivity: "2026-10-05T12:00:00Z",
				avgBandwidth: 0,
				bandwidthMeasurement: {
					version: 1,
					bandwidthBasis: "provider-reported",
					status: "complete",
					observedSessions: 1,
					measuredSessions: 1,
				},
			},
			{
				key: "source-two",
				username: "Synthetic same name",
				totalSessions: 1,
				totalBandwidth: null,
				estimatedWatchTimeMinutes: 5,
				mostRecentActivity: "2026-10-05T12:00:00Z",
				avgBandwidth: null,
				bandwidthMeasurement: {
					version: 1,
					bandwidthBasis: "encoding-estimate",
					status: "unavailable",
					observedSessions: 1,
					measuredSessions: 0,
				},
			},
		],
		dailyBreakdown: [
			{
				date: "2026-10-05",
				userSessions: { "source-one": 1, "source-two": 1 },
				measurement: measurement(),
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

describe("source-scoped sampled user activity", () => {
	it("keeps same-name users separate and distinguishes zero from missing rates", () => {
		providers(<UserAnalyticsChart data={data()} isLoading={false} isError={false} />);
		expect(screen.getAllByText("Synthetic same name")).toHaveLength(2);
		expect(
			screen.getByRole("list", { name: /source-scoped sampled users/i }).children,
		).toHaveLength(2);
		expect(screen.getByText(/2 of 3.*attributed/i)).toBeInTheDocument();
		expect(screen.getByText(/1.*unattributed/i)).toBeInTheDocument();
		expect(screen.getByText(/0 kbps.*1 of 1/i)).toBeInTheDocument();
		expect(screen.getByText(/rate unknown.*0 of 1/i)).toBeInTheDocument();
		expect(screen.getByText(/five-minute.*not.*continuous/i)).toBeInTheDocument();
		expect(screen.getByText(/sample-weighted activity/i)).toBeInTheDocument();
	});
	it("does not certify old API name-grouped users and rate sums", () => {
		providers(
			<UserAnalyticsChart
				data={data({ measurement: undefined })}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/legacy.*unverified/i)).toBeInTheDocument();
		expect(screen.queryByText("Synthetic same name")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("list", { name: /source-scoped sampled users/i }),
		).not.toBeInTheDocument();
	});
	it.each([
		{ label: /no configured/i, sources: 0, idle: 0, failed: 0 },
		{ label: /no observations/i, sources: 1, idle: 0, failed: 0 },
		{ label: /successful idle/i, sources: 1, idle: 2, failed: 0 },
		{ label: /collection failed/i, sources: 1, idle: 0, failed: 2 },
		{ label: /some samples failed/i, sources: 1, idle: 2, failed: 2 },
	])("distinguishes empty collection state $label", ({ label, sources, idle, failed }) => {
		providers(
			<UserAnalyticsChart
				data={data({
					users: [],
					dailyBreakdown: [],
					measurement: measurement({
						status: "unavailable",
						observedSessions: 0,
						attributedSessions: 0,
						unattributedSessions: 0,
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
	it("retains legacy observation coverage when no native user can be attributed", () => {
		providers(
			<UserAnalyticsChart
				data={data({
					users: [],
					dailyBreakdown: [],
					measurement: measurement({
						status: "unavailable",
						attributedSessions: 0,
						unattributedSessions: 3,
						collection: {
							activeSnapshots: 0,
							idleSnapshots: 0,
							failedSnapshots: 0,
							legacySnapshots: 1,
							invalidSnapshots: 0,
						},
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/0 of 3.*attributed/i)).toBeInTheDocument();
		expect(screen.getByText(/3.*unattributed/i)).toBeInTheDocument();
		expect(screen.queryByText("No User Data Yet")).not.toBeInTheDocument();
	});
	it("marks calendar gaps unsampled and keeps daily bars flexible within the container", () => {
		providers(
			<UserAnalyticsChart
				data={data({
					dailyBreakdown: [
						{
							date: "2026-10-01",
							userSessions: { "source-one": 1, "source-two": 1 },
							measurement: measurement(),
						},
						{
							date: "2026-10-03",
							userSessions: {},
							measurement: measurement({
								observedSessions: 0,
								attributedSessions: 0,
								unattributedSessions: 0,
								collection: {
									activeSnapshots: 0,
									idleSnapshots: 0,
									failedSnapshots: 1,
									legacySnapshots: 0,
									invalidSnapshots: 0,
								},
							}),
						},
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const chart = screen.getByRole("group", { name: /daily sampled.*activity/i });
		expect(within(chart).getByRole("img", { name: /2026-10-02.*unsampled/i })).toBeInTheDocument();
		expect(within(chart).getByRole("img", { name: /2026-10-03.*failed/i })).toBeInTheDocument();
		expect(
			within(chart).getByRole("img", { name: /2026-10-01.*3 observations.*1 unattributed/i }),
		).toBeInTheDocument();
		const day = within(chart).getByRole("img", { name: /2026-10-01/i });
		expect(day).toHaveClass("flex-1", "min-w-0");
		expect(day.style.width).toBe("");
	});
	it("shows other attributed users instead of silently dropping the non-top-five cohort", () => {
		const users = Array.from({ length: 6 }, (_, i) => ({
			...data().users[0]!,
			key: `user-${i}`,
			username: `Synthetic ${i}`,
		}));
		const counts = Object.fromEntries(users.map((u) => [u.key, 1]));
		const complete = measurement({
			status: "complete",
			observedSessions: 6,
			attributedSessions: 6,
			unattributedSessions: 0,
		});
		providers(
			<UserAnalyticsChart
				data={data({
					users,
					measurement: complete,
					dailyBreakdown: [
						{ date: "2026-10-01", userSessions: counts, measurement: complete },
						{ date: "2026-10-02", userSessions: counts, measurement: complete },
					],
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		expect(screen.getByText(/other attributed users/i)).toBeInTheDocument();
		const day = screen.getByRole("img", { name: /2026-10-01.*6 observations/i });
		expect(day.querySelectorAll("[data-observations]")).toHaveLength(6);
	});
	it("makes initial failure actionable", () => {
		providers(<UserAnalyticsChart data={undefined} isLoading={false} isError />);
		expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
	});
});
function HookPanel({ service }: { service: "plex" | "jellyfin" }) {
	const plex = useUserAnalytics(30, service === "plex");
	const jellyfin = useJellyfinUserAnalytics(30, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<UserAnalyticsChart
			service={service}
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
		/>
	);
}
describe("real user analytics hooks and recovery", () => {
	it.each(["plex", "jellyfin"] as const)(
		"retains labeled last-known %s users on503 then recovers",
		async (service) => {
			let outcome: "initial" | "failed" | "recovered" = "initial";
			vi.stubGlobal("fetch", async (url: string) => {
				if (url !== `/api/${service}/analytics/users?days=30`)
					throw new Error("Unexpected test route");
				if (outcome === "failed")
					return new Response(JSON.stringify({ error: "Unavailable" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				const payload = data();
				if (outcome === "recovered")
					payload.users = payload.users.map((u) => ({ ...u, username: "Recovered synthetic" }));
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
			const queryKey =
				service === "plex" ? plexKeys.userAnalytics(30) : jellyfinKeys.userAnalytics(30);
			try {
				providers(<HookPanel service={service} />, client);
				await waitFor(() => expect(screen.getAllByText("Synthetic same name")).toHaveLength(2));
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(screen.getAllByText("Synthetic same name")).toHaveLength(2);
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() => expect(screen.getAllByText("Recovered synthetic")).toHaveLength(2));
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
			} finally {
				cleanup();
				client.clear();
			}
		},
	);
});
