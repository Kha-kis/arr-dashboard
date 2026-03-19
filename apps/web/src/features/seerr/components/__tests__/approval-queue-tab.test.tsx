import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseSeerrRequests = vi.fn();
const mockUseApproveSeerrRequest = vi.fn();
const mockUseDeclineSeerrRequest = vi.fn();
const mockUseDeleteSeerrRequest = vi.fn();
const mockUseBulkSeerrRequestAction = vi.fn();

vi.mock("../../../../hooks/api/useSeerr", () => ({
	useSeerrRequests: (...args: unknown[]) => mockUseSeerrRequests(...args),
	useApproveSeerrRequest: () => mockUseApproveSeerrRequest(),
	useDeclineSeerrRequest: () => mockUseDeclineSeerrRequest(),
	useDeleteSeerrRequest: () => mockUseDeleteSeerrRequest(),
	useBulkSeerrRequestAction: () => mockUseBulkSeerrRequestAction(),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#3b82f6",
			to: "#8b5cf6",
			glow: "rgba(59,130,246,0.3)",
			fromLight: "#3b82f610",
			fromMedium: "#3b82f620",
			fromMuted: "#3b82f630",
		},
	}),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Mock next/image to a plain <img>
vi.mock("next/image", () => ({
	default: (props: Record<string, unknown>) => {
		// next/image passes non-standard props; just render essential ones
		const { src, alt, fill, priority, ...rest } = props;
		return <img src={src as string} alt={alt as string} {...rest} />;
	},
}));

