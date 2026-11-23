import { cleanup, render, screen } from "@testing-library/react";
import type { LibraryItem } from "@arr/shared";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const { summaryQuery } = vi.hoisted(() => ({ summaryQuery: vi.fn() }));
vi.mock("../../../../hooks/api/useQui", () => ({
	useLibrarySeedingSummary: () => summaryQuery(),
	useTrackerIcons: () => ({ data: { trackers: {} } }),
}));

import { LibraryContent } from "../library-content";
import { LibraryCard } from "../library-card";

const noop = vi.fn();
beforeEach(() => {
	summaryQuery.mockReturnValue({ data: { status: "available", summaries: {} }, isError: false });
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	localStorage.clear();
});

const baseProps: ComponentProps<typeof LibraryContent> = {
	isLoading: false,
	isError: false,
	grouped: { movies: [], series: [], artists: [], authors: [] },
	totalItems: 0,
	page: 1,
	pageSize: 50,
	onPageChange: noop,
	onPageSizeChange: noop,
	onToggleMonitor: noop,
	isMonitorPending: () => false,
	serviceLookup: {},
	onSearchMovie: noop,
	pendingMovieSearch: null,
	onSearchSeries: noop,
	pendingSeriesSearch: null,
	onViewAlbums: noop,
	onSearchArtist: noop,
	pendingArtistSearch: null,
	onViewBooks: noop,
	onSearchAuthor: noop,
	pendingAuthorSearch: null,
	onExpandDetails: noop,
	buildLibraryExternalLink: () => null,
	LibraryCard: () => null,
	isSyncing: false,
	isCached: false,
};
const populatedProps: ComponentProps<typeof LibraryContent> = {
	...baseProps,
	grouped: {
		movies: [{ id: 1, instanceId: "arr-1", type: "movie", service: "radarr" } as LibraryItem],
		series: [],
		artists: [],
		authors: [],
	},
	totalItems: 1,
};

describe("Library empty cache state", () => {
	it("distinguishes an unavailable cache from a valid empty result", () => {
		const { rerender } = render(
			<ColorThemeProvider>
				<LibraryContent {...baseProps} isCached={false} />
			</ColorThemeProvider>,
		);

		expect(screen.getByText("Library cache unavailable")).toBeInTheDocument();
		expect(screen.queryByText("No items found")).not.toBeInTheDocument();

		rerender(
			<ColorThemeProvider>
				<LibraryContent {...baseProps} isCached />
			</ColorThemeProvider>,
		);
		expect(screen.getByText("No items found")).toBeInTheDocument();
	});
});

describe("Library tracker coverage", () => {
	it("passes the original series check through unchanged summary polls and preserves movie/legacy wording", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-23T11:00:00.000Z"));
		const observedAt = "2026-11-23T10:00:00.000Z";
		const summary = { trackerCount: 2, topHosts: ["tracker.invalid"], hashCount: 1 };
		const episodeInventory = { status: "fresh", observedAt };
		const summaries = {
			"arr-1|movie:1": summary,
			"arr-1|series:2": { ...summary, episodeInventory },
			"arr-1|series:3": summary,
		};
		const setSummary = () =>
			summaryQuery.mockReturnValue({ data: { status: "available", summaries }, isError: false });
		setSummary();
		const content = () => (
			<ColorThemeProvider>
				<IncognitoProvider>
					<LibraryContent
						{...populatedProps}
						LibraryCard={LibraryCard}
						grouped={{
							...populatedProps.grouped,
							movies: populatedProps.grouped.movies.map((item) => ({
								...item,
								title: "Synthetic movie",
								instanceName: "Synthetic Radarr",
							})),
							series: [2, 3].map((id) => ({
								id,
								instanceId: "arr-1",
								instanceName: "Synthetic Sonarr",
								type: "series",
								service: "sonarr",
								title: `Synthetic series ${id}`,
							})),
						}}
						totalItems={3}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>
		);
		const { container, rerender } = render(content());
		const originalTitle = `Seeding at 2 trackers. Episode files last checked ${new Date(observedAt).toLocaleString()}.`;
		expect(screen.getByTitle(originalTitle)).toBeInTheDocument();
		expect(screen.getAllByTitle("Seeding at 2 trackers")).toHaveLength(2);
		const time = screen.getByText(new Date(observedAt).toLocaleString());
		expect(time).toBeVisible();
		expect(time.tagName).toBe("TIME");
		expect(time).toHaveAttribute("datetime", observedAt);
		expect(container.querySelectorAll("time")).toHaveLength(1);
		expect(time.parentElement).toHaveTextContent("Episode files last checked");

		vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
		setSummary();
		rerender(content());
		expect(screen.getByTitle(originalTitle)).toBeInTheDocument();
		expect(screen.getByText(new Date(observedAt).toLocaleString())).toBe(time);
		expect(time).toBeVisible();
		expect(time).toHaveAttribute("datetime", observedAt);

		episodeInventory.status = "stale";
		setSummary();
		rerender(content());
		expect(
			screen.getByTitle(
				`At least 2 trackers observed. Episode files out of date; last checked ${new Date(observedAt).toLocaleString()}.`,
			),
		).toBeInTheDocument();
		expect(screen.getAllByTitle("Seeding at 2 trackers")).toHaveLength(2);
		expect(screen.getByText(new Date(observedAt).toLocaleString())).toBe(time);
		expect(time).toBeVisible();
		expect(time).toHaveAttribute("datetime", observedAt);
		expect(time.parentElement).toHaveTextContent("Episode files out of date; last checked");
		expect(container.querySelectorAll("time")).toHaveLength(1);
	});

	it("discloses a building index instead of presenting missing tracker badges as absence", () => {
		summaryQuery.mockReturnValue({ data: { status: "building", summaries: {} }, isError: false });
		render(
			<ColorThemeProvider>
				<LibraryContent {...populatedProps} />
			</ColorThemeProvider>,
		);
		expect(screen.getByText(/Tracker coverage is still loading/)).toBeInTheDocument();
	});

	it("discloses partial and unavailable tracker coverage", () => {
		summaryQuery.mockReturnValue({ data: { status: "partial", summaries: {} }, isError: false });
		const { rerender } = render(
			<ColorThemeProvider>
				<LibraryContent {...populatedProps} />
			</ColorThemeProvider>,
		);
		expect(screen.getByText(/Tracker coverage is partial/)).toBeInTheDocument();

		summaryQuery.mockReturnValue({
			data: { status: "unavailable", summaries: {} },
			isError: false,
		});
		rerender(
			<ColorThemeProvider>
				<LibraryContent {...populatedProps} />
			</ColorThemeProvider>,
		);
		expect(screen.getByText(/Tracker coverage is unavailable/)).toBeInTheDocument();
	});
});
