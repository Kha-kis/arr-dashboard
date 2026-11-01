import { SEERR_MEDIA_STATUS, type SeerrDiscoverResult } from "@arr/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DiscoverPosterCard } from "../discover-poster-card";

const item: SeerrDiscoverResult = {
	id: 101,
	mediaType: "movie",
	title: "Synthetic selection",
	posterPath: "/synthetic-poster.jpg",
	releaseDate: "2025-06-15",
	voteAverage: 8.2,
	mediaInfo: {
		id: 201,
		tmdbId: 101,
		status: SEERR_MEDIA_STATUS.AVAILABLE,
		createdAt: "2025-06-15T00:00:00Z",
		updatedAt: "2025-06-15T00:00:00Z",
	},
};

function wrapper({ children }: { children: ReactNode }) {
	return (
		<ColorThemeProvider>
			<IncognitoProvider>{children}</IncognitoProvider>
		</ColorThemeProvider>
	);
}

function EnableIncognito() {
	const [, setIncognitoMode] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setIncognitoMode(true)}>
			Enable incognito
		</button>
	);
}

describe("DiscoverPosterCard", () => {
	beforeEach(() => {
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
	});

	afterEach(() => {
		cleanup();
		localStorage.removeItem("arr-dashboard-incognito-mode");
	});

	it("exposes a native non-submit button with its poster and metadata", () => {
		render(<DiscoverPosterCard item={item} onClick={vi.fn()} index={2} />, { wrapper });

		const card = screen.getByRole("button", { name: "Open Synthetic selection" });
		expect(card.tagName).toBe("BUTTON");
		expect(card).toHaveAttribute("type", "button");
		expect(card).toHaveClass("w-[160px]", "animate-in", "slide-in-from-bottom-2");
		expect(card).toHaveStyle({ animationDelay: "60ms", animationFillMode: "backwards" });
		expect(within(card).getByRole("img", { name: "Synthetic selection" })).toHaveAttribute(
			"src",
			"https://image.tmdb.org/t/p/w300/synthetic-poster.jpg",
		);
		expect(within(card).getByText("2025")).toBeInTheDocument();
		expect(within(card).getByText("Available")).toBeInTheDocument();
		expect(within(card).getByText("8.2")).toBeInTheDocument();
		expect(card.querySelector("div, p, button, a, input, select, textarea, [tabindex]")).toBeNull();
	});

	it("calls onClick once with the original item without submitting an enclosing form", () => {
		const onClick = vi.fn();
		const onSubmit = vi.fn((event) => event.preventDefault());
		render(
			<form onSubmit={onSubmit}>
				<DiscoverPosterCard item={item} onClick={onClick} index={0} />
			</form>,
			{ wrapper },
		);

		fireEvent.click(screen.getByRole("button", { name: "Open Synthetic selection" }));

		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onClick.mock.calls[0]?.[0]).toBe(item);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("keeps the title fallback when the poster fails", () => {
		render(<DiscoverPosterCard item={item} onClick={vi.fn()} index={0} />, { wrapper });
		fireEvent.error(screen.getByRole("img", { name: "Synthetic selection" }));

		const card = screen.getByRole("button", { name: "Open Synthetic selection" });
		expect(within(card).queryByRole("img")).not.toBeInTheDocument();
		expect(within(card).getAllByText("Synthetic selection")).toHaveLength(2);
		expect(card.querySelector("div, p")).toBeNull();
	});

	it("keeps the TV fallback, first-air year and anime badge without a poster", () => {
		const tvItem: SeerrDiscoverResult = {
			id: 102,
			mediaType: "tv",
			name: "Synthetic series",
			firstAirDate: "2024-06-15",
			genreIds: [16],
			originalLanguage: "ja",
		};
		render(<DiscoverPosterCard item={tvItem} onClick={vi.fn()} index={0} />, { wrapper });

		const card = screen.getByRole("button", { name: "Open Synthetic series" });
		expect(within(card).queryByRole("img")).not.toBeInTheDocument();
		expect(within(card).getAllByText("Synthetic series")).toHaveLength(2);
		expect(within(card).getByText("2024")).toBeInTheDocument();
		expect(within(card).getByText("Anime")).toBeInTheDocument();
		expect(card.querySelector("div, p")).toBeNull();
	});

	it("masks visible and accessible titles when the actual provider starts in incognito mode", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const { container } = render(<DiscoverPosterCard item={item} onClick={vi.fn()} index={0} />, {
			wrapper,
		});

		const card = screen.getByRole("button", { name: /^Open .+\.iso$/ });
		expect(within(card).getAllByText(/\.iso$/)).toHaveLength(2);
		expect(within(card).queryByRole("img")).not.toBeInTheDocument();
		expect(container.innerHTML).not.toContain("Synthetic selection");
		expect(container.innerHTML).not.toContain("synthetic-poster.jpg");
	});

	it("removes the original accessible name and image alt when incognito is enabled", () => {
		const { container } = render(
			<>
				<EnableIncognito />
				<DiscoverPosterCard item={item} onClick={vi.fn()} index={0} />
			</>,
			{ wrapper },
		);
		expect(screen.getByRole("img", { name: "Synthetic selection" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Enable incognito" }));

		expect(screen.getByRole("button", { name: /^Open .+\.iso$/ })).toBeInTheDocument();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(container.innerHTML).not.toContain("Synthetic selection");
		expect(container.innerHTML).not.toContain("synthetic-poster.jpg");
	});
});
