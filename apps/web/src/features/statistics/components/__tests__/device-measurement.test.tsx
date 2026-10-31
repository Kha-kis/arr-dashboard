import type { DeviceAnalytics, DeviceAnalyticsMeasurementSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { useJellyfinDeviceAnalytics } from "../../../../hooks/api/useJellyfin";
import { useDeviceAnalytics } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DeviceChart } from "../device-chart";

function measurement(
	overrides: Partial<DeviceAnalyticsMeasurementSummary> = {},
): DeviceAnalyticsMeasurementSummary {
	return {
		version: 1,
		status: "partial",
		observedSessions: 3,
		platformMeasuredSessions: 2,
		playerMeasuredSessions: 2,
		platformAxis: "platform",
		unverifiedPlatformSnapshots: 0,
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
function data(overrides: Partial<DeviceAnalytics> = {}): DeviceAnalytics {
	return {
		totalSessions: 3,
		platforms: [
			{ platform: "Private platform", sessions: 2, percent: 66.7 },
			{ platform: "unknown", sessions: 1, percent: 33.3 },
		],
		players: [
			{ player: "Private device", platform: "Private platform", sessions: 2 },
			{ player: "unknown", platform: "unknown", sessions: 1 },
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
function PrivacyToggle() {
	const [active, setActive] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setActive(!active)}>
			Toggle privacy
		</button>
	);
}
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.removeItem("arr-dashboard-incognito-mode");
});

describe("device observation truth and presentation", () => {
	it("reports independent platform and player coverage without claiming unique devices", () => {
		providers(<DeviceChart data={data()} isLoading={false} isError={false} />);
		expect(screen.getByText(/platform.*2 of 3.*player.*2 of 3/i)).toBeInTheDocument();
		expect(screen.getByText(/sample observations.*not.*unique.*devices/i)).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Platform distribution" })).toHaveAttribute(
			"aria-description",
			expect.stringMatching(/3 observations.*2 Private platform.*1 unknown/i),
		);
	});
	it("keeps counts beyond six platforms and eight players, including collision-safe Other categories", () => {
		providers(
			<DeviceChart
				data={data({
					totalSessions: 10,
					platforms: Array.from({ length: 10 }, (_, i) => ({
						platform: i === 0 ? "Other platforms" : `p${i}`,
						sessions: 1,
						percent: 10,
					})),
					players: Array.from({ length: 10 }, (_, i) => ({
						player: i === 0 ? "Other players" : `d${i}`,
						platform: i === 0 ? "Other platforms" : `p${i}`,
						sessions: 1,
					})),
					measurement: measurement({
						status: "complete",
						observedSessions: 10,
						platformMeasuredSessions: 10,
						playerMeasuredSessions: 10,
					}),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const graph = screen.getByRole("img", { name: "Platform distribution" });
		expect(graph.querySelectorAll("circle")).toHaveLength(6);
		expect(graph).toHaveAttribute(
			"aria-description",
			expect.stringMatching(/10 observations.*5 Other platforms \(grouped\)/i),
		);
		const [dash, gap] = graph
			.querySelector("circle")!
			.getAttribute("stroke-dasharray")!
			.split(" ")
			.map(Number);
		expect(dash! / (dash! + gap!)).toBeCloseTo(0.1);
		expect(screen.getByText("Other players (grouped)").closest("li")).toHaveTextContent(/3$/);
		expect(screen.getByText("Other players")).toBeInTheDocument();
	});
	it("keeps paired platform labels visible when player names are shared", () => {
		providers(
			<DeviceChart
				data={data({
					totalSessions: 2,
					platforms: [
						{ platform: "Platform A", sessions: 1, percent: 50 },
						{ platform: "Platform B", sessions: 1, percent: 50 },
					],
					players: [
						{ player: "Same name", platform: "Platform A", sessions: 1 },
						{ player: "Same name", platform: "Platform B", sessions: 1 },
					],
					measurement: measurement({ status: "complete", observedSessions: 2 }),
				})}
				isLoading={false}
				isError={false}
			/>,
		);
		const rows = screen.getAllByTitle("Same name").map((name) => name.closest("li")!);
		expect(rows[0]).toHaveTextContent("Platform A");
		expect(rows[1]).toHaveTextContent("Platform B");
	});
	it("uses client-app labels for Jellyfin/Emby rather than claiming OS platform evidence", () => {
		providers(
			<DeviceChart
				service="jellyfin"
				data={data({
					measurement: measurement({
						platformAxis: "client",
						unverifiedPlatformSnapshots: 1,
						collection: {
							activeSnapshots: 2,
							idleSnapshots: 0,
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
		expect(screen.getByRole("img", { name: "Client app distribution" })).toBeInTheDocument();
		expect(screen.getByText(/1.*unverified.*client/i)).toBeInTheDocument();
	});
	it("keeps old API labels unverified rather than assigning them native provenance", () => {
		providers(
			<DeviceChart data={data({ measurement: undefined })} isLoading={false} isError={false} />,
		);
		expect(screen.getByText(/legacy.*unverified/i)).toBeInTheDocument();
		expect(screen.queryByText("Private platform")).not.toBeInTheDocument();
		expect(screen.queryByText("Private device")).not.toBeInTheDocument();
		expect(screen.getByRole("img")).toHaveAttribute(
			"aria-description",
			expect.stringMatching(/3 observations.*3 unknown/i),
		);
	});
	it("masks names in visible text, titles and accessible descriptions without masking unknown", () => {
		const { container } = providers(
			<>
				<PrivacyToggle />
				<DeviceChart data={data()} isLoading={false} isError={false} />
			</>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(container.innerHTML).not.toMatch(/Private device|Private platform/);
		expect(screen.getByRole("img")).toHaveAttribute(
			"aria-description",
			expect.stringMatching(/3 observations.*2 Linux.*1 unknown/i),
		);
		expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(screen.getByTitle("Private device")).toBeInTheDocument();
	});
	it("does not clip the donut stroke or blank data during loading", () => {
		providers(<DeviceChart data={data()} isLoading isError={false} />);
		const graph = screen.getByRole("img");
		for (const circle of graph.querySelectorAll("circle")) {
			const r = Number(circle.getAttribute("r"));
			const halfStroke = Number(circle.getAttribute("stroke-width")) / 2;
			expect(Number(circle.getAttribute("cx")) - r - halfStroke).toBeGreaterThanOrEqual(0);
			expect(Number(circle.getAttribute("cx")) + r + halfStroke).toBeLessThanOrEqual(
				Number(graph.getAttribute("width")),
			);
		}
	});
	it.each([
		{ sources: 0, idle: 0, failed: 0, label: /no configured/i },
		{ sources: 1, idle: 0, failed: 0, label: /no observations/i },
		{ sources: 1, idle: 2, failed: 0, label: /successful idle/i },
		{ sources: 1, idle: 0, failed: 2, label: /collection failed/i },
	])("distinguishes empty collection $label", ({ sources, idle, failed, label }) => {
		providers(
			<DeviceChart
				data={data({
					totalSessions: 0,
					platforms: [],
					players: [],
					measurement: measurement({
						status: "unavailable",
						observedSessions: 0,
						platformMeasuredSessions: 0,
						playerMeasuredSessions: 0,
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
	it("discloses failed, legacy, invalid and idle collection next to measured labels", () => {
		providers(
			<DeviceChart
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
	it("makes an initial request failure actionable", () => {
		providers(<DeviceChart data={undefined} isLoading={false} isError />);
		expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
	});
});

function HookPanel({ service }: { service: "plex" | "jellyfin" }) {
	const plex = useDeviceAnalytics(30, service === "plex");
	const jellyfin = useJellyfinDeviceAnalytics(30, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<DeviceChart
			service={service}
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
		/>
	);
}
describe("real device hooks and transport recovery", () => {
	it.each(["plex", "jellyfin"] as const)(
		"keeps last-known %s labels after503 and recovers through the actual hook",
		async (service) => {
			let outcome: "initial" | "failed" | "recovered" = "initial";
			vi.stubGlobal("fetch", async (url: string) => {
				if (url !== `/api/${service}/analytics/devices?days=30`)
					throw new Error("Unexpected fixture route");
				if (outcome === "failed")
					return new Response(JSON.stringify({ error: "PRIVATE_FAILURE_BODY" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				const value = data({
					measurement: measurement({ platformAxis: service === "plex" ? "platform" : "client" }),
					...(outcome === "recovered"
						? {
								players: [
									{ player: "Recovered device", platform: "Private platform", sessions: 2 },
									{ player: "unknown", platform: "unknown", sessions: 1 },
								],
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
				service === "plex" ? plexKeys.deviceAnalytics(30) : jellyfinKeys.deviceAnalytics(30);
			try {
				providers(<HookPanel service={service} />, client);
				await screen.findByTitle("Private device");
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(screen.getByTitle("Private device")).toBeInTheDocument();
				expect(screen.queryByText(/PRIVATE_FAILURE_BODY/)).not.toBeInTheDocument();
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await screen.findByTitle("Recovered device");
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
				expect(screen.queryByTitle("Private device")).not.toBeInTheDocument();
			} finally {
				client.clear();
			}
		},
	);
});
