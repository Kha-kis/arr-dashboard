import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

const viewState = vi.hoisted(() => ({
	failed: true,
	feedback: null as null | { type: "error"; message: string; incognitoMessage: string },
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#fff", to: "#aaa" } }),
}));
vi.mock("../../../../hooks/api/useSearch", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/api/useSearch")>()),
	useSearchIndexersQuery: () => ({
		data: viewState.failed
			? {
					instances: [{ instanceId: "p-1", instanceName: "Prowlarr", success: false, data: [] }],
					aggregated: [],
					totalCount: 0,
					failedInstanceCount: 1,
				}
			: { instances: [], aggregated: [], totalCount: 0, failedInstanceCount: 0 },
		isLoading: false,
		error: null,
	}),
}));
vi.mock("../../hooks/use-search-indexers", () => ({ useSearchIndexers: () => undefined }));
vi.mock("../../hooks/use-search-state", () => ({
	useSearchState: () => ({
		query: "",
		searchType: "all",
		selectedIndexers: {},
		validationError: null,
		feedback: viewState.feedback,
		grabbingKey: null,
		hasSearched: false,
		filters: {},
		sort: {},
		actions: {},
	}),
}));
vi.mock("../../hooks/use-search-actions", () => ({
	useSearchActions: () => ({
		results: [],
		handleSearch: vi.fn(),
		handleSubmit: vi.fn(),
		handleGrab: vi.fn(),
		handleCopyMagnet: vi.fn(),
		handleOpenInfo: vi.fn(),
		isSearching: false,
	}),
}));
vi.mock("../../hooks/use-search-data", () => ({
	useSearchData: () => ({ results: [], filtersActive: false, hidden: 0 }),
}));
vi.mock("../../hooks/use-search-pagination", () => ({
	useSearchPagination: () => ({
		page: 1,
		pageSize: 25,
		paginatedResults: [],
		setPage: vi.fn(),
		setPageSize: vi.fn(),
	}),
}));

import { SearchClient } from "../search-client";

let client: QueryClient;

beforeEach(() => {
	viewState.failed = true;
	viewState.feedback = null;
	window.localStorage.clear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

describe("SearchClient provider coverage", () => {
	it("shows provider unavailability instead of a configuration prompt when the configured indexer read failed", () => {
		render(
			<QueryClientProvider client={client}>
				<IncognitoProvider>
					<SearchClient />
				</IncognitoProvider>
			</QueryClientProvider>,
		);
		expect(screen.getByText("Prowlarr indexers unavailable")).toBeInTheDocument();
		expect(screen.queryByText("Prowlarr Configuration Required")).not.toBeInTheDocument();
	});

	it("switches an existing private feedback message to its safe version on incognito toggle", () => {
		viewState.failed = false;
		viewState.feedback = {
			type: "error",
			message: 'Provider rejected "PRIVATE_RELEASE_A"',
			incognitoMessage: "Could not confirm the grab result. Check Prowlarr before retrying.",
		};
		render(
			<QueryClientProvider client={client}>
				<IncognitoProvider>
					<SearchClient />
				</IncognitoProvider>
			</QueryClientProvider>,
		);
		expect(screen.getByText('Provider rejected "PRIVATE_RELEASE_A"')).toBeInTheDocument();

		act(() => {
			window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});

		expect(
			screen.getByText("Could not confirm the grab result. Check Prowlarr before retrying."),
		).toBeInTheDocument();
		expect(screen.queryByText(/PRIVATE_RELEASE_A/)).not.toBeInTheDocument();
	});
});
