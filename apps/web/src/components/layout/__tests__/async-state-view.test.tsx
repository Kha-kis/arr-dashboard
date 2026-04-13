import { fireEvent, render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

// useThemeGradient pulls in a context provider; mock with a stub gradient.
vi.mock("../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#7c3aed",
			to: "#a855f7",
			glow: "rgba(124,58,237,0.4)",
			fromLight: "rgba(124,58,237,0.15)",
		},
	}),
}));

import { AsyncStateView } from "../async-state-view";

const baseEmpty = {
	icon: Inbox,
	title: "Nothing here",
	description: "Items will appear soon.",
};

describe("AsyncStateView", () => {
	it("renders children in success state", () => {
		render(
			<AsyncStateView emptyState={baseEmpty}>
				<p>Loaded content</p>
			</AsyncStateView>,
		);
		expect(screen.getByText("Loaded content")).toBeInTheDocument();
	});

	it("renders the loading skeleton with aria-busy", () => {
		const { container } = render(
			<AsyncStateView isLoading emptyState={baseEmpty}>
				<p>Loaded content</p>
			</AsyncStateView>,
		);
		expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
		expect(screen.queryByText("Loaded content")).not.toBeInTheDocument();
	});

	it("renders the empty state when isEmpty is true", () => {
		render(
			<AsyncStateView isEmpty emptyState={baseEmpty}>
				<p>Loaded content</p>
			</AsyncStateView>,
		);
		expect(screen.getByText("Nothing here")).toBeInTheDocument();
		expect(screen.getByText("Items will appear soon.")).toBeInTheDocument();
		expect(screen.queryByText("Loaded content")).not.toBeInTheDocument();
	});

	it("renders the error state with retry, calling onRetry on click", () => {
		const onRetry = vi.fn();
		render(
			<AsyncStateView
				isError
				error={new Error("Network exploded")}
				onRetry={onRetry}
				emptyState={baseEmpty}
			>
				<p>Loaded content</p>
			</AsyncStateView>,
		);

		expect(screen.getByText("Couldn't load data")).toBeInTheDocument();
		expect(screen.getByText("Network exploded")).toBeInTheDocument();
		expect(screen.queryByText("Loaded content")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("falls back to a default error description when no error provided", () => {
		render(
			<AsyncStateView isError emptyState={baseEmpty}>
				<p>Loaded content</p>
			</AsyncStateView>,
		);
		expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
	});

	it("prioritises error over loading and empty", () => {
		render(
			<AsyncStateView isError isLoading isEmpty error={new Error("Nope")} emptyState={baseEmpty}>
				<p>Loaded content</p>
			</AsyncStateView>,
		);
		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(screen.queryByText("Nothing here")).not.toBeInTheDocument();
	});

	it("omits the retry button when no onRetry handler is supplied", () => {
		render(
			<AsyncStateView isError error={new Error("X")} emptyState={baseEmpty}>
				<p>Loaded content</p>
			</AsyncStateView>,
		);
		expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
	});
});
