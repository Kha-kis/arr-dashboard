import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

const queryState = vi.hoisted(() => ({
	current: {
		data: undefined as unknown,
		isLoading: false,
		isError: true,
		isRefetching: false,
		refetch: vi.fn(),
	},
}));

vi.mock("../../../../hooks/api/useTautulli", () => ({
	useWatchHistory: () => queryState.current,
}));

import { WatchHistorySection } from "../watch-history-section";

const historyItem = {
	title: "Synthetic Movie",
	grandparentTitle: undefined,
	mediaType: "movie" as const,
	watchedAt: "2026-09-16T20:00:00.000Z",
	user: "Synthetic Viewer",
	ratingKey: "rating-1",
};

const completeAvailability = {
	status: "complete" as const,
	configuredSources: 1,
	availableSources: 1,
};

function renderHistory() {
	return render(
		<IncognitoProvider>
			<WatchHistorySection enabled />
		</IncognitoProvider>,
	);
}

beforeEach(() => {
	localStorage.removeItem("arr-dashboard-incognito-mode");
	queryState.current = {
		data: undefined as unknown,
		isLoading: false,
		isError: true,
		isRefetching: false,
		refetch: vi.fn(),
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("watch history availability rendering", () => {
	it("shows a generic unavailable state for a cold error", () => {
		renderHistory();

		expect(screen.getByRole("status")).toHaveTextContent(/watch history is unavailable/i);
		expect(screen.queryByText(/private|token|http/i)).not.toBeInTheDocument();
	});

	it("retains warm rows with a stale notice without exposing error details", () => {
		queryState.current = {
			data: { history: [historyItem], totalCount: 1, availability: completeAvailability },
			isLoading: false,
			isError: true,
			isRefetching: false,
			refetch: vi.fn(),
		};

		renderHistory();

		expect(screen.getByText("Synthetic Movie")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(/stale/i);
		expect(screen.queryByText(/private|token|http/i)).not.toBeInTheDocument();
	});

	it("labels partial rows as incomplete and does not show an exact total", () => {
		queryState.current = {
			data: {
				history: [historyItem],
				totalCount: 1,
				availability: { status: "partial", configuredSources: 2, availableSources: 1 },
			},
			isLoading: false,
			isError: false,
			isRefetching: false,
			refetch: vi.fn(),
		};

		renderHistory();

		expect(screen.getByText("Synthetic Movie")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(/incomplete/i);
		expect(screen.queryByText(/total|loaded/i)).not.toBeInTheDocument();
	});

	it("retains both stale and incomplete disclosure after a partial result fails to refresh", () => {
		queryState.current = {
			data: {
				history: [historyItem],
				totalCount: 1,
				availability: { status: "partial", configuredSources: 2, availableSources: 1 },
			},
			isLoading: false,
			isError: true,
			isRefetching: false,
			refetch: vi.fn(),
		};
		renderHistory();
		expect(screen.getByText("Synthetic Movie")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(/stale.*incomplete.*unknown/i);
		expect(screen.queryByText(/total|loaded/i)).not.toBeInTheDocument();
	});

	it("shows incomplete coverage when partial history has no returned rows", () => {
		queryState.current = {
			data: {
				history: [],
				totalCount: 0,
				availability: { status: "partial", configuredSources: 2, availableSources: 1 },
			},
			isLoading: false,
			isError: false,
			isRefetching: false,
			refetch: vi.fn(),
		};

		renderHistory();

		expect(screen.getByRole("status")).toHaveTextContent(/coverage is incomplete/i);
		expect(screen.getByRole("status")).toHaveTextContent(/complete history is unknown/i);
	});

	it("clears stale coverage after a successful recovery", async () => {
		queryState.current = {
			data: { history: [historyItem], totalCount: 1, availability: completeAvailability },
			isLoading: false,
			isError: true,
			isRefetching: false,
			refetch: vi.fn(),
		};
		const view = renderHistory();
		expect(screen.getByRole("status")).toHaveTextContent(/stale/i);

		queryState.current = {
			data: { history: [historyItem], totalCount: 1, availability: completeAvailability },
			isLoading: false,
			isError: false,
			isRefetching: false,
			refetch: vi.fn(),
		};
		view.rerender(
			<IncognitoProvider>
				<WatchHistorySection enabled />
			</IncognitoProvider>,
		);

		await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
		expect(screen.getByText(/1 loaded/i)).toBeInTheDocument();
	});

	it("keeps history titles and users incognito", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		queryState.current = {
			data: { history: [historyItem], totalCount: 1, availability: completeAvailability },
			isLoading: false,
			isError: false,
			isRefetching: false,
			refetch: vi.fn(),
		};

		renderHistory();

		await waitFor(() => {
			expect(screen.queryByText("Synthetic Movie")).not.toBeInTheDocument();
			expect(screen.queryByText("Synthetic Viewer")).not.toBeInTheDocument();
		});
	});
});
