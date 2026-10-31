import type { LibraryItem } from "@arr/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryCard } from "../library-card";

const populated: LibraryItem = {
	id: 1033,
	instanceId: "synthetic-series-instance",
	instanceName: "Synthetic Sonarr",
	service: "sonarr",
	type: "series",
	title: "Synthetic populated series",
	titleSlug: "synthetic-populated-series",
	sortTitle: "Synthetic populated series",
	year: 2024,
	monitored: true,
	hasFile: true,
	status: "continuing",
	qualityProfileId: 12,
	qualityProfileName: "Synthetic HD",
	languageProfileId: 1,
	languageProfileName: "English",
	rootFolderPath: "/synthetic/series",
	path: "/synthetic/series/1033",
	sizeOnDisk: 3000000,
	cutoffUnmet: false,
	torrentState: "seeding",
	torrentRatio: 2,
	overview:
		"A synthetic overview that is deliberately longer than the Card read-more threshold, providing useful populated details without real user content. This remains the same original Library item.",
	runtime: 44,
	added: "2026-10-20T00:00:00.000Z",
	updated: "2026-10-25T00:00:00.000Z",
	genres: ["Documentary", "Adventure"],
	tags: ["synthetic"],
	seasons: [
		{
			seasonNumber: 1,
			title: "Season 1",
			monitored: true,
			episodeCount: 4,
			episodeFileCount: 4,
			missingEpisodeCount: 0,
		},
	],
	remoteIds: { tvdbId: 1033 },
	ratings: { value: 8, votes: 10 },
	statistics: {
		seasonCount: 1,
		episodeCount: 4,
		episodeFileCount: 4,
		totalEpisodeCount: 4,
		monitoredSeasons: 1,
	},
};
const wrap = (children: ReactNode) => (
	<ColorThemeProvider>
		<IncognitoProvider>{children}</IncognitoProvider>
	</ColorThemeProvider>
);
function card(item = populated, expand = vi.fn()) {
	return (
		<LibraryCard item={item} onToggleMonitor={vi.fn()} pending={false} onExpandDetails={expand} />
	);
}
beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("Library Card native detail controls", () => {
	it("keeps the item title exposed as a level-three heading containing a native non-submit button", () => {
		render(wrap(card()));
		const heading = screen.getByRole("heading", { level: 3, name: "Synthetic populated series" });
		const title = within(heading).getByRole("button", { name: "Synthetic populated series" });
		expect(title.tagName).toBe("BUTTON");
		expect(title).toHaveAttribute("type", "button");
	});

	it("dispatches the exact original item from the title without submitting the enclosing form", () => {
		const expand = vi.fn(),
			submit = vi.fn((event) => event.preventDefault());
		render(wrap(<form onSubmit={submit}>{card(populated, expand)}</form>));
		fireEvent.click(screen.getByRole("button", { name: "Synthetic populated series" }));
		expect(expand).toHaveBeenCalledTimes(1);
		expect(expand.mock.calls[0]?.[0]).toBe(populated);
		expect(submit).not.toHaveBeenCalled();
	});

	it("makes Read more explicitly non-submit", () => {
		render(wrap(card()));
		expect(screen.getByRole("button", { name: "Read more..." })).toHaveAttribute("type", "button");
	});

	it("dispatches the exact original item from Read more without submitting the enclosing form", () => {
		const expand = vi.fn(),
			submit = vi.fn((event) => event.preventDefault());
		render(wrap(<form onSubmit={submit}>{card(populated, expand)}</form>));
		fireEvent.click(screen.getByRole("button", { name: "Read more..." }));
		expect(expand).toHaveBeenCalledTimes(1);
		expect(expand.mock.calls[0]?.[0]).toBe(populated);
		expect(submit).not.toHaveBeenCalled();
	});

	it("keeps incognito title and overview masked while dispatching the unmodified original item", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const expand = vi.fn();
		const { container } = render(wrap(card(populated, expand)));
		const heading = container.querySelector("h3")!;
		expect(heading.textContent).toBeTruthy();
		expect(heading.textContent).not.toContain(populated.title);
		expect(screen.queryByText(populated.title)).not.toBeInTheDocument();
		expect(screen.queryByText(populated.overview!)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Read more..." })).not.toBeInTheDocument();
		// On the parent this is the synthetic-role heading; after the fix it is
		// the real nested button. Heading semantics are asserted independently.
		fireEvent.click(within(heading).queryByRole("button") ?? heading);
		expect(expand.mock.calls[0]?.[0]).toBe(populated);
	});
});

