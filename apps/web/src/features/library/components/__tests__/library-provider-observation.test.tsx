import type {
	LibraryItem,
	ProviderObservationAvailability,
	ProviderObservationStatus,
	ProviderObservationStatusEnvelope,
	SeriesProgressResponse,
	WatchEnrichmentResponse,
} from "@arr/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryState = vi.hoisted(() => ({
	jellyfinWatch: {} as Record<string, unknown>,
	jellyfinProgress: {} as Record<string, unknown>,
	plexWatch: {} as Record<string, unknown>,
	plexProgress: {} as Record<string, unknown>,
	libraryItem: undefined as LibraryItem | undefined,
	contentProps: undefined as Record<string, unknown> | undefined,
	seerrInstance: undefined as { id: string } | undefined,
	detailProps: undefined as Record<string, unknown> | undefined,
	watchHook: vi.fn(),
	progressHook: vi.fn(),
	plexProgressHook: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../../../components/presentational/plex-evidence-notice", () => ({
	PlexQueryEvidenceNotice: ({ error }: { error?: unknown }) =>
		error ? <div role="alert">Plex evidence notice</div> : null,
}));
vi.mock("../../../../components/layout", () => ({
	ServiceBadge: () => null,
	StatusBadge: () => null,
}));
vi.mock("../../../../components/ui", () => ({
	Button: ({ children }: { children: React.ReactNode }) => (
		<button type="button">{children}</button>
	),
	toast: { warning: vi.fn() },
}));
vi.mock("../../../../hooks/api/useJellyfin", () => ({
	useJellyfinIdentity: () => ({ data: [] }),
	useJellyfinSeriesProgress: (...args: unknown[]) => {
		queryState.progressHook(...args);
		return queryState.jellyfinProgress;
	},
	useJellyfinWatchEnrichment: (...args: unknown[]) => {
		queryState.watchHook(...args);
		return queryState.jellyfinWatch;
	},
}));
vi.mock("../../../../hooks/api/useLibrary", () => ({
	useLibraryMonitorMutation: () => ({ isPending: false, mutate: vi.fn(), variables: undefined }),
}));
vi.mock("../../../../hooks/api/usePlex", () => ({
	usePlexIdentity: () => ({ data: undefined }),
	useSeriesProgress: (...args: unknown[]) => {
		queryState.plexProgressHook(...args);
		return queryState.plexProgress;
	},
	useWatchEnrichment: () => queryState.plexWatch,
}));
vi.mock("../../../../hooks/api/useSeerr", () => ({
	useLibraryEnrichment: () => ({ data: undefined }),
}));
vi.mock("../../../../lib/api-client/library", () => ({ fetchLibraryItemByTmdbId: vi.fn() }));
vi.mock("../../../seerr/hooks/use-seerr-instances", () => ({
	useSeerrInstances: () => ({ defaultInstance: queryState.seerrInstance }),
}));
vi.mock("../../hooks", () => ({
	useLibraryActions: () => ({
		handleAlbumSearch: vi.fn(),
		handleAlbumMonitor: vi.fn(),
		handleArtistSearch: vi.fn(),
		handleBookSearch: vi.fn(),
		handleBookMonitor: vi.fn(),
		handleMovieSearch: vi.fn(),
		handleSeasonMonitor: vi.fn(),
		handleSeasonSearch: vi.fn(),
		handleSeriesSearch: vi.fn(),
		pendingAlbumAction: null,
		pendingArtistSearch: null,
		pendingMovieSearch: null,
		pendingSeasonAction: null,
		pendingSeriesSearch: null,
	}),
	useLibraryData: () => {
		const item = queryState.libraryItem ?? libraryItem;
		return {
			items: [item],
			grouped: {
				movies: item.type === "movie" ? [item] : [],
				series: item.type === "series" ? [item] : [],
				artists: [],
				authors: [],
			},
			pagination: { page: 1, limit: 25, totalItems: 1, totalPages: 1 },
			syncStatus: null,
			instanceOptions: [],
			serviceLookup: {},
			isLoading: false,
			isError: false,
			error: undefined,
			isSyncing: false,
		};
	},
	useLibraryFilters: () => ({
		serviceFilter: "all",
		setServiceFilter: vi.fn(),
		instanceFilter: "all",
		setInstanceFilter: vi.fn(),
		statusFilter: "all",
		setStatusFilter: vi.fn(),
		fileFilter: "all",
		setFileFilter: vi.fn(),
		qualityFilter: "all",
		setQualityFilter: vi.fn(),
		torrentStateFilter: "all",
		setTorrentStateFilter: vi.fn(),
		searchTerm: "",
		setSearchTerm: vi.fn(),
		sortBy: "sortTitle",
		setSortBy: vi.fn(),
		sortOrder: "asc",
		setSortOrder: vi.fn(),
		page: 1,
		setPage: vi.fn(),
		pageSize: 25,
		setPageSize: vi.fn(),
	}),
}));
vi.mock("../../lib/library-utils", () => ({
	buildJellyfinUrl: vi.fn(),
	buildLibraryExternalLink: vi.fn(),
	buildPlexUrl: vi.fn(),
	formatBytes: () => "",
	formatRuntime: () => "",
}));
vi.mock("../album-breakdown-modal", () => ({ AlbumBreakdownModal: () => null }));
vi.mock("../book-breakdown-modal", () => ({ BookBreakdownModal: () => null }));
vi.mock("../enriched-detail-modal", () => ({
	EnrichedDetailModal: (props: Record<string, unknown>) => {
		queryState.detailProps = props;
		return <div data-testid="enriched-details" />;
	},
}));
vi.mock("../item-details-modal", () => ({ ItemDetailsModal: () => null }));
vi.mock("../library-card", () => ({ LibraryCard: () => null }));
vi.mock("../library-badge", () => ({ LibraryBadge: () => null }));
vi.mock("../poster-image", () => ({ PosterImage: () => null }));
vi.mock("../torrent-state-badge", () => ({ TorrentStateBadge: () => null }));
vi.mock("../library-content", () => ({
	LibraryContent: (props: Record<string, unknown>) => {
		queryState.contentProps = props;
		return <div data-testid="library-content" />;
	},
}));
vi.mock("../library-header", () => ({ LibraryHeader: () => null }));
vi.mock("../library-insights-section", () => ({ LibraryInsightsSection: () => null }));

