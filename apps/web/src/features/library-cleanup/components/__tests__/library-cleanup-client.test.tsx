import type { CleanupConfigResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
				screen.getByText("Preview Results (0 of 0 items flagged · 1 retry pending)"),
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
