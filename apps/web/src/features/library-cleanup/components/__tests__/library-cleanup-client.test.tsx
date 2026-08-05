import type { CleanupConfigResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

// ---------------------------------------------------------------------------
// jsdom polyfills required by Radix UI (Dialog, Switch)
// ---------------------------------------------------------------------------

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
	Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
	Element.prototype.releasePointerCapture = () => {};
}

// ---------------------------------------------------------------------------
// Default mutation mock — all useMutation hooks return this shape
// ---------------------------------------------------------------------------

function defaultMutation(overrides: Record<string, unknown> = {}) {
	return {
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
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock: useLibraryCleanup — all hooks
// ---------------------------------------------------------------------------

const mockUseCleanupConfig = vi.fn();
const mockUseUpdateCleanupConfig = vi.fn();
const mockUseCleanupPreview = vi.fn();
const mockUseCleanupExecute = vi.fn();
const mockUseCleanupExplain = vi.fn();
const mockUseCreateCleanupRule = vi.fn();
const mockUseUpdateCleanupRule = vi.fn();
const mockUseDeleteCleanupRule = vi.fn();
const mockUseReorderCleanupRules = vi.fn();
const mockUseCleanupFieldOptions = vi.fn();
const mockUseCleanupApprovalQueue = vi.fn();
const mockUseApproveCleanupItem = vi.fn();
const mockUseRetryCleanupItem = vi.fn();
const mockUseRejectCleanupItem = vi.fn();
const mockUseBulkCleanupAction = vi.fn();
const mockUseCleanupActivity = vi.fn();
const mockUseCleanupActivityEvents = vi.fn();
const mockUseCleanupLogs = vi.fn();
const mockUseCleanupStatistics = vi.fn();

vi.mock("../../../../hooks/api/useLibraryCleanup", () => ({
	useCleanupConfig: () => mockUseCleanupConfig(),
	useUpdateCleanupConfig: () => mockUseUpdateCleanupConfig(),
	useCleanupPreview: () => mockUseCleanupPreview(),
	useCleanupExecute: () => mockUseCleanupExecute(),
	useCleanupExplain: () => mockUseCleanupExplain(),
	useCreateCleanupRule: () => mockUseCreateCleanupRule(),
	useUpdateCleanupRule: () => mockUseUpdateCleanupRule(),
	useDeleteCleanupRule: () => mockUseDeleteCleanupRule(),
	useReorderCleanupRules: () => mockUseReorderCleanupRules(),
	useCleanupFieldOptions: () => mockUseCleanupFieldOptions(),
	useCleanupApprovalQueue: (...args: unknown[]) => mockUseCleanupApprovalQueue(...args),
	useApproveCleanupItem: () => mockUseApproveCleanupItem(),
	useRetryCleanupItem: () => mockUseRetryCleanupItem(),
	useRejectCleanupItem: () => mockUseRejectCleanupItem(),
	useBulkCleanupAction: () => mockUseBulkCleanupAction(),
	useCleanupActivity: (...args: unknown[]) => mockUseCleanupActivity(...args),
	useCleanupActivityEvents: (...args: unknown[]) => mockUseCleanupActivityEvents(...args),
	useCleanupLogs: () => mockUseCleanupLogs(),
	useCleanupStatistics: () => mockUseCleanupStatistics(),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [] }),
}));