import { LibraryClient } from "../library-client";

const libraryItem = {
	id: 1,
	type: "movie",
	title: "Synthetic library item",
	sortTitle: "Synthetic library item",
	instanceId: "arr-instance",
	service: "radarr",
	monitored: true,
	remoteIds: { tmdbId: 101 },
} as unknown as LibraryItem;

const seriesLibraryItem = {
	...libraryItem,
	type: "series",
	remoteIds: { tmdbId: 202 },
} as unknown as LibraryItem;

function status(availability: ProviderObservationAvailability): ProviderObservationStatusEnvelope {
	return {
		availability,
		sources: [
			{
				instanceId: "private-provider-instance",
				service: "jellyfin",
				cacheType: "jellyfin",
				status: {
					availability,
					evidence: availability === "current" ? "complete" : "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "successful",
					reasonCodes: availability === "current" ? [] : ["unknown-failure"],
				},
			},
		],
	};
}

function currentLibraryStatusWithUnavailableWatchCount(): ProviderObservationStatusEnvelope {
	return {
		availability: "current",
		sources: [
			{
				instanceId: "private-provider-instance",
				service: "jellyfin",
				cacheType: "jellyfin",
				status: {
					availability: "current",
					evidence: "complete",
					observedAt: "2026-09-03T00:00:00.000Z",
					ageSeconds: 10,
					latestAttempt: "successful",
					reasonCodes: [],
					domains: [
						...(["library-inventory", "mapping", "watch-attribution", "on-deck"] as const).map(
							(domain) => ({
								domain,
								availability: "current" as const,
								evidence: "complete" as const,
								valueSemantics: "exact" as const,
								observedAt: "2026-09-03T00:00:00.000Z",
								reasonCodes: [],
							}),
						),
						{
							domain: "watch-count",
							availability: "unavailable",
							evidence: "unknown",
							valueSemantics: "unknown",
							observedAt: null,
							reasonCodes: ["provider-unavailable"],
						},
					],
				},
			},
		],
	};
}

const emptyResponse = { data: undefined, error: null, isError: false };

function setQueries({
	jellyfinWatch = emptyResponse,
	jellyfinProgress = emptyResponse,
	plexWatch = emptyResponse,
	plexProgress = emptyResponse,
}: {
	jellyfinWatch?: Record<string, unknown>;
	jellyfinProgress?: Record<string, unknown>;
	plexWatch?: Record<string, unknown>;
	plexProgress?: Record<string, unknown>;
} = {}) {
	queryState.jellyfinWatch = jellyfinWatch;
	queryState.jellyfinProgress = jellyfinProgress;
	queryState.plexWatch = plexWatch;
	queryState.plexProgress = plexProgress;
}