describe("Library Card stable semantic badge identity", () => {
	const withMissing = (item: LibraryItem, count: number): LibraryItem => {
		if (item.type === "series")
			return {
				...item,
				seasons: [
					{
						seasonNumber: 1,
						monitored: true,
						episodeCount: 4,
						episodeFileCount: 4 - count,
						missingEpisodeCount: count,
					},
				],
			};
		if (item.type === "artist")
			return {
				...item,
				statistics: {
					albumCount: 1,
					totalTrackCount: 4,
					trackCount: 4,
					trackFileCount: 4 - count,
					missingTrackCount: count,
				},
			};
		return {
			...item,
			statistics: {
				bookCount: 4,
				totalBookCount: 4,
				bookFileCount: 4 - count,
				missingBookCount: count,
			},
		};
	};
	it.each([
		{ type: "series", service: "sonarr", fileLabel: "Files on disk" },
		{ type: "artist", service: "lidarr", fileLabel: "Tracks on disk" },
		{ type: "author", service: "readarr", fileLabel: "Books on disk" },
	] as const)(
		"retains the $type provider badge node when an earlier missing badge is inserted and its count changes",
		({ type, service, fileLabel }) => {
			const item = withMissing({ ...populated, type, service }, 0);
			const { rerender } = render(wrap(card(item)));
			const provider = screen.getByText("continuing"),
				availability = screen.getByText(fileLabel);
			const originalStyle = provider.getAttribute("style");
			rerender(wrap(card(withMissing(item, 1))));
			expect(screen.getByText("continuing")).toBe(provider);
			expect(screen.getByText(fileLabel)).toBe(availability);
			expect(screen.getByText("1 missing")).toHaveClass("text-red-200");
			expect(provider.getAttribute("style")).toBe(originalStyle);
			rerender(wrap(card(withMissing(item, 2))));
			expect(screen.getByText("continuing")).toBe(provider);
			expect(screen.getByText("2 missing")).toHaveClass("text-red-200");
			rerender(wrap(card(withMissing(item, 0))));
			expect(screen.getByText("continuing")).toBe(provider);
			expect(screen.queryByText("2 missing")).not.toBeInTheDocument();
		},
	);

	it("retains the provider badge node when an earlier missing badge is removed", () => {
		const item = withMissing(populated, 1);
		const { rerender } = render(wrap(card(item)));
		const provider = screen.getByText("continuing");
		rerender(wrap(card(withMissing(item, 0))));
		expect(screen.getByText("continuing")).toBe(provider);
		expect(screen.queryByText("1 missing")).not.toBeInTheDocument();
	});

	it("does not confuse provider status with another badge having the same visible label", () => {
		const item = withMissing({ ...populated, status: "1 missing" }, 0);
		const { rerender } = render(wrap(card(item)));
		const provider = screen.getByText("1 missing");
		rerender(wrap(card(withMissing(item, 1))));
		const [missing, stillProvider] = screen.getAllByText("1 missing");
		expect(stillProvider).toBe(provider);
		expect(missing).not.toBe(provider);
		expect(missing).toHaveClass("text-red-200");
		expect(provider).not.toHaveClass("text-red-200");
		rerender(wrap(card(withMissing(item, 0))));
		expect(screen.getByText("1 missing")).toBe(provider);
	});
});
