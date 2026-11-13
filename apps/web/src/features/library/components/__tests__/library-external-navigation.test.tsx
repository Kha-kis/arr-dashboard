import type { LibraryBook, LibraryItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BookBreakdownModal } from "../book-breakdown-modal";
import { EnrichedDetailModal } from "../enriched-detail-modal";
import { ItemDetailsModal } from "../item-details-modal";

// Real Library dialogs, child controls, query hooks, HTTP client and URL guards.
// Only HTTP and window.open are replaced; all fixture values are synthetic.
const movie: LibraryItem = {
	id: 41,
	instanceId: "synthetic-arr",
	instanceName: "Synthetic Radarr",
	service: "radarr",
	type: "movie",
	title: "Synthetic movie",
	monitored: true,
	hasFile: false,
	remoteIds: { tmdbId: 1041, imdbId: "tt001041", tvdbId: 2041 },
};
const author: LibraryItem = {
	id: 61,
	instanceId: "synthetic-readarr",
	instanceName: "Synthetic Readarr",
	service: "readarr",
	type: "author",
	title: "Synthetic author",
	monitored: true,
};
let client: QueryClient;
let details: Record<string, unknown>;
let books: LibraryBook[];
let unexpected: string[];
let opened: MockInstance<typeof window.open>;

const json = (payload: unknown) =>
	new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

beforeEach(() => {
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	details = {
		id: 1041,
		title: "Synthetic enriched movie",
		genres: [],
		credits: { cast: [], crew: [] },
		recommendations: { results: [] },
		similar: { results: [] },
	};
	books = [{ id: 71, authorId: 61, title: "Synthetic book", hasFile: true, monitored: true }];
	unexpected = [];
	opened = vi.spyOn(window, "open").mockReturnValue(null);
	vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
		const url = new URL(input, "http://synthetic.invalid");
		const method = options?.method ?? "GET";
		if (method === "GET") {
			if (url.pathname === "/api/seerr/discover/synthetic-seerr/movie/1041") return json(details);
			if (url.pathname === "/api/library/books") {
				expect(url.searchParams.get("instanceId")).toBe("synthetic-readarr");
				expect(url.searchParams.get("authorId")).toBe("61");
				return json({ books });
			}
			if (url.pathname === "/api/qui/tracker-icons") return json({ trackers: {} });
			if (url.pathname === "/api/qui/movie/synthetic-arr/41/torrents")
				return json({
					status: "not-configured",
					clusters: [],
					seasonGroups: [],
					actionItems: [],
					totalEpisodes: 0,
					monitoredEpisodes: 0,
					downloadedEpisodes: 0,
				});
		}
		unexpected.push(`${method} ${url.pathname}`);
		throw new Error("Unexpected fixture request");
	});
});

afterEach(async () => {
	cleanup();
	await client.cancelQueries();
	client.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	expect(unexpected).toEqual([]);
});