vi.mock("@/hooks/useThemeGradient", () => ({
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

vi.mock("@/lib/theme-gradients", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/theme-gradients")>();
	return {
		...actual,
		getServiceGradient: () => ({
			from: "#3b82f6",
			to: "#8b5cf6",
			glow: "rgba(59,130,246,0.3)",
			fromLight: "#3b82f610",
			fromMedium: "#3b82f620",
			fromMuted: "#3b82f630",
		}),
	};
});

vi.mock("@/lib/theme-input-styles", () => ({
	INPUT_BASE_CLASSES: "test-input",
	getInputStyles: () => ({
		base: "test-input",
		applyFocus: vi.fn(),
		removeFocus: vi.fn(),
	}),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Import after mocks
import { LibraryCleanupClient } from "../library-cleanup-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
}

function makeConfig(overrides: Partial<CleanupConfigResponse> = {}): CleanupConfigResponse {
	return {
		id: "cfg-1",
		enabled: true,
		intervalHours: 24,
		lastRunAt: null,
		nextRunAt: null,
		dryRunMode: false,
		maxRemovalsPerRun: 50,
		requireApproval: false,
		respectQuiSeeding: false,
		rejectionMemoryDays: 0,
		rules: [
			{
				id: "rule-1",
				name: "Old Movies",
				enabled: true,
				priority: 0,
				ruleType: "age",
				parameters: { field: "arrAddedAt", operator: "older_than", days: 365 },
				serviceFilter: null,
				instanceFilter: null,
				excludeTags: null,
				excludeTitles: null,
				plexLibraryFilter: null,
				targetScope: "series",
				action: "delete",
				scanMediaServerAfterDelete: false,
				operator: null,
				conditions: null,
				retentionMode: false,
				useGlobalRejectionMemory: true,
				rejectionMemoryDays: 0,
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
			},
		],
		...overrides,
	};
}

function setupDefaultMocks(configOverrides: Partial<CleanupConfigResponse> = {}) {
	mockUseCleanupConfig.mockReturnValue({
		data: makeConfig(configOverrides),
		isLoading: false,
	});
	mockUseUpdateCleanupConfig.mockReturnValue(defaultMutation());
	mockUseCleanupPreview.mockReturnValue(defaultMutation());
	mockUseCleanupExecute.mockReturnValue(defaultMutation());
	mockUseCleanupExplain.mockReturnValue(defaultMutation());
	mockUseCreateCleanupRule.mockReturnValue(defaultMutation());
	mockUseUpdateCleanupRule.mockReturnValue(defaultMutation());
	mockUseDeleteCleanupRule.mockReturnValue(defaultMutation());
	mockUseReorderCleanupRules.mockReturnValue(defaultMutation());
	mockUseCleanupFieldOptions.mockReturnValue({ data: undefined });
	mockUseCleanupApprovalQueue.mockReturnValue({
		data: { items: [], total: 0, page: 1, pageSize: 20 },
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	});
	mockUseApproveCleanupItem.mockReturnValue(defaultMutation());
	mockUseRetryCleanupItem.mockReturnValue(defaultMutation());
	mockUseRejectCleanupItem.mockReturnValue(defaultMutation());
	mockUseBulkCleanupAction.mockReturnValue(defaultMutation());
	mockUseCleanupActivity.mockReturnValue({
		data: undefined,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	});
	mockUseCleanupActivityEvents.mockReturnValue({
		data: undefined,
		hasNextPage: undefined,
		isError: false,
		isFetchNextPageError: false,
		isFetching: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		refetch: vi.fn(),
	});
	mockUseCleanupLogs.mockReturnValue({
		data: undefined,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	});
	mockUseCleanupStatistics.mockReturnValue({
		data: undefined,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LibraryCleanupClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		setupDefaultMocks();
	});

	it("shows which destructive rules request a media-server scan", () => {
		const config = makeConfig();
		config.rules[0]!.scanMediaServerAfterDelete = true;
		mockUseCleanupConfig.mockReturnValue({ data: config, isLoading: false });

		render(<LibraryCleanupClient />, { wrapper: createWrapper() });

		expect(screen.getByText("Media scan")).toBeInTheDocument();
	});

	// ================================================================
	// Run Now confirmation dialog — text variants
	// ================================================================

	describe("Run Now confirmation dialog", () => {
		async function openRunNowDialog() {
			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			// Click "Run Now" button to open confirmation dialog
			fireEvent.click(screen.getByText("Run Now"));
			// Wait for dialog to appear
			await waitFor(() => {
				expect(screen.getByText("Run Library Cleanup?")).toBeInTheDocument();
			});
		}

		it("shows destructive copy and 'Run & Execute' when dryRun=off, approval=off", async () => {
			setupDefaultMocks({ dryRunMode: false, requireApproval: false });
			await openRunNowDialog();

			expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
			expect(screen.getByText("Run & Execute")).toBeInTheDocument();
		});

		it("shows dry run copy and 'Run Preview' when dryRun=on", async () => {
			setupDefaultMocks({ dryRunMode: true, requireApproval: false });
			await openRunNowDialog();

			expect(screen.getByText(/nothing will be removed/)).toBeInTheDocument();
			expect(screen.getByText("Run Preview")).toBeInTheDocument();
		});

		it("shows approval copy and 'Run & Queue' when dryRun=off, approval=on", async () => {
			setupDefaultMocks({ dryRunMode: false, requireApproval: true });
			await openRunNowDialog();

			expect(screen.getByText(/queue matching items for approval/)).toBeInTheDocument();
			expect(screen.getByText("Run & Queue")).toBeInTheDocument();
		});

		it("dryRun takes precedence over approval when both are on", async () => {
			setupDefaultMocks({ dryRunMode: true, requireApproval: true });
			await openRunNowDialog();

			// dryRun mode should win — show "nothing will be removed" + "Run Preview"
			expect(screen.getByText(/nothing will be removed/)).toBeInTheDocument();
			expect(screen.getByText("Run Preview")).toBeInTheDocument();
		});

		it("Cancel closes dialog without executing", async () => {
			const executeMutate = vi.fn();
			mockUseCleanupExecute.mockReturnValue(defaultMutation({ mutate: executeMutate }));
			setupDefaultMocks();
			// Re-apply the execute mock after setupDefaultMocks
			mockUseCleanupExecute.mockReturnValue(defaultMutation({ mutate: executeMutate }));

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Run Now"));
			await waitFor(() => {
				expect(screen.getByText("Run Library Cleanup?")).toBeInTheDocument();
			});

			// Click cancel in the dialog
			const cancelButtons = screen.getAllByText("Cancel");
			// The dialog's Cancel button (not any other Cancel)
			const dialogCancel = cancelButtons.find((btn) => btn.closest("[role='dialog']"));
			fireEvent.click(dialogCancel!);

			// Dialog should close
			await waitFor(() => {
				expect(screen.queryByText("Run Library Cleanup?")).not.toBeInTheDocument();
			});

			// Execute should NOT have been called
			expect(executeMutate).not.toHaveBeenCalled();
		});
	});

	// ================================================================
	// Delete rule two-step confirmation
	// ================================================================

	describe("delete rule two-step confirmation", () => {
		it("first click shows Confirm/Yes/No, does not fire mutation", () => {
			const deleteMutate = vi.fn();
			mockUseDeleteCleanupRule.mockReturnValue(defaultMutation({ mutate: deleteMutate }));

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			// Find the Delete button for the rule
			const deleteButton = screen.getByLabelText("Delete rule: Old Movies");
			fireEvent.click(deleteButton);

			// Should show confirm UI
			expect(screen.getByText("Confirm?")).toBeInTheDocument();
			expect(screen.getByText("Yes")).toBeInTheDocument();
			expect(screen.getByText("No")).toBeInTheDocument();

			// Mutation should NOT have fired yet
			expect(deleteMutate).not.toHaveBeenCalled();
		});

		it("clicking 'Yes' fires the delete mutation", () => {
			const deleteMutate = vi.fn();
			mockUseDeleteCleanupRule.mockReturnValue(defaultMutation({ mutate: deleteMutate }));

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			// First click — show confirm
			fireEvent.click(screen.getByLabelText("Delete rule: Old Movies"));
			// Second click — confirm
			fireEvent.click(screen.getByText("Yes"));

			expect(deleteMutate).toHaveBeenCalledWith("rule-1");
		});

		it("clicking 'No' cancels without firing mutation", () => {
			const deleteMutate = vi.fn();
			mockUseDeleteCleanupRule.mockReturnValue(defaultMutation({ mutate: deleteMutate }));

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			// First click — show confirm
			fireEvent.click(screen.getByLabelText("Delete rule: Old Movies"));
			// Click No
			fireEvent.click(screen.getByText("No"));

			// Confirm UI should be gone
			expect(screen.queryByText("Confirm?")).not.toBeInTheDocument();
			// Original Delete button should be back
			expect(screen.getByLabelText("Delete rule: Old Movies")).toBeInTheDocument();
			// Mutation should NOT have fired
			expect(deleteMutate).not.toHaveBeenCalled();
		});
	});

	// ================================================================
	// Approval selection reset on filter change
	// ================================================================

	describe("approval selection reset on filter change", () => {
		function setupApprovalTab() {
			mockUseCleanupApprovalQueue.mockReturnValue({
				data: {
					items: [
						{
							id: "item-1",
							instanceId: "inst-1",
							arrItemId: 1,
							title: "Test Movie 1",
							status: "pending",
							ruleResults: [],
							createdAt: "2024-01-01",
						},
						{
							id: "item-2",
							instanceId: "inst-1",
							arrItemId: 2,
							title: "Test Movie 2",
							status: "pending",
							ruleResults: [],
							createdAt: "2024-01-01",
						},
					],
					total: 2,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
		}

		it("clears selection when switching approval status filter", async () => {
			setupApprovalTab();
			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			// Switch to approvals tab
			fireEvent.click(screen.getByText("Approval Queue"));

			// Wait for items to render — checkboxes appear because statusFilter defaults to "pending"
			await waitFor(() => {
				expect(screen.getByText("Test Movie 1")).toBeInTheDocument();
			});

			// Select all items via the "Select all items" checkbox
			const selectAll = screen.getByLabelText("Select all items");
			fireEvent.click(selectAll);

			// The bulk action bar should appear
			await waitFor(() => {
				expect(screen.getByText("2 items selected")).toBeInTheDocument();
			});

			// Now switch filter to "approved" — selection should be cleared
			// (and "approved" items won't have checkboxes, but the key behavior is the reset)
			fireEvent.click(screen.getByText("Approved"));

			// The bulk action bar with "2 items selected" should be gone
			await waitFor(() => {
				expect(screen.queryByText("2 items selected")).not.toBeInTheDocument();
			});
		});

		it("makes durable pending and executing retries visible", async () => {
			setupApprovalTab();
			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			fireEvent.click(screen.getByText("Approval Queue"));
			fireEvent.click(await screen.findByRole("button", { name: "Retry pending" }));

			await waitFor(() => {
				expect(mockUseCleanupApprovalQueue).toHaveBeenLastCalledWith(1, 20, "retry_pending");
			});

			fireEvent.click(screen.getByRole("button", { name: "Retry running" }));
			await waitFor(() => {
				expect(mockUseCleanupApprovalQueue).toHaveBeenLastCalledWith(1, 20, "retry_executing");
			});
		});

		it("allows an operator to explicitly resume a durable pending retry", async () => {
			setupApprovalTab();
			const retryMutate = vi.fn();
			mockUseRetryCleanupItem.mockReturnValue(defaultMutation({ mutate: retryMutate }));
			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			fireEvent.click(screen.getByText("Approval Queue"));
			fireEvent.click(await screen.findByRole("button", { name: "Retry pending" }));
			fireEvent.click((await screen.findAllByRole("button", { name: "Resume retry" }))[0]!);

			expect(retryMutate).toHaveBeenCalledWith("item-1");
		});

		it("clears a stale retry error before an approval action", async () => {
			setupApprovalTab();
			const retryReset = vi.fn();
			mockUseRetryCleanupItem.mockReturnValue(
				defaultMutation({ error: new Error("Retry failed"), reset: retryReset }),
			);
			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			fireEvent.click(screen.getByText("Approval Queue"));
			fireEvent.click((await screen.findAllByRole("button", { name: "Approve" }))[0]!);

			expect(retryReset).toHaveBeenCalledOnce();
		});

		it("shows successful approval, retry, and bulk follow-up warnings", async () => {
			setupApprovalTab();
			mockUseApproveCleanupItem.mockReturnValue(
				defaultMutation({
					data: { removed: 1, failed: 0, errors: [], warnings: ["Approval scan deferred"] },
				}),
			);
			mockUseRetryCleanupItem.mockReturnValue(
				defaultMutation({
					data: { removed: 1, failed: 0, errors: [], warnings: ["Retry scan deferred"] },
				}),
			);
			mockUseBulkCleanupAction.mockReturnValue(
				defaultMutation({
					data: { removed: 2, failed: 0, errors: [], warnings: ["Bulk scan deferred"] },
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Approval Queue"));

			const warningStatus = await screen.findByRole("status");
			expect(warningStatus).toHaveTextContent("Approval scan deferred");
			expect(warningStatus).toHaveTextContent("Retry scan deferred");
			expect(warningStatus).toHaveTextContent("Bulk scan deferred");
		});
	});

	describe("shared Plex safety feedback", () => {
		it("renders structured episode identifiers and titles in preview results", () => {
			const explainMutate = vi.fn();
			mockUseCleanupExplain.mockReturnValue(
				defaultMutation({
					mutate: explainMutate,
					data: {
						item: {
							title: "Example Series",
							year: 2024,
							instanceId: "sonarr-hd",
							itemType: "episode",
							targetScope: "episode",
							arrEpisodeId: 202,
							seasonNumber: 1,
							episodeNumber: 2,
							episodeTitle: "The Second Episode",
						},
						results: [],
						retentionProtected: false,
					},
				}),
			);
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						items: [
							{
								instanceId: "sonarr-hd",
								instanceLabel: "Sonarr",
								arrItemId: 101,
								itemType: "episode",
								targetScope: "episode",
								arrEpisodeId: 202,
								seasonNumber: 1,
								episodeNumber: 2,
								episodeTitle: "The Second Episode",
								title: "Example Series",
								matchedRuleName: "Watched episodes",
								reason: "Plex watch count is greater than 0",
								action: "delete",
								sizeOnDisk: "1000",
								year: 2024,
								rating: null,
								quiStatus: "no_signal",
							},
						],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getByText("Example Series")).toBeInTheDocument();
			expect(screen.getByText("S01E02")).toBeInTheDocument();
			expect(screen.getByText("The Second Episode")).toBeInTheDocument();
			fireEvent.click(screen.getByTitle("Explain why this item was flagged"));
			expect(explainMutate).toHaveBeenCalledWith({
				instanceId: "sonarr-hd",
				arrItemId: 101,
				arrEpisodeId: 202,
			});
			const dialog = screen.getByRole("dialog");
			expect(within(dialog).getByText("S01E02")).toBeInTheDocument();
			expect(within(dialog).getByText("The Second Episode")).toBeInTheDocument();
		});

		it("omits episode identity from a series preview explanation", () => {
			const explainMutate = vi.fn();
			mockUseCleanupExplain.mockReturnValue(defaultMutation({ mutate: explainMutate }));
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						items: [
							{
								instanceId: "sonarr-hd",
								instanceLabel: "Sonarr",
								arrItemId: 101,
								itemType: "series",
								targetScope: "series",
								arrEpisodeId: null,
								title: "Example Series",
								matchedRuleName: "Old series",
								reason: "Added before threshold",
								action: "delete",
								sizeOnDisk: "1000",
								year: 2024,
								rating: null,
								quiStatus: "no_signal",
							},
						],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByTitle("Explain why this item was flagged"));

			expect(explainMutate).toHaveBeenCalledWith({
				instanceId: "sonarr-hd",
				arrItemId: 101,
				arrEpisodeId: undefined,
			});
		});

		it("shows unavailable retention evidence as active protection", () => {
			mockUseCleanupExplain.mockReturnValue(
				defaultMutation({
					data: {
						item: {
							title: "Example Series",
							year: 2024,
							instanceId: "sonarr-hd",
							itemType: "series",
							targetScope: "series",
						},
						results: [
							{
								ruleId: "retention-rule",
								ruleName: "Keep watched series",
								matched: false,
								reason: null,
								filteredBy: "evidence_unavailable",
								retentionMode: true,
							},
						],
						retentionProtected: true,
					},
				}),
			);
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						items: [
							{
								instanceId: "sonarr-hd",
								instanceLabel: "Sonarr",
								arrItemId: 101,
								itemType: "series",
								targetScope: "series",
								arrEpisodeId: null,
								title: "Example Series",
								matchedRuleName: "Old series",
								reason: "Added before threshold",
								action: "delete",
								sizeOnDisk: "1000",
								year: 2024,
								rating: null,
								quiStatus: "no_signal",
							},
						],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByTitle("Explain why this item was flagged"));

			const dialog = screen.getByRole("dialog");
			expect(within(dialog).getByText("Protected: evidence unavailable")).toBeInTheDocument();
			expect(
				within(dialog).getByText(
					"This item is protected because required retention evidence is unavailable.",
				),
			).toBeInTheDocument();
		});

		it("renders structured episode identifiers and titles in the approval queue", async () => {
			const explainMutate = vi.fn();
			mockUseCleanupExplain.mockReturnValue(defaultMutation({ mutate: explainMutate }));
			mockUseCleanupApprovalQueue.mockReturnValue({
				data: {
					items: [
						{
							id: "episode-approval",
							instanceId: "sonarr-hd",
							instanceLabel: "Sonarr",
							arrItemId: 101,
							itemType: "episode",
							targetScope: "episode",
							arrEpisodeId: 202,
							seasonNumber: 3,
							episodeNumber: 7,
							episodeTitle: "A Specific Episode",
							title: "Example Series",
							matchedRuleId: "episode-rule",
							matchedRuleName: "Watched episodes",
							reason: "Plex watch count is greater than 0",
							action: "delete",
							sizeOnDisk: "1000",
							year: 2024,
							status: "pending",
							createdAt: "2024-01-01T00:00:00Z",
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Approval Queue"));

			expect(await screen.findByText("S03E07")).toBeInTheDocument();
			expect(screen.getByText("A Specific Episode")).toBeInTheDocument();
			fireEvent.click(screen.getByTitle("Explain why this item was flagged"));
			expect(explainMutate).toHaveBeenCalledWith({
				instanceId: "sonarr-hd",
				arrItemId: 101,
				arrEpisodeId: 202,
			});
		});

		it("reports durable retries separately from current rule matches", () => {
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 0,
						totalFlagged: 0,
						pendingRetryCount: 1,
						items: [],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(
				screen.getByText("Preview Results (0 of 0 rule matches · 1 retry pending)"),
			).toBeInTheDocument();
		});

		it("renders safety-blocked preview items separately from delete actions", () => {
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						items: [
							{
								instanceId: "radarr-4k",
								instanceLabel: "4K Radarr",
								arrItemId: 101,
								itemType: "movie",
								title: "Example Movie",
								matchedRuleName: "4K cleanup",
								reason: "Skipped for safety: shared Plex risk",
								action: "skipped",
								selectionStatus: "blocked",
								plannedAction: "delete",
								sizeOnDisk: "1000",
								year: 2024,
								rating: 8,
								quiStatus: "no_signal",
							},
						],
						warnings: ["A deletion was safety-blocked."],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getAllByText("1 Safety-blocked")).toHaveLength(1);
			expect(screen.queryByText("1 Delete")).not.toBeInTheDocument();
			expect(screen.getByText(/Skipped for safety: shared Plex risk/)).toBeInTheDocument();
		});

		it("shows exact next-run, deferred, blocked, and in-flight counts", () => {
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 8,
						totalFlagged: 6,
						pendingRetryCount: 2,
						selectionCountsComplete: true,
						selection: {
							selectedFresh: 2,
							selectedRetries: 1,
							deferredBudget: 1,
							deferredApproval: 1,
							deferredRetryFairness: 1,
							deferredInFlightTarget: 1,
							deferredDuplicateTarget: 1,
							inFlight: 1,
							blocked: 1,
							retryStateUnavailable: 0,
							retryState: "complete",
							total: 8,
						},
						display: { shown: 4, hidden: 3, limit: 200, complete: false },
						items: [
							{
								instanceId: "radarr-1",
								instanceLabel: "Radarr",
								arrItemId: 1,
								itemType: "movie",
								title: "Selected Movie",
								matchedRuleName: "Old media",
								reason: "Matched",
								action: "delete",
								selectionStatus: "selected",
								plannedAction: "delete",
								sizeOnDisk: "1000",
								year: 2020,
								rating: 7,
								quiStatus: "no_signal",
							},
							{
								instanceId: "radarr-1",
								instanceLabel: "Radarr",
								arrItemId: 2,
								itemType: "movie",
								title: "Deferred Movie",
								matchedRuleName: "Old media",
								reason: "Deferred: the next cleanup run budget is full",
								action: "skipped",
								selectionStatus: "deferred",
								plannedAction: "delete",
								sizeOnDisk: "1000",
								year: 2020,
								rating: 7,
								quiStatus: "no_signal",
							},
							{
								instanceId: "radarr-1",
								instanceLabel: "Radarr",
								arrItemId: 3,
								itemType: "movie",
								title: "Running Movie",
								matchedRuleName: "Old media",
								reason: "Deferred: another cleanup run is already executing this durable retry.",
								action: "skipped",
								selectionStatus: "in_flight",
								plannedAction: "delete",
								sizeOnDisk: "1000",
								year: 2020,
								rating: 7,
								quiStatus: "no_signal",
							},
							{
								instanceId: "radarr-1",
								instanceLabel: "Radarr",
								arrItemId: 4,
								itemType: "movie",
								title: "Retry Movie",
								matchedRuleName: "Old media",
								reason:
									"Selected for a retry attempt in the next cleanup run. The mutation outcome depends on live ARR authority and is not predicted.",
								action: "delete",
								selectionStatus: "selected",
								plannedAction: "delete",
								isRetryAttempt: true,
								sizeOnDisk: "1000",
								year: 2020,
								rating: 7,
								quiStatus: "no_signal",
							},
						],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getByText("Based on current rules and state.")).toBeInTheDocument();
			expect(screen.getByText(/Next run reserves/)).toHaveTextContent(
				"Next run reserves 2 fresh slots + 1 retry attempt. 6 deferred. Selected fresh slots include 1 currently safety-blocked item.",
			);
			expect(screen.getByText("1 Deferred (shown items)")).toBeInTheDocument();
			expect(screen.getByText("1 In flight (shown items)")).toBeInTheDocument();
			expect(screen.getByText("1 Retry attempt (shown items)")).toBeInTheDocument();
			expect(screen.getByText("Retry attempt")).toBeInTheDocument();
			expect(
				screen.getAllByText(/mutation outcome depends on live ARR authority and is not predicted/),
			).not.toHaveLength(0);
			expect(screen.getByText(/next cleanup run budget is full/)).toBeInTheDocument();
		});

		it("keeps approval pending retries outside the next-run total while showing in-flight work", () => {
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						pendingRetryCount: 1,
						selectionCountsComplete: true,
						selection: {
							selectedFresh: 1,
							selectedRetries: 0,
							deferredBudget: 0,
							deferredApproval: 0,
							deferredRetryFairness: 0,
							deferredInFlightTarget: 0,
							deferredDuplicateTarget: 0,
							inFlight: 1,
							blocked: 0,
							retryStateUnavailable: 0,
							retryState: "complete",
							total: 2,
						},
						display: { shown: 2, hidden: 0, limit: 200, complete: true },
						items: [
							{
								instanceId: "radarr-1",
								instanceLabel: "Radarr",
								arrItemId: 101,
								itemType: "movie",
								title: "Fresh movie",
								matchedRuleName: "Cleanup",
								reason: "Selected for the next approval run",
								action: "delete",
								selectionStatus: "selected",
								plannedAction: "delete",
								sizeOnDisk: "1000",
								year: 2024,
								rating: 8,
								quiStatus: "no_signal",
							},
							{
								instanceId: "radarr-1",
								instanceLabel: "Radarr",
								arrItemId: 202,
								itemType: "movie",
								title: "Executing retry",
								matchedRuleName: "Cleanup",
								reason: "Another cleanup run is already executing this durable retry",
								action: "skipped",
								selectionStatus: "in_flight",
								plannedAction: "delete",
								isRetryAttempt: true,
								sizeOnDisk: "1000",
								year: 2024,
								rating: 8,
								quiStatus: "no_signal",
							},
						],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getByText(/Preview Results/)).toHaveTextContent(
				"1 of 1 rule matches · 1 retry pending",
			);
			expect(screen.getByText(/Next run reserves/)).toHaveTextContent(
				"Next run reserves 1 fresh slot. 1 deferred.",
			);
			expect(screen.getByText("1 In flight")).toBeInTheDocument();
			expect(screen.queryByText(/retry attempt in the next cleanup run/i)).not.toBeInTheDocument();
		});

		it("states that retry counts and next-run selection are unknown during an outage", () => {
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 250,
						totalFlagged: 250,
						pendingRetryCount: null,
						selectionCountsComplete: false,
						selection: {
							selectedFresh: 0,
							selectedRetries: 0,
							deferredBudget: 0,
							deferredApproval: 0,
							deferredRetryFairness: 0,
							deferredInFlightTarget: 0,
							inFlight: 0,
							blocked: 0,
							retryStateUnavailable: 250,
							retryState: "unavailable",
							total: 250,
						},
						display: { shown: 200, hidden: 50, limit: 200, complete: false },
						items: [],
						warnings: [
							"Durable cleanup retry state could not be loaded.",
							"Display capped at 200 of 250 known preview items; retry-backed selection counts are incomplete.",
						],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getByText(/Preview Results/)).toHaveTextContent(
				"250 of 250 rule matches · retry count unavailable",
			);
			expect(screen.getByText(/Next run cannot be determined/)).toHaveTextContent(
				"durable retry state is unavailable",
			);
			expect(screen.getByText(/Next run cannot be determined/)).toHaveTextContent(
				"250 fresh matches are deferred for safety",
			);
			expect(screen.queryByText(/0 retries pending/)).not.toBeInTheDocument();
		});

		it("masks cleanup rule details in preview results in incognito mode", () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 2,
						totalFlagged: 2,
						items: [
							{
								instanceId: "radarr-secret",
								instanceLabel: "Secret Radarr",
								arrItemId: 101,
								itemType: "movie",
								title: "Private Movie",
								matchedRuleName: "Alice Path Cleanup",
								reason:
									'Retry failed for "/home/alice/Private Movie" on SECRET RADARR at [fd00::42]:7878',
								action: "delete",
								sizeOnDisk: "1000",
								year: 2024,
								rating: 8,
								quiStatus: "no_signal",
							},
							{
								instanceId: "sonarr-secret",
								instanceLabel: "Secret Sonarr",
								arrItemId: 202,
								itemType: "episode",
								targetScope: "episode",
								arrEpisodeId: 303,
								seasonNumber: 1,
								episodeNumber: 4,
								episodeTitle: "Private Episode Title",
								title: "Private Series",
								matchedRuleName: "Bob Safety Rule",
								reason: "Skipped for safety at /srv/bob/Private Series",
								action: "skipped",
								sizeOnDisk: "2000",
								year: 2023,
								rating: 7,
								quiStatus: "no_signal",
							},
						],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getAllByText("Cleanup rule: Matched cleanup criteria")).toHaveLength(2);
			expect(screen.queryByText(/Alice Path Cleanup/)).not.toBeInTheDocument();
			expect(screen.queryByText(/Bob Safety Rule/)).not.toBeInTheDocument();
			expect(screen.queryByText(/Private Episode Title/)).not.toBeInTheDocument();
			expect(screen.queryByText(/\/home\/alice/)).not.toBeInTheDocument();
			expect(screen.queryByText(/\/srv\/bob/)).not.toBeInTheDocument();
			expect(screen.queryByText(/fd00::42/)).not.toBeInTheDocument();
		});

		it("shows approval execution errors so a returned-to-pending item is actionable", async () => {
			const approveMutate = vi.fn();
			const approveReset = vi.fn();
			const bulkReset = vi.fn();
			mockUseCleanupApprovalQueue.mockReturnValue({
				data: {
					items: [
						{
							id: "item-1",
							instanceId: "radarr-4k",
							arrItemId: 101,
							itemType: "movie",
							title: "Example Movie",
							matchedRuleName: "4K cleanup",
							reason: "Matched 4K profile",
							action: "delete",
							sizeOnDisk: "1000",
							year: 2024,
							status: "pending",
							lastExecutionError: "Skipped for safety: saved shared Plex risk",
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
			mockUseApproveCleanupItem.mockReturnValue(
				defaultMutation({
					mutate: approveMutate,
					reset: approveReset,
					error: new Error("Skipped for safety: shared Plex risk"),
					isError: true,
				}),
			);
			mockUseBulkCleanupAction.mockReturnValue(defaultMutation({ reset: bulkReset }));

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Approval Queue"));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Skipped for safety: shared Plex risk",
			);
			expect(
				screen.getByText("Last execution attempt: Skipped for safety: saved shared Plex risk"),
			).toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: "Approve" }));

			expect(bulkReset).toHaveBeenCalledOnce();
			expect(approveMutate).toHaveBeenCalledWith("item-1");
			expect(approveReset).not.toHaveBeenCalled();
		});

		it("masks persisted retry errors and instance labels in incognito mode", async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			mockUseCleanupApprovalQueue.mockReturnValue({
				data: {
					items: [
						{
							id: "item-1",
							instanceId: "radarr-secret",
							instanceLabel: "Secret Radarr",
							arrItemId: 101,
							itemType: "movie",
							title: "Private Movie",
							matchedRuleName: "Alice Path Cleanup",
							reason: 'Path "/home/alice/Private Movie" matches cleanup rule',
							action: "delete",
							sizeOnDisk: "1000",
							year: 2024,
							status: "retry_pending",
							lastExecutionError: "Failed to decrypt API key for SECRET RADARR at [fd00::42]:7878",
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Approval Queue"));

			await waitFor(() => {
				expect(screen.queryByText(/Secret Radarr/)).not.toBeInTheDocument();
				expect(screen.queryByText(/Private Movie/)).not.toBeInTheDocument();
				expect(screen.queryByText(/Alice Path Cleanup/)).not.toBeInTheDocument();
				expect(screen.queryByText(/\/home\/alice/)).not.toBeInTheDocument();
				expect(screen.queryByText(/fd00::42/)).not.toBeInTheDocument();
			});
			expect(screen.getByText("Radarr 4K")).toBeInTheDocument();
			expect(screen.getByText("Cleanup rule: Matched cleanup criteria")).toBeInTheDocument();
			expect(
				screen.getByText(
					"Last execution attempt: Cleanup retry failed; details hidden in incognito mode.",
				),
			).toBeInTheDocument();
		});

		it("masks pending approval checkbox labels in incognito mode", async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			mockUseCleanupApprovalQueue.mockReturnValue({
				data: {
					items: [
						{
							id: "item-1",
							instanceId: "radarr-secret",
							instanceLabel: "Secret Radarr",
							arrItemId: 101,
							itemType: "movie",
							title: "Private Movie",
							matchedRuleName: "Private cleanup",
							reason: "Matched private cleanup criteria",
							action: "delete",
							sizeOnDisk: "1000",
							year: 2024,
							status: "pending",
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Approval Queue"));

			const itemCheckbox = await screen.findByRole("checkbox", {
				name: /^Select .+\.iso$/,
			});
			expect(itemCheckbox).not.toHaveAttribute("aria-label", "Select Private Movie");
			expect(
				screen.queryByRole("checkbox", { name: "Select Private Movie" }),
			).not.toBeInTheDocument();
			expect(screen.queryByText("Private Movie")).not.toBeInTheDocument();
		});
	});

	describe("Activity history", () => {
		it("renders and expands a per-action audit timeline", async () => {
			mockUseCleanupActivity.mockReturnValue({
				data: {
					items: [
						{
							actionId: "approval-1",
							instanceId: "radarr-1",
							arrItemId: 101,
							itemType: "movie",
							targetScope: "series",
							arrEpisodeId: null,
							title: "Retained Movie",
							ruleId: "rule-1",
							ruleName: "Old Movies",
							action: "delete",
							trigger: "approval",
							latestOutcome: "success",
							actionableReason: "The selected file was removed.",
							startedAt: "2026-08-03T12:00:00.000Z",
							updatedAt: "2026-08-03T12:01:00.000Z",
							eventCount: 2,
							eventsTruncated: false,
							olderEventsCursor: null,
							events: [
								{
									id: "1",
									actionId: "approval-1",
									correlationId: "run-1",
									sequence: 1,
									eventType: "candidate_selected",
									outcome: "info",
									trigger: "manual",
									actorType: "operator",
									actorId: "user-1",
									approvalId: "approval-1",
									runLogId: "run-1",
									reason: "Matched the configured cleanup rule.",
									evidence: null,
									details: null,
									createdAt: "2026-08-03T12:00:00.000Z",
								},
							],
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Activity Log"));

			expect(await screen.findByText("Action history")).toBeInTheDocument();
			expect(screen.getByText("Retained Movie")).toBeInTheDocument();
			expect(screen.getByText("The selected file was removed.")).toBeInTheDocument();
			expect(mockUseCleanupActivity).toHaveBeenCalledWith(1, 20);

			fireEvent.click(screen.getByRole("button", { name: /Retained Movie/ }));
			expect(await screen.findByText("candidate selected")).toBeInTheDocument();
			expect(screen.getByText("Matched the configured cleanup rule.")).toBeInTheDocument();
		});

		it("loads and merges more than 200 events without duplicates or ordering loss", async () => {
			const makeAuditEvent = (id: number) => ({
				id: String(id),
				actionId: "action-long",
				correlationId: "run-long",
				sequence: id,
				eventType: `audit_event_${id}`,
				outcome: "info" as const,
				trigger: "scheduled" as const,
				actorType: "scheduler" as const,
				actorId: null,
				approvalId: null,
				runLogId: "run-long",
				reason: `Reason ${id}`,
				evidence: null,
				details: null,
				createdAt: "2026-08-03T12:00:00.000Z",
			});
			mockUseCleanupActivity.mockReturnValue({
				data: {
					items: [
						{
							actionId: "action-long",
							instanceId: "radarr-1",
							arrItemId: 101,
							itemType: "movie",
							targetScope: "series",
							arrEpisodeId: null,
							title: "Long Audit Movie",
							ruleId: "rule-1",
							ruleName: "Old Movies",
							action: "delete",
							trigger: "scheduled",
							latestOutcome: "success",
							actionableReason: "Completed",
							startedAt: "2026-08-03T12:00:00.000Z",
							updatedAt: "2026-08-03T12:01:00.000Z",
							eventCount: 400,
							eventsTruncated: true,
							olderEventsCursor: "201",
							events: Array.from({ length: 200 }, (_, index) => makeAuditEvent(index + 201)),
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
			const fetchNextPage = vi.fn();
			const refetch = vi.fn();
			let loadedPages = 0;
			mockUseCleanupActivityEvents.mockImplementation(() => ({
				data:
					loadedPages > 0
						? {
								pages: [
									{
										items: Array.from({ length: 100 }, (_, index) => makeAuditEvent(index + 101)),
										olderEventsCursor: "101",
									},
									...(loadedPages > 1
										? [
												{
													items: Array.from({ length: 101 }, (_, index) =>
														makeAuditEvent(index + 1),
													),
													olderEventsCursor: null,
												},
											]
										: []),
								],
							}
						: undefined,
				hasNextPage: loadedPages === 0 ? undefined : loadedPages === 1,
				isError: false,
				isFetchNextPageError: false,
				isFetching: false,
				isFetchingNextPage: false,
				fetchNextPage,
				refetch,
			}));

			const view = render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Activity Log"));
			fireEvent.click(await screen.findByRole("button", { name: /Long Audit Movie/ }));
			expect(mockUseCleanupActivityEvents).toHaveBeenCalledWith("action-long", "201");

			fireEvent.click(screen.getByRole("button", { name: "Load earlier events" }));
			expect(refetch).toHaveBeenCalledTimes(1);
			expect(fetchNextPage).not.toHaveBeenCalled();

			loadedPages = 1;
			view.rerender(<LibraryCleanupClient />);
			fireEvent.click(screen.getByRole("button", { name: "Load earlier events" }));
			expect(fetchNextPage).toHaveBeenCalledTimes(1);

			loadedPages = 2;
			view.rerender(<LibraryCleanupClient />);
			const renderedEvents = screen
				.getAllByText(/^audit event \d+$/)
				.map((node) => node.textContent);
			expect(renderedEvents).toEqual(
				Array.from({ length: 400 }, (_, index) => `audit event ${index + 1}`),
			);
			expect(new Set(renderedEvents).size).toBe(400);
			expect(screen.getByText("Showing 400 of 400 audit events.")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Load earlier events" })).not.toBeInTheDocument();
		});

		it("keeps loaded events visible and offers a retry when an older page fails", async () => {
			mockUseCleanupActivity.mockReturnValue({
				data: {
					items: [
						{
							actionId: "action-error",
							instanceId: "radarr-1",
							arrItemId: 101,
							itemType: "movie",
							targetScope: "series",
							arrEpisodeId: null,
							title: "Retry Audit Movie",
							ruleId: "rule-1",
							ruleName: "Old Movies",
							action: "delete",
							trigger: "scheduled",
							latestOutcome: "failed",
							actionableReason: "Retry pending",
							startedAt: "2026-08-03T12:00:00.000Z",
							updatedAt: "2026-08-03T12:01:00.000Z",
							eventCount: 201,
							eventsTruncated: true,
							olderEventsCursor: "2",
							events: [
								{
									id: "2",
									actionId: "action-error",
									correlationId: "run-error",
									sequence: 2,
									eventType: "retry_pending",
									outcome: "failed",
									trigger: "retry",
									actorType: "operator",
									actorId: "user-1",
									approvalId: null,
									runLogId: "run-error",
									reason: "The latest attempt is still visible.",
									evidence: null,
									details: null,
									createdAt: "2026-08-03T12:01:00.000Z",
								},
							],
						},
					],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
			const fetchNextPage = vi.fn();
			const refetch = vi.fn();
			mockUseCleanupActivityEvents.mockReturnValue({
				data: undefined,
				hasNextPage: undefined,
				isError: true,
				isFetchNextPageError: false,
				isFetching: false,
				isFetchingNextPage: false,
				fetchNextPage,
				refetch,
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Activity Log"));
			fireEvent.click(await screen.findByRole("button", { name: /Retry Audit Movie/ }));

			expect(screen.getByText("The latest attempt is still visible.")).toBeInTheDocument();
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Earlier audit events could not be loaded",
			);
			fireEvent.click(screen.getByRole("button", { name: "Retry earlier events" }));
			expect(refetch).toHaveBeenCalledTimes(1);
			expect(fetchNextPage).not.toHaveBeenCalled();
		});
	});
});
