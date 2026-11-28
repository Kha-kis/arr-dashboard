import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
vi.mock("../../../../hooks/api/useQui", () => ({
	useLibrarySeedingSummary: () => ({ data: { status: "available", summaries: {} } }),
	useTrackerIcons: () => ({ data: { trackers: {} } }),
}));
vi.mock("../../../../hooks/api/usePlex", () => ({
	usePlexSections: () => ({ data: undefined }),
	usePlexAccounts: () => ({ data: undefined }),
	usePlexScanMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
import { LibraryContent } from "../library-content";
import { LibraryHeader } from "../library-header";
import { TorrentStateBadge } from "../torrent-state-badge";
const wrap = (children: React.ReactNode) => (
	<ColorThemeProvider>
		<IncognitoProvider>{children}</IncognitoProvider>
	</ColorThemeProvider>
);
const noop = vi.fn();
const props: ComponentProps<typeof LibraryContent> = {
	isLoading: false,
	isError: false,
	grouped: {
		movies: [
			{
				id: 1,
				instanceId: "synthetic",
				instanceName: "Synthetic",
				service: "radarr",
				type: "movie",
				title: "Useful library item",
				torrentState: "seeding",
				torrentRatio: 2,
			},
		],
		series: [],
		artists: [],
		authors: [],
	},
	totalItems: 1,
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
	isCached: true,
	LibraryCard: ({ item, quiState, onToggleMonitor }) => (
		<article>
			<h3>{item.title}</h3>
			<button type="button" onClick={() => onToggleMonitor(item)}>
				Monitor item
			</button>
			{quiState && <TorrentStateBadge {...quiState} />}
		</article>
	),
};
const header: ComponentProps<typeof LibraryHeader> = {
	serviceFilter: "all",
	onServiceFilterChange: noop,
	instanceFilter: "all",
	onInstanceFilterChange: noop,
	statusFilter: "all",
	onStatusFilterChange: noop,
	fileFilter: "all",
	onFileFilterChange: noop,
	qualityFilter: "all",
	onQualityFilterChange: noop,
	torrentStateFilter: "all",
	onTorrentStateFilterChange: noop,
	searchTerm: "",
	onSearchTermChange: noop,
	sortBy: "sortTitle",
	onSortByChange: noop,
	sortOrder: "asc",
	onSortOrderChange: noop,
	instanceOptions: [],
	syncStatus: null,
	isSyncing: false,
	hasSyncError: false,
	hasQui: true,
};
describe("Library qUI availability consumers", () => {
	it.each([
		undefined,
		{ status: "unavailable" as const, observedAt: null },
		{ status: "not_configured" as const, observedAt: null },
	])(
		"never trusts cached scalars with missing/nonavailable metadata, preserving useful rows and actions",
		(status) => {
			render(wrap(<LibraryContent {...props} quiObservationStatus={status} />));
			expect(screen.queryByLabelText(/Torrent:/)).not.toBeInTheDocument();
			expect(screen.getByText("Useful library item")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Monitor item" })).toBeEnabled();
		},
	);
	it("retains a verified known state with nullable ratio instead of hiding it or inventing zero", () => {
		const grouped = {
			...props.grouped,
			movies: props.grouped.movies.map((item) => ({ ...item, torrentRatio: null })),
		};
		render(
			wrap(
				<LibraryContent
					{...props}
					grouped={grouped}
					quiObservationStatus={{ status: "available", observedAt: "2026-10-25T11:00:00Z" }}
				/>,
			),
		);
		expect(screen.getByLabelText("Torrent: Seeding, ratio unknown")).toBeInTheDocument();
		expect(screen.queryByText("0.00×")).not.toBeInTheDocument();
	});
	it("shows actionable inline unavailable notice and disables only qUI controls", () => {
		render(
			wrap(
				<LibraryHeader
					{...header}
					quiObservationStatus={{ status: "unavailable", observedAt: null }}
				/>,
			),
		);
		expect(
			screen.getByText(/Torrent status is unavailable until a complete qUI sync/),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /qUI connections/i })).toHaveAttribute("href", "/qui");
		expect(screen.getByRole("combobox", { name: "Torrent state" })).toBeDisabled();
		expect(screen.queryByRole("option", { name: "Torrent ratio" })).not.toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Sort By" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Movies" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
	});
	it("has no qUI-unavailable notice when not configured and restores useful controls when available", () => {
		const { rerender } = render(
			wrap(
				<LibraryHeader
					{...header}
					quiObservationStatus={{ status: "not_configured", observedAt: null }}
				/>,
			),
		);
		expect(screen.queryByText(/Torrent status is unavailable/)).not.toBeInTheDocument();
		rerender(
			wrap(
				<LibraryHeader
					{...header}
					quiObservationStatus={{ status: "available", observedAt: "2026-10-25T11:00:00Z" }}
				/>,
			),
		);
		expect(screen.getByRole("combobox", { name: "Torrent state" })).toBeEnabled();
		expect(screen.getByRole("option", { name: "Torrent ratio" })).toBeInTheDocument();
	});
	it("honors explicit unavailable metadata even if the separate service inventory has not arrived", () => {
		render(
			wrap(
				<LibraryHeader
					{...header}
					hasQui={false}
					quiObservationStatus={{ status: "unavailable", observedAt: null }}
				/>,
			),
		);
		expect(screen.getByRole("link", { name: /qUI connections/i })).toHaveAttribute("href", "/qui");
		expect(screen.getByRole("combobox", { name: "Torrent state" })).toBeDisabled();
	});
});
