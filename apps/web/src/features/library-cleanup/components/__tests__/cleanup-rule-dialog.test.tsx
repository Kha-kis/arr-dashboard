import type { CleanupRuleResponse, CreateCleanupRule } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

// ---------------------------------------------------------------------------
// jsdom polyfills required by Radix UI
// ---------------------------------------------------------------------------

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Radix Dialog uses pointer events; jsdom doesn't support Element.hasPointerCapture
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
// Mocks — hooks and theme dependencies
// ---------------------------------------------------------------------------

const mockFieldOptions = {
	hasPlex: false,
	videoCodecs: [],
	audioCodecs: [],
	resolutions: [],
	hdrTypes: [],
	releaseGroups: [],
	plexUsers: [],
	plexCollections: [],
	plexLabels: [],
	plexLibraries: [],
	arrTags: [],
};

const mockUseServicesQuery = vi.fn();

vi.mock("@/hooks/api/useLibraryCleanup", () => ({
	useCleanupFieldOptions: () => ({ data: mockFieldOptions, isLoading: false }),
}));

vi.mock("@/hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => mockUseServicesQuery(),
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

vi.mock("@/lib/theme-gradients", () => ({
	getServiceGradient: () => ({
		from: "#3b82f6",
		to: "#8b5cf6",
		glow: "rgba(59,130,246,0.3)",
		fromLight: "#3b82f610",
		fromMedium: "#3b82f620",
		fromMuted: "#3b82f630",
	}),
}));

vi.mock("@/lib/theme-input-styles", () => ({
	getInputStyles: () => ({
		base: "test-input",
		applyFocus: vi.fn(),
		removeFocus: vi.fn(),
	}),
}));

// Import after mocks
import { CleanupRuleDialog } from "../cleanup-rule-dialog";

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

function renderDialog(props: Partial<React.ComponentProps<typeof CleanupRuleDialog>> = {}) {
	const defaultProps = {
		open: true,
		onOpenChange: vi.fn(),
		editRule: undefined as CleanupRuleResponse | null | undefined,
		templateData: undefined as CreateCleanupRule | null | undefined,
		onSave: vi.fn(),
		isSaving: false,
	};
	return render(<CleanupRuleDialog {...defaultProps} {...props} />, {
		wrapper: createWrapper(),
	});
}

function makeEditRule(overrides: Partial<CleanupRuleResponse> = {}): CleanupRuleResponse {
	return {
		id: "rule-1",
		name: "Old low-rated movies",
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
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CleanupRuleDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
		mockUseServicesQuery.mockReturnValue({ data: [] });
	});

	// ================================================================
	// Create mode
	// ================================================================

	describe("create mode", () => {
		it("renders the dialog title for create mode", () => {
			renderDialog();
			expect(screen.getByText("New Cleanup Rule")).toBeInTheDocument();
		});

		it("renders create description", () => {
			renderDialog();
			expect(
				screen.getByText("Configure when items should be flagged for cleanup."),
			).toBeInTheDocument();
		});

		it("has an empty name input", () => {
			renderDialog();
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			expect(nameInput).toHaveValue("");
		});

		it("shows the rule type picker with categories", () => {
			renderDialog();
			expect(screen.getByText("Rule Type")).toBeInTheDocument();
			// The "Content Attributes" category should be visible (it's always expanded by default)
			expect(screen.getByText("Content Attributes")).toBeInTheDocument();
		});

		it("submit button says 'Add Rule'", () => {
			renderDialog();
			expect(screen.getByText("Add Rule")).toBeInTheDocument();
		});

		it("submit button is disabled when name is empty", () => {
			renderDialog();
			const submitButton = screen.getByText("Add Rule").closest("button");
			expect(submitButton).toBeDisabled();
		});

		it("shows rule mode toggle with Single Condition and Composite Rule buttons", () => {
			renderDialog();
			expect(screen.getByText("Single Condition")).toBeInTheDocument();
			expect(screen.getByText("Composite Rule")).toBeInTheDocument();
		});

		it("defaults a new rule to series scope", () => {
			renderDialog();

			expect(screen.getByRole("button", { name: /^Series/ })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});

		it("shows only the supported episode rule controls and submits the editable threshold", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));

			expect(screen.queryByText("Rule Mode")).not.toBeInTheDocument();
			expect(screen.queryByText("Composite Rule")).not.toBeInTheDocument();
			expect(screen.queryByText("Content Attributes")).not.toBeInTheDocument();
			expect(screen.getByText("Plex Watch Count")).toBeInTheDocument();
			const operator = screen.getByLabelText("Operator");
			expect(operator).toBeDisabled();
			expect(screen.queryByRole("option", { name: "Less than" })).not.toBeInTheDocument();
			fireEvent.change(screen.getByLabelText("Count"), { target: { value: "3" } });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Watched episodes" },
			});
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					targetScope: "episode",
					ruleType: "plex_watch_count",
					parameters: { operator: "greater_than", count: 3 },
					serviceFilter: ["sonarr"],
					retentionMode: false,
					plexLibraryFilter: null,
					operator: null,
					conditions: null,
				}),
			);
		});

		it("removes Radarr instance selections when switching to episode scope", async () => {
			mockUseServicesQuery.mockReturnValue({
				data: [
					{ id: "sonarr-hd", service: "sonarr", label: "Sonarr HD" },
					{ id: "radarr-4k", service: "radarr", label: "Radarr 4K" },
				],
			});
			const onSave = vi.fn();
			renderDialog({ onSave });

			fireEvent.click(screen.getByRole("button", { name: "Sonarr HD" }));
			fireEvent.click(screen.getByRole("button", { name: "Radarr 4K" }));
			fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));

			expect(screen.getByRole("button", { name: "Sonarr HD" })).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Radarr 4K" })).not.toBeInTheDocument();
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Episode cleanup" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toEqual(
				expect.objectContaining({ instanceFilter: ["sonarr-hd"] }),
			);
		});

		it("explains the exact episode action semantics", () => {
			renderDialog();
			fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));

			expect(
				screen.getByText(
					/Unmonitor the exact Sonarr episode, then delete its verified episode file/,
				),
			).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Unmonitor" }));
			expect(screen.getByText(/Unmonitor only the exact Sonarr episode/)).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Delete Files" }));
			expect(
				screen.getByText(/episode remains monitored, so Sonarr may download it again/),
			).toBeInTheDocument();
		});

		it("defaults to delete action", () => {
			renderDialog();
			// The "Delete" button should exist
			const deleteButton = screen.getByText("Delete");
			// The description for delete action should be visible
			expect(
				screen.getByText(/Remove the item and its verified media files from the ARR instance/),
			).toBeInTheDocument();
			expect(deleteButton).toBeInTheDocument();
		});

		it("does not show template banner", () => {
			renderDialog();
			expect(screen.queryByText(/Template applied/)).not.toBeInTheDocument();
		});
	});

	// ================================================================
	// Edit mode
	// ================================================================

	describe("edit mode", () => {
		it("renders the dialog title for edit mode", () => {
			renderDialog({ editRule: makeEditRule() });
			expect(screen.getByText("Edit Rule")).toBeInTheDocument();
		});

		it("renders edit description", () => {
			renderDialog({ editRule: makeEditRule() });
			expect(screen.getByText("Modify the rule settings and click Save.")).toBeInTheDocument();
		});

		it("populates the name input from editRule", () => {
			renderDialog({ editRule: makeEditRule({ name: "My test rule" }) });
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			expect(nameInput).toHaveValue("My test rule");
		});

		it("preserves episode scope when editing an existing episode rule", () => {
			renderDialog({
				editRule: makeEditRule({
					targetScope: "episode",
					ruleType: "plex_watch_count",
					parameters: { operator: "greater_than", count: 2 },
					serviceFilter: ["sonarr"],
				}),
			});

			const episodeScope = screen.getByRole("button", { name: /^Episodes/ });
			expect(episodeScope).toHaveAttribute("aria-pressed", "true");
			expect(episodeScope).toHaveAttribute(
				"title",
				"Target scope cannot be changed while editing a rule",
			);
			expect(
				screen.getByText(
					"Target scope cannot be changed while editing. Create a new rule to use a different scope.",
				),
			).toBeInTheDocument();
		});

		it("submit button says 'Save Changes'", () => {
			renderDialog({ editRule: makeEditRule() });
			expect(screen.getByText("Save Changes")).toBeInTheDocument();
		});

		it("shows rule type as a static badge, not a picker", () => {
			renderDialog({ editRule: makeEditRule({ ruleType: "age" }) });
			// In edit mode, "Rule Type:" label is shown with a static badge
			expect(screen.getByText("Rule Type:")).toBeInTheDocument();
			expect(screen.getByText("Age")).toBeInTheDocument();
			// The rule type picker should NOT be rendered
			expect(screen.queryByText("Rule Type")).not.toBeInTheDocument();
		});

		it("hydrates rating rule with unrated operator", () => {
			renderDialog({
				editRule: makeEditRule({
					ruleType: "rating",
					parameters: { source: "tmdb", operator: "unrated" },
				}),
			});
			expect(screen.getByText("Rating")).toBeInTheDocument();
		});

		it("hydrates composite rule with conditions", () => {
			renderDialog({
				editRule: makeEditRule({
					ruleType: "composite",
					operator: "AND",
					conditions: [
						{ ruleType: "age", parameters: { operator: "older_than", days: 90 } },
						{ ruleType: "rating", parameters: { source: "tmdb", operator: "less_than", score: 5 } },
					],
					parameters: {},
				}),
			});
			// Should switch to composite mode and show conditions
			expect(screen.getByText("Condition 1")).toBeInTheDocument();
			expect(screen.getByText("Condition 2")).toBeInTheDocument();
		});

		it("hydrates retention mode from editRule", () => {
			renderDialog({
				editRule: makeEditRule({ retentionMode: true }),
			});
			// The Retention Rule switch should be checked
			const retentionLabel = screen.getByText("Retention Rule");
			expect(retentionLabel).toBeInTheDocument();
		});

		it("hydrates action from editRule", () => {
			renderDialog({
				editRule: makeEditRule({ action: "unmonitor" }),
			});
			expect(
				screen.getByText("Set the item as unmonitored (keeps files and data)."),
			).toBeInTheDocument();
		});
	});

	// ================================================================
	// Template mode
	// ================================================================

	describe("template mode", () => {
		it("shows template banner when templateData is provided", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					targetScope: "series",
					ruleType: "composite",
					enabled: true,
					priority: 0,
					parameters: {},
					action: "unmonitor",
					retentionMode: true,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
					operator: "AND",
					conditions: [{ ruleType: "age", parameters: { operator: "older_than", days: 90 } }],
				},
			});
			expect(screen.getByText(/Template applied/)).toBeInTheDocument();
		});

		it("prefills name from template", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					targetScope: "series",
					ruleType: "age",
					enabled: true,
					priority: 0,
					parameters: { operator: "older_than", days: 90 },
					action: "delete",
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
				},
			});
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			expect(nameInput).toHaveValue("Template Rule");
		});

		it("prefills action from template", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					targetScope: "series",
					ruleType: "age",
					enabled: true,
					priority: 0,
					parameters: {},
					action: "unmonitor",
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
				},
			});
			expect(
				screen.getByText("Set the item as unmonitored (keeps files and data)."),
			).toBeInTheDocument();
		});

		it("shows template banner with username hint when conditions have userNames", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					targetScope: "series",
					ruleType: "composite",
					enabled: true,
					priority: 0,
					parameters: {},
					action: "delete",
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
					operator: "AND",
					conditions: [
						{
							ruleType: "seerr_requested_by",
							parameters: { userNames: [] },
						},
					],
				},
			});
			expect(screen.getByText(/Fill in the usernames in each condition below/)).toBeInTheDocument();
		});

		it("uses create mode title (not edit) for template", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					targetScope: "series",
					ruleType: "age",
					enabled: true,
					priority: 0,
					parameters: {},
					action: "delete",
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
				},
			});
			expect(screen.getByText("New Cleanup Rule")).toBeInTheDocument();
		});

		it("prefills composite conditions from template", () => {
			renderDialog({
				templateData: {
					name: "Composite Template",
					targetScope: "series",
					ruleType: "composite",
					enabled: true,
					priority: 0,
					parameters: {},
					action: "delete",
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
					operator: "OR",
					conditions: [
						{ ruleType: "age", parameters: { operator: "older_than", days: 90 } },
						{ ruleType: "size", parameters: { operator: "greater_than", sizeGb: 100 } },
					],
				},
			});
			expect(screen.getByText("Condition 1")).toBeInTheDocument();
			expect(screen.getByText("Condition 2")).toBeInTheDocument();
		});
	});

	// ================================================================
	// Composite validation
	// ================================================================

	describe("composite validation", () => {
		it("rejects a Jellyfin watched-by condition with no selected users", async () => {
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "composite",
					parameters: {},
					operator: "AND",
					conditions: [
						{
							ruleType: "jellyfin_watched_by",
							parameters: { operator: "includes_any", userNames: [] },
						},
					],
				}),
			});

			fireEvent.click(screen.getByText("Save Changes").closest("button")!);

			await waitFor(() =>
				expect(
					screen.getByText(
						"Each condition that targets users must have at least one username selected.",
					),
				).toBeInTheDocument(),
			);
			expect(onSave).not.toHaveBeenCalled();
		});

		it("shows error when submitting composite with zero conditions", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			// Type a name to enable the submit button
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			fireEvent.change(nameInput, { target: { value: "Test Rule" } });

			// Switch to composite mode
			fireEvent.click(screen.getByText("Composite Rule"));

			// Submit the form
			const submitButton = screen.getByText("Add Rule").closest("button")!;
			fireEvent.click(submitButton);

			// Error should appear
			await waitFor(() => {
				expect(
					screen.getByText("Composite rules must have at least one condition"),
				).toBeInTheDocument();
			});

			// onSave should NOT have been called
			expect(onSave).not.toHaveBeenCalled();
		});

		it("clears composite error when adding a condition", async () => {
			renderDialog();

			// Type a name
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			fireEvent.change(nameInput, { target: { value: "Test Rule" } });

			// Switch to composite mode
			fireEvent.click(screen.getByText("Composite Rule"));

			// Submit (to trigger the error)
			const submitButton = screen.getByText("Add Rule").closest("button")!;
			fireEvent.click(submitButton);

			await waitFor(() => {
				expect(
					screen.getByText("Composite rules must have at least one condition"),
				).toBeInTheDocument();
			});

			// Add a condition
			fireEvent.click(screen.getByText("+ Add Condition"));

			// Error should be gone
			expect(
				screen.queryByText("Composite rules must have at least one condition"),
			).not.toBeInTheDocument();
		});

		it("calls onSave with composite data when conditions exist", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			// Fill name
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			fireEvent.change(nameInput, { target: { value: "Composite Test" } });

			// Switch to composite mode
			fireEvent.click(screen.getByText("Composite Rule"));

			// Add a condition
			fireEvent.click(screen.getByText("+ Add Condition"));

			// Submit
			const submitButton = screen.getByText("Add Rule").closest("button")!;
			fireEvent.click(submitButton);

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledTimes(1);
			});

			const savedData = onSave.mock.calls[0]![0] as CreateCleanupRule;
			expect(savedData.name).toBe("Composite Test");
			expect(savedData.ruleType).toBe("composite");
			expect(savedData.operator).toBe("AND");
			expect(savedData.conditions).toHaveLength(1);
			expect(savedData.conditions![0]!.ruleType).toBe("age");
		});
	});

	// ================================================================
	// Submit behavior
	// ================================================================

	describe("submit behavior", () => {
		it("calls onSave with correct data for a single-condition rule", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			// Fill name
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			fireEvent.change(nameInput, { target: { value: "Age Rule" } });

			// Submit (default rule type is "age")
			const submitButton = screen.getByText("Add Rule").closest("button")!;
			fireEvent.click(submitButton);

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledTimes(1);
			});

			const savedData = onSave.mock.calls[0]![0] as CreateCleanupRule;
			expect(savedData.name).toBe("Age Rule");
			expect(savedData.ruleType).toBe("age");
			expect(savedData.parameters).toHaveProperty("operator");
			expect(savedData.parameters).toHaveProperty("days");
			expect(savedData.operator).toBeNull();
			expect(savedData.conditions).toBeNull();
		});

		it("disables submit button when isSaving is true", () => {
			renderDialog({ isSaving: true });

			// Fill name so the button would normally be enabled
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			fireEvent.change(nameInput, { target: { value: "Test" } });

			const submitButton = screen.getByText("Add Rule").closest("button")!;
			expect(submitButton).toBeDisabled();
		});

		it("submit button becomes enabled when name is filled", () => {
			renderDialog();
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			const submitButton = screen.getByText("Add Rule").closest("button")!;

			expect(submitButton).toBeDisabled();

			fireEvent.change(nameInput, { target: { value: "My Rule" } });
			expect(submitButton).not.toBeDisabled();
		});
	});

	// ================================================================
	// Dialog state management
	// ================================================================

	describe("dialog state management", () => {
		it("switching to composite mode clears single-condition state", () => {
			renderDialog();

			// Should show rule type picker in single condition mode
			expect(screen.getByText("Rule Type")).toBeInTheDocument();

			// Switch to composite
			fireEvent.click(screen.getByText("Composite Rule"));

			// Rule type picker should be gone, composite builder should appear
			expect(screen.queryByText("Rule Type")).not.toBeInTheDocument();
			expect(screen.getByText("Operator")).toBeInTheDocument();
			expect(screen.getByText("+ Add Condition")).toBeInTheDocument();
		});

		it("switching back to single condition clears composite state", async () => {
			renderDialog();

			// Switch to composite
			fireEvent.click(screen.getByText("Composite Rule"));

			// Add a condition
			fireEvent.click(screen.getByText("+ Add Condition"));
			expect(screen.getByText("Condition 1")).toBeInTheDocument();

			// Switch back to single
			fireEvent.click(screen.getByText("Single Condition"));

			// Composite content should be gone
			expect(screen.queryByText("Condition 1")).not.toBeInTheDocument();
			expect(screen.queryByText("+ Add Condition")).not.toBeInTheDocument();
			// Rule type picker should be back
			expect(screen.getByText("Rule Type")).toBeInTheDocument();
		});

		it("cancel button calls onOpenChange with false", () => {
			const onOpenChange = vi.fn();
			renderDialog({ onOpenChange });

			fireEvent.click(screen.getByText("Cancel"));
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	// ================================================================
	// Issue #474: rejection-memory encoding round-trip
	//
	// The dialog dropdown encodes Off/Days/Forever onto the wire shape
	// (`useGlobalRejectionMemory` boolean + `rejectionMemoryDays` int|null).
	// These tests pin the encoding so a future contributor renaming or
	// retyping the wire fields trips the test immediately.
	// ================================================================

	describe("rejection-memory encoding (issue #474)", () => {
		function submitMinimalRule() {
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			fireEvent.change(nameInput, { target: { value: "Test Rule" } });
			fireEvent.click(screen.getByText("Add Rule").closest("button") as HTMLElement);
		}

		it("defaults to inherit-from-config (override off; rejectionMemoryDays omitted from payload)", () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			submitMinimalRule();

			expect(onSave).toHaveBeenCalledTimes(1);
			const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
			expect(payload.useGlobalRejectionMemory).toBe(true);
			// When override is off, the dialog deliberately omits
			// `rejectionMemoryDays` so the PATCH route preserves any stored
			// override value the user may have saved earlier.
			expect(payload).not.toHaveProperty("rejectionMemoryDays");
		});

		it("override on + mode 'Off' → payload sends rejectionMemoryDays: 0", () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			// Turn the override toggle on. The toggle label is "Override
			// rejection memory" — the surrounding Switch is the closest
			// interactive element.
			const overrideLabel = screen.getByText("Override rejection memory");
			const overrideSwitch = overrideLabel
				.closest("div.flex.items-center.justify-between")!
				.querySelector("button[role='switch']") as HTMLButtonElement;
			fireEvent.click(overrideSwitch);

			// Mode dropdown defaults to "off" — leave it.
			submitMinimalRule();

			const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
			expect(payload.useGlobalRejectionMemory).toBe(false);
			expect(payload.rejectionMemoryDays).toBe(0);
		});

		it("override on + mode 'Forever' → payload sends rejectionMemoryDays: null", () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			const overrideLabel = screen.getByText("Override rejection memory");
			const overrideSwitch = overrideLabel
				.closest("div.flex.items-center.justify-between")!
				.querySelector("button[role='switch']") as HTMLButtonElement;
			fireEvent.click(overrideSwitch);

			// The mode dropdown is the only <select> revealed by the toggle.
			const modeSelect = screen.getByDisplayValue(
				"Off — re-propose rejected items",
			) as HTMLSelectElement;
			fireEvent.change(modeSelect, { target: { value: "forever" } });
			submitMinimalRule();

			const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
			expect(payload.useGlobalRejectionMemory).toBe(false);
			expect(payload.rejectionMemoryDays).toBeNull();
		});

		it("override on + mode 'Days' with N=14 → payload sends rejectionMemoryDays: 14", () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			const overrideLabel = screen.getByText("Override rejection memory");
			const overrideSwitch = overrideLabel
				.closest("div.flex.items-center.justify-between")!
				.querySelector("button[role='switch']") as HTMLButtonElement;
			fireEvent.click(overrideSwitch);

			const modeSelect = screen.getByDisplayValue(
				"Off — re-propose rejected items",
			) as HTMLSelectElement;
			fireEvent.change(modeSelect, { target: { value: "days" } });

			// Days input only appears when mode = "days".
			const daysInput = screen.getByDisplayValue("30") as HTMLInputElement;
			fireEvent.change(daysInput, { target: { value: "14" } });

			submitMinimalRule();

			const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
			expect(payload.useGlobalRejectionMemory).toBe(false);
			expect(payload.rejectionMemoryDays).toBe(14);
		});
	});
});
