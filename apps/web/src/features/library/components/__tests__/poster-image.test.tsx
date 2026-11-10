import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { PosterImage } from "../poster-image";

const tmdb = "https://image.tmdb.org/t/p/w185/synthetic.jpg";
const arr = "https://arr.example.test/synthetic.jpg";
const image = () => screen.getByRole<HTMLImageElement>("img", { name: "Synthetic poster" });

afterEach(cleanup);

describe("PosterImage runtime fallback", () => {
	it.each(["eager", "lazy"] as const)(
		"preserves explicit %s loading through the ARR fallback",
		(loading) => {
			render(
				<PosterImage
					tmdbPosterPath="/synthetic.jpg"
					arrPosterUrl={arr}
					alt="Synthetic poster"
					loading={loading}
				/>,
				{ wrapper: IncognitoProvider },
			);
			expect(image()).toHaveAttribute("src", tmdb);
			expect(image()).toHaveAttribute("loading", loading);
			fireEvent.error(image());
			expect(image()).toHaveAttribute("src", arr);
			expect(image()).toHaveAttribute("loading", loading);
		},
	);

	it("leaves native loading unchanged when no hint is supplied", () => {
		render(
			<PosterImage tmdbPosterPath="/synthetic.jpg" arrPosterUrl={arr} alt="Synthetic poster" />,
			{ wrapper: IncognitoProvider },
		);
		expect(image()).not.toHaveAttribute("loading");
		fireEvent.error(image());
		expect(image()).toHaveAttribute("src", arr);
		expect(image()).not.toHaveAttribute("loading");
	});

	it("tries TMDB then ARR before showing an honest static unavailable placeholder", () => {
		render(
			<PosterImage tmdbPosterPath="/synthetic.jpg" arrPosterUrl={arr} alt="Synthetic poster" />,
			{ wrapper: IncognitoProvider },
		);
		const primary = image();
		expect(primary).toHaveAttribute("src", tmdb);
		fireEvent.error(primary);
		const fallback = image();
		expect(fallback).toHaveAttribute("src", arr);
		fireEvent.error(fallback);
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("Poster unavailable")).toBeInTheDocument();
		fireEvent.error(primary);
		fireEvent.error(fallback);
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it.each([undefined, "invalid-path"])("uses ARR when TMDB path is %s", (tmdbPosterPath) => {
		render(
			<PosterImage tmdbPosterPath={tmdbPosterPath} arrPosterUrl={arr} alt="Synthetic poster" />,
			{
				wrapper: IncognitoProvider,
			},
		);
		expect(image()).toHaveAttribute("src", arr);
		fireEvent.error(image());
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("Poster unavailable")).toBeInTheDocument();
	});

	it("shows unavailable immediately without usable artwork", () => {
		render(<PosterImage alt="Synthetic poster" />, { wrapper: IncognitoProvider });
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("Poster unavailable")).toBeInTheDocument();
	});

	it("does not retry the same URL when TMDB and ARR resolve identically", () => {
		render(
			<PosterImage tmdbPosterPath="/synthetic.jpg" arrPosterUrl={tmdb} alt="Synthetic poster" />,
			{ wrapper: IncognitoProvider },
		);
		fireEvent.error(image());
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("Poster unavailable")).toBeInTheDocument();
	});

	it.each([
		{
			tmdbPosterPath: "/replacement.jpg",
			arrPosterUrl: arr,
			size: "w185" as const,
			want: "https://image.tmdb.org/t/p/w185/replacement.jpg",
		},
		{
			tmdbPosterPath: "/synthetic.jpg",
			arrPosterUrl: "https://arr.example.test/replacement.jpg",
			size: "w185" as const,
			want: tmdb,
		},
		{
			tmdbPosterPath: "/synthetic.jpg",
			arrPosterUrl: arr,
			size: "w500" as const,
			want: "https://image.tmdb.org/t/p/w500/synthetic.jpg",
		},
	])("resets exhausted attempts for changed source inputs $want", ({ want, ...props }) => {
		const { rerender } = render(
			<PosterImage tmdbPosterPath="/synthetic.jpg" arrPosterUrl={arr} alt="Synthetic poster" />,
			{ wrapper: IncognitoProvider },
		);
		fireEvent.error(image());
		fireEvent.error(image());
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		rerender(<PosterImage {...props} alt="Synthetic poster" />);
		expect(image()).toHaveAttribute("src", want);
	});

	it("ignores late errors from a replaced source pair", () => {
		const { rerender } = render(
			<PosterImage tmdbPosterPath="/synthetic.jpg" arrPosterUrl={arr} alt="Synthetic poster" />,
			{ wrapper: IncognitoProvider },
		);
		const oldImage = image();
		rerender(
			<PosterImage arrPosterUrl="https://arr.example.test/new.jpg" alt="Synthetic poster" />,
		);
		fireEvent.error(oldImage);
		expect(image()).toHaveAttribute("src", "https://arr.example.test/new.jpg");
	});

	it("does not let a repeated old TMDB error consume the current ARR attempt", () => {
		render(
			<PosterImage tmdbPosterPath="/synthetic.jpg" arrPosterUrl={arr} alt="Synthetic poster" />,
			{ wrapper: IncognitoProvider },
		);
		const primary = image();
		fireEvent.error(primary);
		expect(image()).toHaveAttribute("src", arr);
		fireEvent.error(primary);
		expect(image()).toHaveAttribute("src", arr);
	});

	it("keeps alt, classes, size and custom placeholder while unrelated props change", () => {
		const { rerender } = render(
			<PosterImage
				tmdbPosterPath="/synthetic.jpg"
				arrPosterUrl={arr}
				size="w500"
				alt="Synthetic poster"
				imgClassName="object-contain"
				placeholder="Artwork unavailable"
			/>,
			{ wrapper: IncognitoProvider },
		);
		expect(image()).toHaveAttribute("src", "https://image.tmdb.org/t/p/w500/synthetic.jpg");
		expect(image()).toHaveClass("object-contain");
		fireEvent.error(image());
		rerender(
			<PosterImage
				tmdbPosterPath="/synthetic.jpg"
				arrPosterUrl={arr}
				size="w500"
				alt="Updated synthetic poster"
				imgClassName="rounded"
				placeholder="Custom unavailable"
			/>,
		);
		const fallback = screen.getByRole("img", { name: "Updated synthetic poster" });
		expect(fallback).toHaveAttribute("src", arr);
		expect(fallback).toHaveClass("rounded");
		fireEvent.error(fallback);
		expect(screen.getByText("Custom unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});
});
