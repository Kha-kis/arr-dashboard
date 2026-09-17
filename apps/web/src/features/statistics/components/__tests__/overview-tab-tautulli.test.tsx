import type { TautulliPlaysByDateResponse, TautulliStatsResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { fetchTautulliPlaysByDate, fetchTautulliStats } from "../../../../lib/api-client/tautulli";
import { tautulliKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useStatisticsData } from "../../hooks/useStatisticsData";
import { OverviewTab } from "../overview-tab";

vi.mock("../../../../lib/api-client/tautulli", () => ({
	fetchTautulliStats: vi.fn(),
	fetchTautulliPlaysByDate: vi.fn(),
}));

// The ARR summary is unrelated to these provider queries. Keep its real
// aggregation/defaults while disabling its independent network request.
vi.mock("../../../../hooks/api/useDashboard", () => ({
	useDashboardStatisticsQuery: () => ({ data: undefined }),
}));

const stats: TautulliStatsResponse = {
	homeStats: [],
	userStats: [{ userId: 1, friendlyName: "Synthetic viewer", totalPlays: 7, totalDuration: 7200 }],
	timeRange: 30,
	availability: { status: "complete", configuredSources: 1, availableSources: 1 },
};
const plays: TautulliPlaysByDateResponse = {
	categories: ["2026-09-01"],
	series: [{ name: "Synthetic series", data: [7] }],
	timeRange: 30,
	availability: { status: "complete", configuredSources: 1, availableSources: 1 },
};
const privateError = new Error("Synthetic private provider URL and account must not render");
const clients: QueryClient[] = [];

function Overview({ enabled }: { enabled: boolean }) {
	const data = useStatisticsData();
	return <OverviewTab {...data} hasTautulli={enabled} onSwitchTab={() => {}} />;
}

function mount(enabled = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<Overview enabled={enabled} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}

function value(label: string) {
	return screen.getByText(label, { exact: true }).nextElementSibling?.textContent;
}

beforeEach(() => {
	vi.mocked(fetchTautulliStats).mockReset().mockResolvedValue(stats);
	vi.mocked(fetchTautulliPlaysByDate).mockReset().mockResolvedValue(plays);
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
});

describe("Overview Tautulli availability", () => {
	it.each(["both", "stats", "plays"] as const)(
		"discloses successful-but-partial %s results and clears the notice after full recovery",
		async (partial) => {
			const availability = {
				status: "partial" as const,
				configuredSources: 2,
				availableSources: 1,
			};
			if (partial !== "plays")
				vi.mocked(fetchTautulliStats).mockResolvedValue({ ...stats, availability });
			if (partial !== "stats")
				vi.mocked(fetchTautulliPlaysByDate).mockResolvedValue({ ...plays, availability });
			const client = mount();
			await waitFor(() => expect(value("Total Plays")).toBe("7"));
			expect(value("Active Users")).toBe("1");
			expect(value("Watch Time")).toBe("2h");
			expect(screen.getByRole("status")).toHaveTextContent(/incomplete/i);
			vi.mocked(fetchTautulliStats).mockResolvedValue(stats);
			vi.mocked(fetchTautulliPlaysByDate).mockResolvedValue(plays);
			await act(async () => {
				await client.invalidateQueries({ queryKey: tautulliKeys.all });
			});
			await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
		},
	);

	it("does not turn empty results from only some sources into zero overall metrics", async () => {
		const availability = { status: "partial" as const, configuredSources: 2, availableSources: 1 };
		vi.mocked(fetchTautulliStats).mockResolvedValue({ ...stats, userStats: [], availability });
		vi.mocked(fetchTautulliPlaysByDate).mockResolvedValue({ ...plays, series: [], availability });
		mount();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/incomplete/i));
		expect(value("Total Plays")).toBe("—");
		expect(value("Active Users")).toBe("—");
		expect(value("Watch Time")).toBe("—");
	});

	it("does not present an absent optional source as zero while service detection catches up", async () => {
		const availability = {
			status: "not-configured" as const,
			configuredSources: 0,
			availableSources: 0,
		};
		vi.mocked(fetchTautulliStats).mockResolvedValue({ ...stats, userStats: [], availability });
		vi.mocked(fetchTautulliPlaysByDate).mockResolvedValue({ ...plays, series: [], availability });
		mount();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i));
		expect(value("Total Plays")).toBe("—");
		expect(value("Active Users")).toBe("—");
		expect(value("Watch Time")).toBe("—");
	});

	it.each(["both", "stats", "plays"] as const)(
		"retains values, discloses a failed %s refetch, and clears the notice after recovery",
		async (failed) => {
			const client = mount();
			await waitFor(() => expect(value("Total Plays")).toBe("7"));
			expect(value("Active Users")).toBe("1");
			expect(value("Watch Time")).toBe("2h");
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
			if (failed !== "plays") vi.mocked(fetchTautulliStats).mockRejectedValue(privateError);
			if (failed !== "stats") vi.mocked(fetchTautulliPlaysByDate).mockRejectedValue(privateError);
			await act(async () => {
				await client.invalidateQueries({ queryKey: tautulliKeys.all });
			});
			await waitFor(() =>
				expect(screen.getByRole("status")).toHaveTextContent(/failed|unavailable/i),
			);
			expect(screen.getByRole("status")).toHaveTextContent(/last-known|stale|older/i);
			expect(value("Total Plays")).toBe("7");
			expect(value("Active Users")).toBe("1");
			expect(value("Watch Time")).toBe("2h");
			expect(screen.queryByText(privateError.message)).not.toBeInTheDocument();
			vi.mocked(fetchTautulliStats).mockResolvedValue(stats);
			vi.mocked(fetchTautulliPlaysByDate).mockResolvedValue(plays);
			await act(async () => {
				await client.invalidateQueries({ queryKey: tautulliKeys.all });
			});
			await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
		},
	);

	it.each([
		{ failed: "stats", total: "7", users: "—", duration: "—" },
		{ failed: "plays", total: "—", users: "1", duration: "2h" },
		{ failed: "both", total: "—", users: "—", duration: "—" },
	])(
		"does not invent zero values when $failed is unavailable without cached data",
		async ({ failed, total, users, duration }) => {
			if (failed !== "plays") vi.mocked(fetchTautulliStats).mockRejectedValue(privateError);
			if (failed !== "stats") vi.mocked(fetchTautulliPlaysByDate).mockRejectedValue(privateError);
			mount();
			await waitFor(() =>
				expect(screen.getByRole("status")).toHaveTextContent(/failed|unavailable/i),
			);
			expect(value("Total Plays")).toBe(total);
			expect(value("Active Users")).toBe(users);
			expect(value("Watch Time")).toBe(duration);
		},
	);

	it("keeps a successful empty response distinct from unavailable data", async () => {
		vi.mocked(fetchTautulliStats).mockResolvedValue({ ...stats, userStats: [] });
		vi.mocked(fetchTautulliPlaysByDate).mockResolvedValue({ ...plays, series: [] });
		mount();
		await waitFor(() => expect(value("Total Plays")).toBe("0"));
		expect(value("Active Users")).toBe("0");
		expect(value("Watch Time")).toBe("0m");
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("does not render an optional service card or error when Tautulli is disabled", () => {
		vi.mocked(fetchTautulliStats).mockRejectedValue(privateError);
		vi.mocked(fetchTautulliPlaysByDate).mockRejectedValue(privateError);
		mount(false);
		expect(screen.queryByRole("heading", { name: "Plex" })).not.toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
