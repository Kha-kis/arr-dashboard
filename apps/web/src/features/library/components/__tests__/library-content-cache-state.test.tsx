import { render, screen } from "@testing-library/react";
import type { LibraryItem } from "@arr/shared";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const { summaryQuery } = vi.hoisted(() => ({ summaryQuery: vi.fn() }));
vi.mock("../../../../hooks/api/useQui", () => ({
	useLibrarySeedingSummary: () => summaryQuery(),
	useTrackerIcons: () => ({ data: { trackers: {} } }),
}));

import { LibraryContent } from "../library-content";

const noop = vi.fn();
beforeEach(() => {
	summaryQuery.mockReturnValue({ data: { status: "available", summaries: {} }, isError: false });
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