// Import after mocks
import { ApprovalQueueTab } from "../approval-queue-tab";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleRequests = [
	{
		id: 1,
		status: 1,
		createdAt: "2024-01-01",
		updatedAt: "2024-01-01",
		type: "movie" as const,
		is4k: false,
		serverId: 1,
		profileId: 1,
		rootFolder: "/movies",
		media: {
			id: 1,
			tmdbId: 123,
			tvdbId: null,
			status: 1,
			mediaType: "movie",
			posterPath: "/poster1.jpg",
			title: "Movie 1",
		},
		requestedBy: { id: 1, displayName: "Alice" },
		modifiedBy: null,
		seasons: [],
	},
	{
		id: 2,
		status: 1,
		createdAt: "2024-01-02",
		updatedAt: "2024-01-02",
		type: "tv" as const,
		is4k: false,
		serverId: 1,
		profileId: 1,
		rootFolder: "/tv",
		media: {
			id: 2,
			tmdbId: 456,
			tvdbId: 789,
			status: 1,
			mediaType: "tv",
			posterPath: "/poster2.jpg",
			title: "Show 1",
		},
		requestedBy: { id: 2, displayName: "Bob" },
		modifiedBy: null,
		seasons: [],
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultMutation = {
	mutate: vi.fn(),
	mutateAsync: vi.fn(),
	isPending: false,
	isSuccess: false,
	isError: false,
	isIdle: true,
	data: undefined,
	error: null,
	reset: vi.fn(),
	status: "idle" as const,
	variables: undefined,
	context: undefined,
	failureCount: 0,
	failureReason: null,
	submittedAt: 0,
};

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

function renderTab(props?: Partial<React.ComponentProps<typeof ApprovalQueueTab>>) {
	return render(<ApprovalQueueTab instanceId="inst-1" {...props} />, {
		wrapper: createWrapper(),
	});
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let approveMutate: ReturnType<typeof vi.fn>;
let declineMutate: ReturnType<typeof vi.fn>;
let deleteMutate: ReturnType<typeof vi.fn>;
let bulkMutate: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();

	approveMutate = vi.fn();
	declineMutate = vi.fn();
	deleteMutate = vi.fn();
	bulkMutate = vi.fn();

	mockUseSeerrRequests.mockReturnValue({
		data: {
			pageInfo: { pages: 1, pageSize: 50, results: 2, page: 1 },
			results: sampleRequests,
		},
		isLoading: false,
		isFetching: false,
		isError: false,
	});

	mockUseApproveSeerrRequest.mockReturnValue({ ...defaultMutation, mutate: approveMutate });
	mockUseDeclineSeerrRequest.mockReturnValue({ ...defaultMutation, mutate: declineMutate });
	mockUseDeleteSeerrRequest.mockReturnValue({ ...defaultMutation, mutate: deleteMutate });
	mockUseBulkSeerrRequestAction.mockReturnValue({ ...defaultMutation, mutate: bulkMutate });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApprovalQueueTab", () => {
	// ======================================================================
	// 1. Rendering States
	// ======================================================================

	describe("Rendering States", () => {
		it("shows loading skeletons when isLoading is true", () => {
			mockUseSeerrRequests.mockReturnValue({
				data: undefined,
				isLoading: true,
				isFetching: true,
				isError: false,
			});

			renderTab();

			// The component renders 3 PremiumSkeleton elements with h-24 class
			const skeletons = document.querySelectorAll(".h-24");
			expect(skeletons.length).toBe(3);
		});

		it("shows error state when isError is true", () => {
			mockUseSeerrRequests.mockReturnValue({
				data: undefined,
				isLoading: false,
				isFetching: false,
				isError: true,
			});

			renderTab();

			expect(screen.getByText("Failed to Load Requests")).toBeInTheDocument();
		});

		it("shows empty state when no requests", () => {
			mockUseSeerrRequests.mockReturnValue({
				data: {
					pageInfo: { pages: 0, pageSize: 50, results: 0, page: 1 },
					results: [],
				},
				isLoading: false,
				isFetching: false,
				isError: false,
			});

			renderTab();

			expect(screen.getByText("No Pending Requests")).toBeInTheDocument();
		});
	});

	// ======================================================================
	// 2. Request List
	// ======================================================================

	describe("Request List", () => {
		it("renders correct count of pending requests", () => {
			renderTab();

			expect(screen.getByText("2 pending requests")).toBeInTheDocument();
		});

		it("renders each request with a checkbox (plus select all)", () => {
			renderTab();

			// 1 Select All + 2 per-row = 3 checkboxes
			const checkboxes = screen.getAllByRole("checkbox");
			expect(checkboxes).toHaveLength(3);
		});
	});

	// ======================================================================
	// 3. Bulk Selection
	// ======================================================================

	describe("Bulk Selection", () => {
		it("selecting an individual item shows the bulk action bar", () => {
			renderTab();

			// No bulk bar initially
			expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

			// Click first per-row checkbox (index 1; index 0 is Select All)
			const checkboxes = screen.getAllByRole("checkbox");
			fireEvent.click(checkboxes[1]!);

			expect(screen.getByText("1 selected")).toBeInTheDocument();
			expect(screen.getByText("Approve All")).toBeInTheDocument();
			expect(screen.getByText("Decline All")).toBeInTheDocument();
			expect(screen.getByText("Delete All")).toBeInTheDocument();
		});

		it("Select All toggles all checkboxes", () => {
			renderTab();

			const checkboxes = screen.getAllByRole("checkbox");
			const selectAll = checkboxes[0]!;

			fireEvent.click(selectAll);

			expect(screen.getByText("2 selected")).toBeInTheDocument();
		});

		it("deselecting all clears the bulk action bar", () => {
			renderTab();

			const checkboxes = screen.getAllByRole("checkbox");
			const selectAll = checkboxes[0]!;

			// Select all
			fireEvent.click(selectAll);
			expect(screen.getByText("2 selected")).toBeInTheDocument();

			// Deselect all
			fireEvent.click(selectAll);
			expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
		});

		it("bulk approve calls mutation with selected IDs", () => {
			renderTab();

			// Select All
			const checkboxes = screen.getAllByRole("checkbox");
			fireEvent.click(checkboxes[0]!);

			// Click Approve All
			fireEvent.click(screen.getByText("Approve All"));

			expect(bulkMutate).toHaveBeenCalledTimes(1);
			const callArgs = bulkMutate.mock.calls[0]![0];
			expect(callArgs).toMatchObject({
				instanceId: "inst-1",
				action: "approve",
			});
			expect(callArgs.requestIds).toEqual(expect.arrayContaining([1, 2]));
			expect(callArgs.requestIds).toHaveLength(2);
		});
	});

	// ======================================================================
	// 4. Individual Actions
	// ======================================================================

	describe("Individual Actions", () => {
		it("approve button calls approve mutation", () => {
			renderTab();

			// There are multiple "Approve" texts — the per-row Approve buttons
			const approveButtons = screen.getAllByText("Approve");
			fireEvent.click(approveButtons[0]!);

			expect(approveMutate).toHaveBeenCalledTimes(1);
			expect(approveMutate.mock.calls[0]![0]).toMatchObject({
				instanceId: "inst-1",
				requestId: 1,
			});
		});

		it("decline requires confirmation (two-click pattern)", () => {
			renderTab();

			// Click the first Decline button
			const declineButtons = screen.getAllByText("Decline");
			fireEvent.click(declineButtons[0]!);

			// Should now show Confirm / Cancel instead of Decline for that row
			expect(screen.getByText("Cancel")).toBeInTheDocument();
			const confirmButtons = screen.getAllByText("Confirm");
			expect(confirmButtons.length).toBeGreaterThanOrEqual(1);

			// Click Cancel — should revert
			fireEvent.click(screen.getByText("Cancel"));
			// Decline buttons should reappear (2 of them)
			expect(screen.getAllByText("Decline")).toHaveLength(2);
			expect(declineMutate).not.toHaveBeenCalled();
		});

		it("delete requires confirmation (two-click pattern)", () => {
			renderTab();

			// The delete button is an icon-only button with Trash2; find all secondary buttons
			// that contain a Trash2 icon. The per-row delete buttons are the last action buttons.
			// We can find them by looking for buttons without text that are not in the bulk bar.
			// Since the bulk bar isn't shown yet, let's find all buttons and pick the icon-only ones.
			const allButtons = screen.getAllByRole("button");

			// Filter to icon-only buttons (those that have no visible text aside from SVG)
			// The delete buttons have no text content — they just have the Trash2 icon.
			// In the rendered output, per-row delete buttons have empty text.
			const iconOnlyButtons = allButtons.filter((btn) => {
				const text = btn.textContent?.trim() ?? "";
				return text === "" || text === "\u200B";
			});
			expect(iconOnlyButtons.length).toBeGreaterThanOrEqual(2);

			// Click first delete button (row 1)
			fireEvent.click(iconOnlyButtons[0]!);

			// Should show Confirm / Cancel
			const confirmButtons = screen.getAllByText("Confirm");
			expect(confirmButtons.length).toBeGreaterThanOrEqual(1);
			const cancelButtons = screen.getAllByText("Cancel");
			expect(cancelButtons.length).toBeGreaterThanOrEqual(1);

			// Click Cancel to revert
			fireEvent.click(cancelButtons[0]!);

			expect(deleteMutate).not.toHaveBeenCalled();
		});
	});

	// ======================================================================
	// 5. Load More
	// ======================================================================

	describe("Load More", () => {
		it("shows Load More button when there are more results", () => {
			mockUseSeerrRequests.mockReturnValue({
				data: {
					pageInfo: { pages: 2, pageSize: 50, results: 100, page: 1 },
					results: sampleRequests, // only 2 loaded out of 100
				},
				isLoading: false,
				isFetching: false,
				isError: false,
			});

			renderTab();

			// "Load More (98 remaining)"
			const loadMoreButton = screen.getByRole("button", { name: /Load More/ });
			expect(loadMoreButton).toBeInTheDocument();
			expect(loadMoreButton).toHaveTextContent("98 remaining");
		});

		it("does not show Load More when all results are loaded", () => {
			renderTab();

			// Default: results=2, results.length=2 → no more
			expect(screen.queryByRole("button", { name: /Load More/ })).not.toBeInTheDocument();
		});
	});

	// ======================================================================
	// 6. Sort Control
	// ======================================================================

	describe("Sort Control", () => {
		it("renders the sort filter select with options", () => {
			renderTab();

			// FilterSelect renders a <select> element
			const select = document.querySelector("select");
			expect(select).toBeInTheDocument();

			// Should have the two sort options
			const options = select!.querySelectorAll("option");
			const optionLabels = Array.from(options).map((o) => o.textContent);
			expect(optionLabels).toContain("Newest");
			expect(optionLabels).toContain("Last Updated");
		});
	});

	// ======================================================================
	// 7. Hook Invocation
	// ======================================================================

	describe("Hook Invocation", () => {
		it("passes correct params to useSeerrRequests", () => {
			renderTab();

			expect(mockUseSeerrRequests).toHaveBeenCalledWith(
				expect.objectContaining({
					instanceId: "inst-1",
					filter: "pending",
					sort: "added",
					take: 50,
				}),
			);
		});
	});
});