function mount(child: ReactNode) {
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>{child}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

async function enriched(plexUrl?: string | null) {
	mount(
		<EnrichedDetailModal
			item={movie}
			seerrInstanceId="synthetic-seerr"
			onClose={vi.fn()}
			plexUrl={plexUrl}
			mediaServerLabel="Emby"
		/>,
	);
	await screen.findByRole("heading", { name: "Synthetic enriched movie" });
}

function bookModal() {
	return (
		<BookBreakdownModal
			item={author}
			onClose={vi.fn()}
			onToggleBook={vi.fn()}
			onSearchBook={vi.fn()}
			pendingActionKey={null}
		/>
	);
}

describe("Library external navigation", () => {
	// Catches selecting a clip/non-YouTube/unsafe key or dropping anchor protections.
	it("selects the first valid YouTube trailer or teaser from enrichment", async () => {
		details.relatedVideos = [
			{ site: "Vimeo", type: "Trailer", key: "vimeo123456" },
			{ site: "YouTube", type: "Clip", key: "clip1234567" },
			{ site: "YouTube", type: "Trailer", key: "bad&key=1" },
			{ site: "YouTube", type: "Teaser", key: "teaser12345", name: "Synthetic teaser" },
			{ site: "YouTube", type: "Trailer", key: "later123456", name: "Later trailer" },
		];
		await enriched();
		const link = screen.getByRole("link", { name: "Synthetic teaser" });
		expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=teaser12345");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(screen.queryByRole("link", { name: "Later trailer" })).not.toBeInTheDocument();
	});

	// Catches a fabricated/default trailer or acceptance of an unsafe video key.
	it("omits the trailer when enrichment has no usable video or no videos field", async () => {
		details.relatedVideos = [
			{ site: "YouTube", type: "Trailer", key: "bad&key=1", name: "Unsafe trailer" },
		];
		await enriched();
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Trailer" })).not.toBeInTheDocument();
		delete details.relatedVideos;
		await act(async () => {
			await client.invalidateQueries();
		});
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Trailer" })).not.toBeInTheDocument();
	});

	// Catches lost Library IDs, a wrong movie path or a discarded server URL/label.
	it("opens enriched movie metadata and its supplied media-server destination safely", async () => {
		await enriched("https://media.synthetic.invalid/web/index.html#!/item?id=41");
		for (const name of ["TMDB", "IMDB", "TVDB", "Watch in Emby"])
			fireEvent.click(screen.getByRole("button", { name }));
		expect(opened.mock.calls).toEqual([
			["https://www.themoviedb.org/movie/1041", "_blank", "noopener,noreferrer"],
			["https://www.imdb.com/title/tt001041", "_blank", "noopener,noreferrer"],
			["https://www.thetvdb.com/dereferrer/series/2041", "_blank", "noopener,noreferrer"],
			[
				"https://media.synthetic.invalid/web/index.html#!/item?id=41",
				"_blank",
				"noopener,noreferrer",
			],
		]);
	});

	// Catches loss of the basic Library modal's IDs or using movie URLs for series.
	it("opens basic series metadata with the TV destination", () => {
		mount(
			<ItemDetailsModal
				item={{
					...movie,
					id: 51,
					instanceId: "synthetic-sonarr",
					service: "sonarr",
					type: "series",
					remoteIds: { tmdbId: 1051, imdbId: "tt001051", tvdbId: 2051 },
				}}
				onClose={vi.fn()}
			/>,
		);
		for (const name of ["TMDB", "IMDB", "TVDB"])
			fireEvent.click(screen.getByRole("button", { name }));
		expect(opened.mock.calls).toEqual([
			["https://www.themoviedb.org/tv/1051", "_blank", "noopener,noreferrer"],
			["https://www.imdb.com/title/tt001051", "_blank", "noopener,noreferrer"],
			["https://www.thetvdb.com/dereferrer/series/2051", "_blank", "noopener,noreferrer"],
		]);
	});

	// Shared guards have their URL matrix elsewhere; this catches lost Library wiring.
	it("shows an unsafe supplied watch link as unavailable and omits absent destinations", () => {
		const modal = (plexUrl?: string) => (
			<EnrichedDetailModal
				item={{ ...movie, remoteIds: {} }}
				seerrInstanceId="synthetic-seerr"
				onClose={vi.fn()}
				plexUrl={plexUrl}
				mediaServerLabel="Emby"
			/>
		);
		mount(modal("javascript:synthetic()"));
		expect(screen.getByText("Watch link unavailable.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Watch in/ })).not.toBeInTheDocument();
		for (const name of ["TMDB", "IMDB", "TVDB"])
			expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
		cleanup();
		mount(modal());
		expect(screen.queryByRole("heading", { name: "External Links" })).not.toBeInTheDocument();
		expect(screen.queryByText("Watch link unavailable.")).not.toBeInTheDocument();
		expect(opened).not.toHaveBeenCalled();
	});

	// Catches selecting the parent ID/type or omitting either carousel's callback.
	it("opens the selected recommendation and similar title with their own media types", async () => {
		details.recommendations = {
			results: [{ id: 3041, mediaType: "movie", title: "Synthetic recommendation" }],
		};
		details.similar = {
			results: [{ id: 4051, mediaType: "tv", name: "Synthetic similar series" }],
		};
		await enriched();
		fireEvent.click(screen.getByRole("button", { name: "Open Synthetic recommendation" }));
		fireEvent.click(screen.getByRole("button", { name: "Open Synthetic similar series" }));
		expect(opened.mock.calls).toEqual([
			["https://www.themoviedb.org/movie/3041", "_blank", "noopener,noreferrer"],
			["https://www.themoviedb.org/tv/4051", "_blank", "noopener,noreferrer"],
		]);
	});

	// Catches links moved outside expansion, wrong book IDs, or lost anchor protections.
	it("reveals Goodreads and Amazon links for the expanded book with external IDs", async () => {
		books[0] = { ...books[0]!, foreignBookId: "9071", asin: "B0SYNTH071" };
		mount(bookModal());
		const expand = await screen.findByRole("button", { name: "Synthetic book" });
		expect(screen.queryByRole("link", { name: "Goodreads" })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Amazon" })).not.toBeInTheDocument();
		fireEvent.click(expand);
		expect(screen.getByRole("link", { name: "Goodreads" })).toHaveAttribute(
			"href",
			"https://www.goodreads.com/book/show/9071",
		);
		expect(screen.getByRole("link", { name: "Amazon" })).toHaveAttribute(
			"href",
			"https://www.amazon.com/dp/B0SYNTH071",
		);
		for (const name of ["Goodreads", "Amazon"]) {
			expect(screen.getByRole("link", { name })).toHaveAttribute("target", "_blank");
			expect(screen.getByRole("link", { name })).toHaveAttribute("rel", "noopener noreferrer");
		}
		fireEvent.click(expand);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});

	// Catches deriving bogus external book links from the local Readarr ID.
	it("omits Goodreads and Amazon when the expanded book has no external IDs", async () => {
		mount(bookModal());
		fireEvent.click(await screen.findByRole("button", { name: "Synthetic book" }));
		expect(screen.getByRole("button", { name: "Synthetic book" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(screen.queryByRole("link", { name: "Goodreads" })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Amazon" })).not.toBeInTheDocument();
	});
});
