import type {
	CleanupApprovalResponse,
	CleanupAuditTimelineResponse,
	CleanupConfigResponse,
	CleanupExplainResponse,
	CleanupPreviewItem,
} from "@arr/shared";
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
const mockUseCleanupLogs = vi.fn();
const mockUseCleanupActivity = vi.fn();
const mockUseCleanupActivityEvents = vi.fn();
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
	useCleanupLogs: () => mockUseCleanupLogs(),
	useCleanupActivity: (...args: unknown[]) => mockUseCleanupActivity(...args),
	useCleanupActivityEvents: (...args: unknown[]) => mockUseCleanupActivityEvents(...args),
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
				targetScope: "series",
				ruleType: "age",
				parameters: { field: "arrAddedAt", operator: "older_than", days: 365 },
				serviceFilter: null,
				instanceFilter: null,
				excludeTags: null,
				excludeTitles: null,
				plexLibraryFilter: null,
				action: "delete",
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
	mockUseCleanupLogs.mockReturnValue({
		data: undefined,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	});
	mockUseCleanupActivity.mockReturnValue({
		data: { items: [], total: 0, page: 1, pageSize: 20 },
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	});
	mockUseCleanupActivityEvents.mockReturnValue({
		data: undefined,
		isFetching: false,
		isFetchingNextPage: false,
		isError: false,
		isFetchNextPageError: false,
		refetch: vi.fn(),
		fetchNextPage: vi.fn(),
		hasNextPage: false,
	});
	mockUseCleanupStatistics.mockReturnValue({
		data: undefined,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	});
}

function makeEpisodePreviewItem(overrides: Partial<CleanupPreviewItem> = {}): CleanupPreviewItem {
	return {
		instanceId: "sonarr-main",
		instanceLabel: "Main Sonarr",
		arrItemId: 42,
		itemType: "series",
		targetScope: "episode",
		arrEpisodeId: 9001,
		seasonNumber: 1,
		episodeNumber: 2,
		seriesTitle: "Signal Harbor",
		episodeTitle: "First Light",
		title: "Legacy fallback title",
		matchedRuleName: "Watched episodes",
		reason: "Plex watch count 2 > 1",
		action: "delete",
		sizeOnDisk: "1073741824",
		year: 2026,
		rating: 8,
		quiStatus: "no_signal",
		...overrides,
	};
}

function makeEpisodeApproval(
	overrides: Partial<CleanupApprovalResponse> = {},
): CleanupApprovalResponse {
	return {
		id: "approval-episode",
		instanceId: "sonarr-main",
		instanceLabel: "Main Sonarr",
		arrItemId: 42,
		itemType: "series",
		targetScope: "episode",
		arrEpisodeId: 9001,
		seasonNumber: 1,
		episodeNumber: 2,
		seriesTitle: "Signal Harbor",
		episodeTitle: "First Light",
		title: "Legacy fallback title",
		matchedRuleId: "rule-episode",
		matchedRuleName: "Watched episodes",
		reason: "Plex watch count 2 > 1",
		action: "delete",
		sizeOnDisk: "1073741824",
		year: 2026,
		rating: 8,
		status: "retry_pending",
		lastExecutionError: "Exact episode delete failed; retry is pending",
		reviewedAt: null,
		executedAt: null,
		createdAt: "2026-08-12T12:00:00Z",
		expiresAt: "2026-09-12T12:00:00Z",
		...overrides,
	};
}

function makeEpisodeExplain(): CleanupExplainResponse {
	return {
		item: {
			title: "Signal Harbor",
			year: 2026,
			instanceId: "sonarr-main",
			itemType: "series",
			targetScope: "episode",
			arrEpisodeId: 9001,
			seasonNumber: 1,
			episodeNumber: 2,
			episodeTitle: "First Light",
		},
		results: [],
		retentionProtected: false,
	};
}