function watchResponse(
	items: WatchEnrichmentResponse["items"] = {},
	providerStatus?: ProviderObservationStatusEnvelope,
	tautulliStatus?: ProviderObservationStatus,
): Record<string, unknown> {
	return { data: { items, providerStatus, tautulliStatus }, error: null, isError: false };
}

function progressResponse(
	progress: SeriesProgressResponse["progress"] = {},
	providerStatus?: ProviderObservationStatusEnvelope,
): Record<string, unknown> {
	return { data: { progress, providerStatus }, error: null, isError: false };
}

beforeEach(() => {
	setQueries();
	queryState.libraryItem = libraryItem;
	queryState.contentProps = undefined;
	queryState.detailProps = undefined;
	queryState.seerrInstance = undefined;
	queryState.watchHook.mockClear();
	queryState.progressHook.mockClear();
	queryState.plexProgressHook.mockClear();
});

describe("Library provider observation", () => {
	it.each([
		["native identifier", "jellyfin", "native-series", false],
		["native nullable identifier", "jellyfin", null, false],
		["Plex optional analytics", "both", null, false],
		["merged nullable identifiers", "jellyfin", null, true],
	] as const)(
		"retains selected episode provider for %s without server identity",
		async (_name, source, jellyfinId, mergePlex) => {
			queryState.seerrInstance = { id: "synthetic-seerr" };
			queryState.libraryItem = { ...seriesLibraryItem, service: "sonarr" } as LibraryItem;
			const item = {
				lastWatchedAt: null,
				watchCount: 1,
				watchCountSemantics: "lower-bound" as const,
				watchedByUsers: [],
				onDeck: false,
				userRating: null,
				source,
				ratingKey: null,
				jellyfinId,
				instanceId: "selected-instance",
				collections: [],
				labels: [],
			};
			setQueries({
				jellyfinWatch:
					source === "jellyfin"
						? watchResponse({ "series:202": item }, status("current"))
						: emptyResponse,
				plexWatch:
					source === "both" || mergePlex
						? watchResponse({
								"series:202": {
									...item,
									source: "both",
									instanceId: mergePlex ? "other-plex-instance" : item.instanceId,
								},
							})
						: emptyResponse,
			});
			render(<LibraryClient />);
			await act(async () => {
				(queryState.contentProps?.onExpandDetails as (item: LibraryItem) => void)(
					queryState.libraryItem!,
				);
			});
			await waitFor(() =>
				expect(queryState.detailProps?.episodeProvider).toBe(
					source === "jellyfin" ? "jellyfin" : "plex",
				),
			);
			expect(queryState.detailProps?.plexData).toMatchObject({ instanceId: "selected-instance" });
		},
	);

	it.each([
		["last-known", status("last-known"), /Showing last-known media-server data/i],
		["partial", status("partial"), /Media-server data is unavailable/i],
		["unavailable", status("unavailable"), /Media-server data is unavailable/i],
	] as const)(
		"renders a fixed %s notice while preserving library data",
		(_name, providerStatus, notice) => {
			setQueries({
				jellyfinWatch: watchResponse(
					{
						"movie:101": {
							lastWatchedAt: null,
							watchCount: 2,
							watchCountSemantics: "exact",
							watchedByUsers: [],
							onDeck: false,
							userRating: null,
							source: "jellyfin",
							ratingKey: null,
							jellyfinId: "jf-101",
							instanceId: "private-provider-instance",
							collections: [],
							labels: [],
						},
					},
					providerStatus,
				),
				jellyfinProgress: progressResponse({}, providerStatus),
			});

			render(<LibraryClient />);

			expect(screen.getByText(notice)).toBeInTheDocument();
			expect(screen.getByTestId("library-content")).toBeInTheDocument();
			expect(queryState.contentProps?.watchEnrichmentMap).toMatchObject({
				"movie:101": { jellyfinId: "jf-101" },
			});
			expect(queryState.contentProps?.seriesProgressMap).toMatchObject({});
		},
	);

	it.each(["absent", "current"] as const)(
		"does not render a generic notice for %s status",
		(state) => {
			if (state === "current") {
				setQueries({
					jellyfinWatch: watchResponse({}, status("current")),
					jellyfinProgress: progressResponse({}, status("current")),
				});
			}

			render(<LibraryClient />);

			expect(
				screen.queryByText(/Media-server data is (incomplete|unavailable)/i),
			).not.toBeInTheDocument();
		},
	);

	it("keeps an unavailable source visible when another response is current", () => {
		const unavailableFromAnotherSource = {
			...status("unavailable"),
			sources: [
				{
					...status("unavailable").sources[0],
					instanceId: "private-provider-instance-2",
				},
			],
		} as ProviderObservationStatusEnvelope;
		setQueries({
			jellyfinWatch: watchResponse({}, status("current")),
			jellyfinProgress: progressResponse({}, unavailableFromAnotherSource),
		});

		render(<LibraryClient />);

		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
	});

	it("does not let current inventory and mapping mask unavailable Jellyfin watch count", () => {
		const providerStatus = currentLibraryStatusWithUnavailableWatchCount();
		setQueries({
			jellyfinWatch: watchResponse({}, providerStatus),
			jellyfinProgress: progressResponse({}, providerStatus),
		});

		render(<LibraryClient />);

		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
	});

	it("renders one notice when both watch routes report partial Tautulli evidence", () => {
		const tautulliStatus: ProviderObservationStatus = {
			availability: "partial",
			evidence: "positive-only",
			observedAt: "2026-09-03T00:00:00.000Z",
			ageSeconds: 10,
			latestAttempt: "successful",
			reasonCodes: ["positive-only", "coverage-incomplete"],
		};
		setQueries({
			plexWatch: watchResponse({}, undefined, tautulliStatus),
			jellyfinWatch: watchResponse({}, undefined, tautulliStatus),
		});

		render(<LibraryClient />);

		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(screen.getByText(/Showing current mapped data/i)).toBeInTheDocument();
	});

	it("renders a nonempty degraded progress map unchanged", () => {
		queryState.libraryItem = seriesLibraryItem;
		setQueries({
			jellyfinProgress: progressResponse(
				{ 202: { watched: 2, total: 4, percent: 50 } },
				status("last-known"),
			),
		});

		render(<LibraryClient />);

		expect(screen.getByText(/Showing last-known media-server data/i)).toBeInTheDocument();
		expect(queryState.contentProps?.seriesProgressMap).toMatchObject({
			202: { watched: 2, total: 4, percent: 50 },
		});
		expect(queryState.progressHook).toHaveBeenCalledWith([202]);
	});

	it("renders an unavailable notice for an independent progress transport error", () => {
		queryState.libraryItem = seriesLibraryItem;
		setQueries({
			jellyfinProgress: {
				...progressResponse(),
				isError: true,
				error: new Error("private progress transport failure"),
			},
		});

		render(<LibraryClient />);

		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText("private progress transport failure")).not.toBeInTheDocument();
		expect(queryState.progressHook).toHaveBeenCalledWith([202]);
	});

	it("turns a Jellyfin transport error into an unavailable notice without raw error text", () => {
		setQueries({
			jellyfinWatch: {
				...watchResponse(),
				isError: true,
				error: new Error("private transport failure"),
			},
		});

		render(<LibraryClient />);

		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText("private transport failure")).not.toBeInTheDocument();
	});

	it("keeps Plex values on top of conflicting Jellyfin watch and progress maps", () => {
		queryState.libraryItem = seriesLibraryItem;
		setQueries({
			jellyfinWatch: watchResponse({
				"series:202": {
					lastWatchedAt: null,
					watchCount: 1,
					watchCountSemantics: "exact",
					watchedByUsers: [],
					onDeck: false,
					userRating: null,
					source: "jellyfin",
					ratingKey: null,
					instanceId: "jf-instance",
					collections: [],
					labels: [],
				},
			}),
			plexWatch: watchResponse({
				"series:202": {
					lastWatchedAt: null,
					watchCount: 9,
					watchCountSemantics: "exact",
					watchedByUsers: [],
					onDeck: true,
					userRating: null,
					source: "plex",
					ratingKey: "plex-rating-key",
					instanceId: "plex-instance",
					collections: [],
					labels: [],
				},
			}),
			jellyfinProgress: progressResponse({ 202: { watched: 1, total: 2, percent: 50 } }),
			plexProgress: progressResponse({ 202: { watched: 2, total: 2, percent: 100 } }),
		});

		render(<LibraryClient />);

		expect(queryState.contentProps?.watchEnrichmentMap).toMatchObject({
			"series:202": {
				source: "both",
				watchCount: 9,
				watchCountSemantics: "lower-bound",
				instanceId: "plex-instance",
				ratingKey: "plex-rating-key",
			},
		});
		expect(queryState.contentProps?.seriesProgressMap).toMatchObject({
			202: { watched: 2, percent: 100 },
		});
		expect(queryState.progressHook).toHaveBeenCalledWith([202]);
		expect(queryState.plexProgressHook).toHaveBeenCalledWith([202]);
	});

	it("does not turn overlapping exact zero counts into a zero lower bound", () => {
		setQueries({
			jellyfinWatch: watchResponse({
				"movie:101": {
					lastWatchedAt: null,
					watchCount: 0,
					watchCountSemantics: "exact",
					watchedByUsers: [],
					onDeck: false,
					userRating: null,
					source: "jellyfin",
					ratingKey: null,
					jellyfinId: "jellyfin-item",
					instanceId: "jellyfin-instance",
					collections: [],
					labels: [],
				},
			}),
			plexWatch: watchResponse({
				"movie:101": {
					lastWatchedAt: null,
					watchCount: 0,
					watchCountSemantics: "exact",
					watchedByUsers: [],
					onDeck: false,
					userRating: null,
					source: "plex",
					ratingKey: "plex-item",
					instanceId: "plex-instance",
					collections: [],
					labels: [],
				},
			}),
		});

		render(<LibraryClient />);

		expect(queryState.contentProps?.watchEnrichmentMap).toMatchObject({
			"movie:101": {
				watchCount: null,
				watchCountSemantics: "unknown",
				instanceId: "plex-instance",
				ratingKey: "plex-item",
			},
		});
	});

	it("renders exact counts, marks lower bounds, and hides unknown watch counts", async () => {
		const { LibraryCard: ActualLibraryCard } =
			await vi.importActual<typeof import("../library-card")>("../library-card");
		const { IncognitoProvider } = await import("../../../../contexts/IncognitoContext");
		const commonProps = {
			item: libraryItem,
			onToggleMonitor: vi.fn(),
			pending: false,
		};

		const exact = render(
			<IncognitoProvider>
				<ActualLibraryCard {...commonProps} watchCount={3} watchCountSemantics="exact" />
			</IncognitoProvider>,
		);
		expect(screen.getByText("3")).toBeInTheDocument();
		exact.unmount();

		const exactZero = render(
			<IncognitoProvider>
				<ActualLibraryCard {...commonProps} watchCount={0} watchCountSemantics="exact" />
			</IncognitoProvider>,
		);
		expect(screen.getByText("0")).toBeInTheDocument();
		exactZero.unmount();

		const lowerBound = render(
			<IncognitoProvider>
				<ActualLibraryCard {...commonProps} watchCount={3} watchCountSemantics="lower-bound" />
			</IncognitoProvider>,
		);
		expect(screen.getByText("3+")).toBeInTheDocument();
		expect(screen.getByTitle(/observed watch count.*lower bound/i)).toBeInTheDocument();
		lowerBound.unmount();

		const zeroLowerBound = render(
			<IncognitoProvider>
				<ActualLibraryCard {...commonProps} watchCount={0} watchCountSemantics="lower-bound" />
			</IncognitoProvider>,
		);
		expect(screen.queryByText("0+")).not.toBeInTheDocument();
		zeroLowerBound.unmount();

		render(
			<IncognitoProvider>
				<ActualLibraryCard {...commonProps} watchCount={null} watchCountSemantics="unknown" />
			</IncognitoProvider>,
		);
		expect(screen.queryByText("0")).not.toBeInTheDocument();
		expect(screen.queryByTitle(/observed watch count/i)).not.toBeInTheDocument();
	});

	it("keeps the independent Plex notice and existing enrichment hook ownership", () => {
		setQueries({
			jellyfinWatch: {
				...watchResponse(),
				isError: true,
				error: new Error("private transport failure"),
			},
			plexWatch: { data: undefined, error: new Error("plex fixture failure"), isError: true },
		});

		render(<LibraryClient />);

		expect(screen.getByRole("alert")).toHaveTextContent("Plex evidence notice");
		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
		expect(queryState.watchHook).toHaveBeenCalledTimes(1);
		expect(queryState.progressHook).toHaveBeenCalledTimes(1);
	});
});