function makeAuditTimeline(
	overrides: Partial<CleanupAuditTimelineResponse> = {},
): CleanupAuditTimelineResponse {
	return {
		actionId: "approval-episode",
		instanceId: "sonarr-main",
		arrItemId: 42,
		itemType: "series",
		targetScope: "episode",
		arrEpisodeId: 9001,
		title: "Signal Harbor S01E02 · First Light",
		ruleId: "rule-episode",
		ruleName: "Watched episodes",
		action: "delete",
		trigger: "approval",
		latestOutcome: "success",
		actionableReason: "Exact episode matched cleanup criteria",
		startedAt: "2026-08-12T12:00:00Z",
		updatedAt: "2026-08-12T12:01:00Z",
		eventCount: 2,
		eventsTruncated: true,
		olderEventsCursor: "99",
		events: [
			{
				id: "100",
				actionId: "approval-episode",
				correlationId: "attempt-1",
				sequence: 1,
				eventType: "proposal_created",
				outcome: "info",
				trigger: "approval",
				actorType: "operator",
				actorId: null,
				approvalId: "approval-episode",
				runLogId: null,
				reason: "Proposal created",
				evidence: null,
				details: null,
				createdAt: "2026-08-12T12:00:00Z",
			},
		],
		...overrides,
	};
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
	});

	describe("episode identity", () => {
		it("shows structured preview identity and explains the exact episode", () => {
			const explainMutate = vi.fn();
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						items: [makeEpisodePreviewItem()],
					},
				}),
			);
			mockUseCleanupExplain.mockReturnValue(
				defaultMutation({ mutate: explainMutate, data: makeEpisodeExplain() }),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getByText("Signal Harbor")).toBeInTheDocument();
			expect(screen.getByText("S01E02 · First Light")).toBeInTheDocument();
			fireEvent.click(screen.getByTitle("Explain why this item was flagged"));

			expect(explainMutate).toHaveBeenCalledWith({
				instanceId: "sonarr-main",
				arrItemId: 42,
				arrEpisodeId: 9001,
			});
			expect(
				within(screen.getByRole("dialog")).getByText("S01E02 · First Light"),
			).toBeInTheDocument();
		});

		it("keeps series Explain requests unchanged", () => {
			const explainMutate = vi.fn();
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						items: [
							makeEpisodePreviewItem({
								targetScope: "series",
								arrEpisodeId: null,
								seasonNumber: null,
								episodeNumber: null,
								episodeTitle: null,
								seriesTitle: "Signal Harbor",
								title: "Signal Harbor",
							}),
						],
					},
				}),
			);
			mockUseCleanupExplain.mockReturnValue(defaultMutation({ mutate: explainMutate }));

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByTitle("Explain why this item was flagged"));

			expect(explainMutate).toHaveBeenCalledWith({
				instanceId: "sonarr-main",
				arrItemId: 42,
			});
		});

		it("shows structured identity with retry errors and explains approval episodes", async () => {
			const explainMutate = vi.fn();
			mockUseCleanupApprovalQueue.mockReturnValue({
				data: {
					items: [makeEpisodeApproval()],
					total: 1,
					page: 1,
					pageSize: 20,
				},
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
			mockUseCleanupExplain.mockReturnValue(defaultMutation({ mutate: explainMutate }));

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Approval Queue"));
			fireEvent.click(await screen.findByRole("button", { name: "Retry pending" }));

			expect(await screen.findByText("Signal Harbor")).toBeInTheDocument();
			expect(screen.getByText("S01E02 · First Light")).toBeInTheDocument();
			expect(
				screen.getByText("Last execution attempt: Exact episode delete failed; retry is pending"),
			).toBeInTheDocument();
			fireEvent.click(screen.getByTitle("Explain why this item was flagged"));
			expect(explainMutate).toHaveBeenCalledWith({
				instanceId: "sonarr-main",
				arrItemId: 42,
				arrEpisodeId: 9001,
			});
		});

		it("shows structured episode identity in cleanup log details", () => {
			mockUseCleanupLogs.mockReturnValue({
				data: {
					items: [
						{
							id: "log-episode",
							isDryRun: false,
							status: "partial",
							itemsEvaluated: 1,
							itemsFlagged: 1,
							itemsRemoved: 0,
							itemsUnmonitored: 0,
							itemsFilesDeleted: 0,
							itemsSkipped: 0,
							details: [
								{
									targetScope: "episode",
									seriesTitle: "Signal Harbor",
									title: "Legacy fallback title",
									seasonNumber: 1,
									episodeNumber: 2,
									episodeTitle: "First Light",
									rule: "Watched episodes",
									reason: "Exact episode delete failed",
									status: "error",
								},
							],
							error: null,
							durationMs: 500,
							startedAt: "2026-08-12T12:00:00Z",
							completedAt: "2026-08-12T12:00:00Z",
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
			fireEvent.click(screen.getByRole("button", { expanded: false }));

			expect(screen.getByText("Signal Harbor")).toBeInTheDocument();
			expect(screen.getByText("S01E02 · First Light")).toBeInTheDocument();
		});

		it("masks series and episode titles but keeps episode coordinates visible", async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 1,
						totalFlagged: 1,
						items: [makeEpisodePreviewItem()],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			await waitFor(() => {
				expect(screen.queryByText("Signal Harbor")).not.toBeInTheDocument();
				expect(screen.queryByText(/First Light/)).not.toBeInTheDocument();
			});
			expect(screen.getByText(/^S01E02 · .*\.iso$/)).toBeInTheDocument();
		});

		it("labels every cleanup rule with its target scope", () => {
			const seriesRule = makeConfig().rules[0]!;
			setupDefaultMocks({
				rules: [
					seriesRule,
					{
						...seriesRule,
						id: "rule-episode",
						name: "Watched episodes",
						targetScope: "episode",
						ruleType: "plex_watch_count",
						parameters: { operator: "greater_than", count: 1 },
						serviceFilter: ["sonarr"],
					},
				],
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(screen.getByText("Series target")).toBeInTheDocument();
			expect(screen.getByText("Episode target")).toBeInTheDocument();
		});
	});

	describe("action history", () => {
		it("keeps per-action history separate from aggregate cleanup runs", async () => {
			mockUseCleanupActivity.mockReturnValue({
				data: { items: [makeAuditTimeline()], total: 1, page: 1, pageSize: 20 },
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
			mockUseCleanupLogs.mockReturnValue({
				data: {
					items: [
						{
							id: "run-1",
							isDryRun: false,
							status: "completed",
							itemsEvaluated: 1,
							itemsFlagged: 1,
							itemsRemoved: 1,
							itemsUnmonitored: 0,
							itemsFilesDeleted: 1,
							itemsSkipped: 0,
							details: null,
							error: null,
							durationMs: 500,
							startedAt: "2026-08-12T12:00:00Z",
							completedAt: "2026-08-12T12:01:00Z",
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

			expect(await screen.findByRole("heading", { name: "Action history" })).toBeInTheDocument();
			expect(screen.getByText("Signal Harbor S01E02 · First Light")).toBeInTheDocument();
			expect(screen.getByText("Exact episode matched cleanup criteria")).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "Cleanup runs" })).toBeInTheDocument();
			expect(screen.getByText("completed")).toBeInTheDocument();
		});

		it("expands an accessible timeline and requests earlier durable events", async () => {
			const fetchNextPage = vi.fn();
			mockUseCleanupActivity.mockReturnValue({
				data: { items: [makeAuditTimeline()], total: 1, page: 1, pageSize: 20 },
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
			mockUseCleanupActivityEvents.mockReturnValue({
				data: {
					pages: [{ items: [], olderEventsCursor: "75" }],
					pageParams: ["99"],
				},
				isFetching: false,
				isFetchingNextPage: false,
				isError: false,
				isFetchNextPageError: false,
				refetch: vi.fn(),
				fetchNextPage,
				hasNextPage: true,
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Activity Log"));
			const expand = await screen.findByRole("button", {
				name: "Show history for Signal Harbor S01E02 · First Light",
			});
			expect(expand).toHaveAttribute("aria-expanded", "false");
			fireEvent.click(expand);

			expect(expand).toHaveAttribute("aria-expanded", "true");
			expect(screen.getByText("Proposal created")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Load earlier events" }));
			expect(fetchNextPage).toHaveBeenCalledOnce();
			expect(mockUseCleanupActivityEvents).toHaveBeenCalledWith("approval-episode", "99", 200);
		});

		it("keeps recent events visible and retries a failed earlier-event page", async () => {
			const refetch = vi.fn();
			mockUseCleanupActivity.mockReturnValue({
				data: { items: [makeAuditTimeline()], total: 1, page: 1, pageSize: 20 },
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});
			mockUseCleanupActivityEvents.mockReturnValue({
				data: undefined,
				isFetching: false,
				isFetchingNextPage: false,
				isError: true,
				isFetchNextPageError: false,
				refetch,
				fetchNextPage: vi.fn(),
				hasNextPage: false,
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Activity Log"));
			fireEvent.click(
				await screen.findByRole("button", {
					name: "Show history for Signal Harbor S01E02 · First Light",
				}),
			);

			expect(screen.getByText("Proposal created")).toBeInTheDocument();
			expect(screen.getByRole("alert")).toHaveTextContent("Earlier events could not be loaded");
			fireEvent.click(screen.getByRole("button", { name: "Load earlier events" }));
			expect(refetch).toHaveBeenCalledOnce();
		});

		it("masks action titles, rules, and reasons in incognito mode", async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			mockUseCleanupActivity.mockReturnValue({
				data: { items: [makeAuditTimeline()], total: 1, page: 1, pageSize: 20 },
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			});

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			fireEvent.click(screen.getByText("Activity Log"));

			await waitFor(() => {
				expect(screen.queryByText(/Signal Harbor/)).not.toBeInTheDocument();
				expect(screen.queryByText(/Watched episodes/)).not.toBeInTheDocument();
				expect(screen.queryByText(/Exact episode/)).not.toBeInTheDocument();
			});
			expect(screen.getByText(/\.iso$/)).toBeInTheDocument();
			expect(screen.getByText("Cleanup rule: Matched cleanup criteria")).toBeInTheDocument();
			expect(screen.getByText("Cleanup reason hidden in incognito mode.")).toBeInTheDocument();
		});
	});

	describe("shared Plex safety feedback", () => {
		it("masks live execution warnings in incognito mode", () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			mockUseCleanupExecute.mockReturnValue(
				defaultMutation({
					data: {
						itemsRemoved: 0,
						itemsFlagged: 0,
						status: "partial",
						warnings: ["Plex data unavailable — rules affected: Alice's 4K Cleanup"],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(
				screen.getByText("Cleanup warning details hidden in incognito mode."),
			).toBeInTheDocument();
			expect(screen.queryByText(/Alice's 4K Cleanup/)).not.toBeInTheDocument();
		});

		it("masks preview warnings in incognito mode", () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 0,
						totalFlagged: 0,
						items: [],
						warnings: ["Plex data unavailable — rules affected: Alice's 4K Cleanup"],
					},
				}),
			);

			render(<LibraryCleanupClient />, { wrapper: createWrapper() });

			expect(
				screen.getByText("Cleanup warning details hidden in incognito mode."),
			).toBeInTheDocument();
			expect(screen.queryByText(/Alice's 4K Cleanup/)).not.toBeInTheDocument();
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
			expect(screen.queryByText(/Next run reserves/)).not.toBeInTheDocument();
		});

		it("explains complete next-run selection counts and in-flight retries separately", () => {
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 5,
						totalFlagged: 2,
						pendingRetryCount: 1,
						selectionCountsComplete: true,
						selection: {
							selectedFresh: 1,
							selectedRetries: 1,
							deferredBudget: 3,
							deferredApproval: 0,
							deferredRetryFairness: 0,
							deferredInFlightTarget: 0,
							deferredDuplicateTarget: 0,
							inFlight: 2,
							blocked: 1,
							retryStateUnavailable: 0,
							retryState: "complete",
							total: 5,
						},
						items: [],
					},
				}),
			);
			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			expect(
				screen.getByText("Preview Results (2 of 5 rule matches · 1 retry pending)"),
			).toBeInTheDocument();
			expect(
				screen.getByText(
					/Next run reserves 1 fresh slot \+ 1 retry attempt\. 3 deferred\. 2 currently in flight\./,
				),
			).toBeInTheDocument();
			expect(
				screen.getByText(/Selected fresh slots include 1 currently safety-blocked item\./),
			).toBeInTheDocument();
		});

		it("fails closed when durable retry state is unavailable", () => {
			mockUseCleanupPreview.mockReturnValue(
				defaultMutation({
					data: {
						totalEvaluated: 5,
						totalFlagged: 2,
						pendingRetryCount: null,
						selectionCountsComplete: false,
						selection: {
							selectedFresh: 0,
							selectedRetries: 0,
							deferredBudget: 0,
							deferredApproval: 0,
							deferredRetryFairness: 0,
							deferredInFlightTarget: 0,
							deferredDuplicateTarget: 0,
							inFlight: 0,
							blocked: 0,
							retryStateUnavailable: 2,
							retryState: "unavailable",
							total: 2,
						},
						items: [],
					},
				}),
			);
			render(<LibraryCleanupClient />, { wrapper: createWrapper() });
			expect(
				screen.getByText("Preview Results (2 of 5 rule matches · retry count unavailable)"),
			).toBeInTheDocument();
			expect(
				screen.getByText(/Next run cannot be determined: durable retry state is unavailable\./),
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
								itemType: "series",
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
});
