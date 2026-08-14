import type { CleanupRuleExpression, CleanupRuleResponse, CreateCleanupRule } from "@arr/shared";
import { createCleanupRuleSchema } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "@/contexts/IncognitoContext";

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
	hasTautulli: false,
	videoCodecs: [],
	audioCodecs: [],
	resolutions: [],
	hdrTypes: [],
	releaseGroups: [],
	tautulliUsers: [],
	plexUsers: [],
	plexCollections: [],
	plexLabels: [],
	plexLibraries: [],
	arrTags: [],
};

const mockServicesQueryState: {
	data: Array<{ id: string; service: "sonarr" | "radarr"; enabled: boolean }> | undefined;
	isLoading: boolean;
	isFetching: boolean;
	isError: boolean;
} = {
	data: [],
	isLoading: false,
	isFetching: false,
	isError: false,
};

vi.mock("@/hooks/api/useLibraryCleanup", () => ({
	useCleanupFieldOptions: () => ({ data: mockFieldOptions, isLoading: false }),
}));

vi.mock("@/hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => mockServicesQueryState,
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
		<IncognitoProvider>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</IncognitoProvider>
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
		ruleType: "age",
		parameters: { field: "arrAddedAt", operator: "older_than", days: 365 },
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "series",
		scanMediaServerAfterDelete: false,
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
		mockServicesQueryState.data = [];
		mockServicesQueryState.isLoading = false;
		mockServicesQueryState.isFetching = false;
		mockServicesQueryState.isError = false;
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

		it("defaults to series scope and warns that Plex totals and destructive actions are series-wide", () => {
			renderDialog();

			expect(screen.getByRole("button", { name: /^Series/ })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			expect(
				screen.getByText(
					/Plex conditions use show-level totals.*affect the entire series and all of its episode files/,
				),
			).toBeInTheDocument();
		});

		it("constrains episode scope to a positive Plex watch count on Sonarr", () => {
			renderDialog();

			fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));

			expect(screen.queryByText("Composite Rule")).not.toBeInTheDocument();
			expect(screen.queryByText("Retention Rule")).not.toBeInTheDocument();
			expect(screen.getByText("Plex: Watch Count")).toBeInTheDocument();
			expect(screen.getByText(/Only Plex Watch Count is supported/)).toBeInTheDocument();
			expect(screen.getByDisplayValue("Greater than")).toBeDisabled();
			expect(screen.getByRole("button", { name: "Filter by sonarr" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			expect(screen.queryByRole("button", { name: "Filter by radarr" })).not.toBeInTheDocument();
		});

		it("submits the enforced episode rule shape", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });

			fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Watched episodes" },
			});
			fireEvent.change(screen.getByLabelText("Count"), { target: { value: "2" } });
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				targetScope: "episode",
				ruleType: "plex_watch_count",
				parameters: { operator: "greater_than", count: 2 },
				serviceFilter: ["sonarr"],
				retentionMode: false,
				plexLibraryFilter: null,
				operator: null,
				conditions: null,
			});
		});

		it("submits the optional post-delete media-server scan setting", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Delete and refresh" },
			});
			fireEvent.click(screen.getByRole("switch", { name: "Scan media servers after deletion" }));
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				action: "delete",
				scanMediaServerAfterDelete: true,
			});
		});

		it("hides and clears the scan setting for unmonitor", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Unmonitor only" },
			});
			fireEvent.click(screen.getByRole("switch", { name: "Scan media servers after deletion" }));
			fireEvent.click(screen.getByText("Unmonitor"));
			expect(
				screen.queryByRole("switch", { name: "Scan media servers after deletion" }),
			).not.toBeInTheDocument();
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				action: "unmonitor",
				scanMediaServerAfterDelete: false,
			});
		});

		it("creates a top-level TMDb list rule with its parameters", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Not in collection" },
			});
			fireEvent.click(screen.getByText("Curated Lists"));
			fireEvent.click(screen.getByText("TMDb List Membership"));
			fireEvent.change(screen.getByLabelText("TMDb list ID"), { target: { value: "8068" } });
			fireEvent.change(screen.getByLabelText("Operator"), { target: { value: "not_in" } });
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				ruleType: "tmdb_list_member",
				parameters: { listId: "8068", operator: "not_in" },
			});
		});

		it("submits monitored as a standalone parameterless rule", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Currently monitored" },
			});
			fireEvent.click(screen.getByText("Monitored"));
			expect(
				screen.getByText("Matches all monitored items. No additional parameters."),
			).toBeInTheDocument();
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				ruleType: "monitored",
				parameters: {},
			});
		});

		it("forces a top-level IMDb rule to Radarr only", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Low IMDb" },
			});
			fireEvent.click(screen.getByText("IMDb Rating"));
			await waitFor(() => {
				expect(screen.queryByRole("button", { name: "Filter by sonarr" })).not.toBeInTheDocument();
			});
			expect(screen.getByRole("button", { name: "Filter by radarr" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			expect(
				screen.getByText(
					"IMDb ratings are provided by Radarr, so this rule always targets Radarr only.",
				),
			).toBeInTheDocument();
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				ruleType: "imdb_rating",
				serviceFilter: ["radarr"],
			});
		});

		it("preserves a saved IMDb instance scope while services are still loading", async () => {
			mockServicesQueryState.data = undefined;
			mockServicesQueryState.isLoading = true;
			mockServicesQueryState.isFetching = true;
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "imdb_rating",
					parameters: { operator: "unrated" },
					instanceFilter: ["radarr-1"],
				}),
			});

			expect(
				screen.getByText(
					"Service instances must finish loading successfully before this IMDb scope can be saved.",
				),
			).toBeInTheDocument();
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			expect(onSave).not.toHaveBeenCalled();

			mockServicesQueryState.data = [{ id: "radarr-1", service: "radarr", enabled: true }];
			mockServicesQueryState.isLoading = false;
			mockServicesQueryState.isFetching = false;
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "IMDb after loading" },
			});
			await waitFor(() =>
				expect(
					screen.queryByText(/Service instances must finish loading successfully/),
				).not.toBeInTheDocument(),
			);
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({ instanceFilter: ["radarr-1"] });
		});

		it("preserves and blocks a saved IMDb scope when service loading fails", () => {
			mockServicesQueryState.data = [{ id: "radarr-1", service: "radarr", enabled: true }];
			mockServicesQueryState.isError = true;
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "imdb_rating",
					parameters: { operator: "unrated" },
					instanceFilter: ["radarr-1"],
				}),
			});

			expect(
				screen.getByText(
					"Service instances must finish loading successfully before this IMDb scope can be saved.",
				),
			).toBeInTheDocument();
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			expect(onSave).not.toHaveBeenCalled();
		});

		it("preserves disabled and unknown Radarr IDs but blocks saving them", () => {
			mockServicesQueryState.data = [{ id: "radarr-disabled", service: "radarr", enabled: false }];
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "imdb_rating",
					parameters: { operator: "unrated" },
					instanceFilter: ["radarr-disabled", "radarr-unknown"],
				}),
			});

			expect(
				screen.getByText(
					"Every selected IMDb instance must be an enabled Radarr instance. Unknown and disabled selections are preserved until they can be corrected.",
				),
			).toBeInTheDocument();
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			expect(onSave).not.toHaveBeenCalled();
		});

		it("removes only a proven Sonarr ID from an IMDb instance scope", async () => {
			mockServicesQueryState.data = [
				{ id: "sonarr-1", service: "sonarr", enabled: true },
				{ id: "radarr-1", service: "radarr", enabled: true },
			];
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "imdb_rating",
					parameters: { operator: "unrated" },
					instanceFilter: ["sonarr-1", "radarr-1"],
				}),
			});

			await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({ instanceFilter: ["radarr-1"] });
		});

		it("blocks an IMDb rule whose proven Sonarr scope would otherwise become all instances", async () => {
			mockServicesQueryState.data = [{ id: "sonarr-1", service: "sonarr", enabled: true }];
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "imdb_rating",
					parameters: { operator: "unrated" },
					instanceFilter: ["sonarr-1"],
				}),
			});

			await waitFor(() =>
				expect(
					screen.getByText(
						"The saved IMDb instance scope contained only Sonarr instances. Select an enabled Radarr instance before saving.",
					),
				).toBeInTheDocument(),
			);
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			expect(onSave).not.toHaveBeenCalled();
		});

		it("explains exact episode action semantics", () => {
			renderDialog();
			fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));

			expect(
				screen.getByText(
					/Unmonitor the exact Sonarr episode, then delete its verified episode file/,
				),
			).toBeInTheDocument();

			fireEvent.click(screen.getByText("Delete Files"));
			expect(
				screen.getByText(/episode remains monitored, so Sonarr may download it again/),
			).toBeInTheDocument();

			fireEvent.click(screen.getByText("Unmonitor"));
			expect(screen.getByText(/Unmonitor only the exact Sonarr episode/)).toBeInTheDocument();
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

		it("keeps rule mode immutable while editing", () => {
			renderDialog({
				editRule: makeEditRule({
					ruleType: "composite",
					operator: "AND",
					conditions: [{ ruleType: "age", parameters: { operator: "older_than", days: 90 } }],
					parameters: {},
				}),
			});

			expect(screen.queryByRole("button", { name: "Single Condition" })).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Composite Rule" })).not.toBeInTheDocument();
			expect(
				screen.getByText(
					"Rule mode and type cannot be changed while editing. Create a new rule to use a different mode or condition type.",
				),
			).toBeInTheDocument();
			expect(screen.getByText("Condition 1")).toBeInTheDocument();
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

		it("hydrates and preserves a monitored rule while editing", async () => {
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					name: "Currently monitored",
					ruleType: "monitored",
					parameters: {},
				}),
			});
			expect(
				screen.getByText("Matches all monitored items. No additional parameters."),
			).toBeInTheDocument();
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({ ruleType: "monitored", parameters: {} });
		});

		it("detects nested NOT IMDb and preserves Radarr-only scope", async () => {
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "composite",
					parameters: {},
					serviceFilter: ["SONARR", "RADARR"],
					expression: {
						version: 1,
						root: {
							type: "not",
							child: {
								type: "condition",
								ruleType: "imdb_rating",
								parameters: { operator: "unrated" },
							},
						},
					},
				}),
			});
			await waitFor(() => {
				expect(screen.queryByRole("button", { name: "Filter by sonarr" })).not.toBeInTheDocument();
			});
			expect(screen.getByRole("button", { name: "Filter by radarr" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				serviceFilter: ["radarr"],
				expression: { version: 1, root: { type: "not" } },
			});
		});

		it("hydrates and round-trips an existing Trakt list rule", async () => {
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "trakt_list_member",
					parameters: { listSlug: "alice/favorites", operator: "not_in" },
				}),
			});

			expect(screen.getByLabelText("Trakt list (username/list-slug)")).toHaveValue(
				"alice/favorites",
			);
			expect(screen.getByLabelText("Operator")).toHaveValue("not_in");
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				ruleType: "trakt_list_member",
				parameters: { listSlug: "alice/favorites", operator: "not_in" },
			});
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

		it("round-trips an existing nested expression without flattening it", async () => {
			const onSave = vi.fn();
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "composite",
					parameters: {},
					expression: {
						version: 1,
						root: {
							type: "group",
							operator: "OR",
							children: [
								{
									type: "not",
									child: {
										type: "condition",
										ruleType: "age",
										parameters: { operator: "older_than", days: 90 },
									},
								},
							],
						},
					},
				}),
			});
			expect(screen.getByText("NOT")).toBeInTheDocument();
			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect((onSave.mock.calls[0]![0] as CreateCleanupRule).expression).toMatchObject({
				version: 1,
				root: { type: "group", operator: "OR", children: [{ type: "not" }] },
			});
		});

		it("round-trips a non-group root at the exact depth limit", async () => {
			const onSave = vi.fn();
			let root: CleanupRuleExpression = {
				type: "condition",
				ruleType: "age",
				parameters: { operator: "older_than", days: 90 },
			};
			for (let depth = 1; depth < 8; depth++) {
				root = { type: "not", child: root };
			}
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "composite",
					parameters: {},
					expression: { version: 1, root },
				}),
			});

			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			const payload = onSave.mock.calls[0]![0] as CreateCleanupRule;
			expect(payload.expression).toEqual({ version: 1, root });
			expect(createCleanupRuleSchema.safeParse(payload).success).toBe(true);
		});

		it("keeps a direct condition root versioned instead of flattening it to legacy storage", async () => {
			const onSave = vi.fn();
			const root: CleanupRuleExpression = {
				type: "condition",
				ruleType: "age",
				parameters: { operator: "older_than", days: 90 },
			};
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "composite",
					parameters: {},
					expression: { version: 1, root },
				}),
			});

			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			const payload = onSave.mock.calls[0]![0] as CreateCleanupRule;
			expect(payload.operator).toBeNull();
			expect(payload.conditions).toBeNull();
			expect(payload.expression).toEqual({ version: 1, root });
		});

		it("round-trips a non-group root at the exact node limit", async () => {
			const onSave = vi.fn();
			const conditions: CleanupRuleExpression[] = Array.from({ length: 98 }, () => ({
				type: "condition",
				ruleType: "age",
				parameters: { operator: "older_than", days: 90 },
			}));
			const root: CleanupRuleExpression = {
				type: "not",
				child: { type: "group", operator: "AND", children: conditions },
			};
			renderDialog({
				onSave,
				editRule: makeEditRule({
					ruleType: "composite",
					parameters: {},
					expression: { version: 1, root },
				}),
			});

			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			const payload = onSave.mock.calls[0]![0] as CreateCleanupRule;
			expect(payload.expression).toEqual({ version: 1, root });
			expect(createCleanupRuleSchema.safeParse(payload).success).toBe(true);
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

		it("keeps target scope and rule configuration immutable while editing", async () => {
			const onSave = vi.fn();
			renderDialog({ editRule: makeEditRule(), onSave });

			const seriesButton = screen.getByRole("button", { name: /^Series/ });
			const episodeButton = screen.getByRole("button", { name: /^Episodes/ });
			expect(seriesButton).toBeDisabled();
			expect(episodeButton).toBeDisabled();
			expect(screen.getByText(/Target scope cannot be changed while editing/)).toBeInTheDocument();

			fireEvent.click(episodeButton);
			expect(seriesButton).toHaveAttribute("aria-pressed", "true");
			expect(screen.getByText("Age")).toBeInTheDocument();

			fireEvent.click(screen.getByText("Save Changes").closest("button")!);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				targetScope: "series",
				ruleType: "age",
				parameters: { field: "arrAddedAt", operator: "older_than", days: 365 },
			});
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
					ruleType: "composite",
					enabled: true,
					targetScope: "series",
					priority: 0,
					parameters: {},
					action: "unmonitor",
					scanMediaServerAfterDelete: false,
					retentionMode: true,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
					operator: "AND",
					conditions: [{ ruleType: "age", parameters: { operator: "older_than", days: 90 } }],
				} as CreateCleanupRule,
			});
			expect(screen.getByText(/Template applied/)).toBeInTheDocument();
		});

		it("prefills name from template", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					ruleType: "age",
					enabled: true,
					targetScope: "series",
					priority: 0,
					parameters: { operator: "older_than", days: 90 },
					action: "delete",
					scanMediaServerAfterDelete: false,
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
				} as CreateCleanupRule,
			});
			const nameInput = screen.getByPlaceholderText("e.g., Old low-rated movies");
			expect(nameInput).toHaveValue("Template Rule");
		});

		it("prefills action from template", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					ruleType: "age",
					enabled: true,
					targetScope: "series",
					priority: 0,
					parameters: {},
					action: "unmonitor",
					scanMediaServerAfterDelete: false,
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
				} as CreateCleanupRule,
			});
			expect(
				screen.getByText("Set the item as unmonitored (keeps files and data)."),
			).toBeInTheDocument();
		});

		it("shows template banner with username hint when conditions have userNames", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					ruleType: "composite",
					enabled: true,
					targetScope: "series",
					priority: 0,
					parameters: {},
					action: "delete",
					scanMediaServerAfterDelete: false,
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
				} as CreateCleanupRule,
			});
			expect(screen.getByText(/Fill in the usernames in each condition below/)).toBeInTheDocument();
		});

		it("uses create mode title (not edit) for template", () => {
			renderDialog({
				templateData: {
					name: "Template Rule",
					ruleType: "age",
					enabled: true,
					targetScope: "series",
					priority: 0,
					parameters: {},
					action: "delete",
					scanMediaServerAfterDelete: false,
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
				} as CreateCleanupRule,
			});
			expect(screen.getByText("New Cleanup Rule")).toBeInTheDocument();
		});

		it("prefills composite conditions from template", () => {
			renderDialog({
				templateData: {
					name: "Composite Template",
					ruleType: "composite",
					enabled: true,
					targetScope: "series",
					priority: 0,
					parameters: {},
					action: "delete",
					scanMediaServerAfterDelete: false,
					retentionMode: false,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: 0,
					operator: "OR",
					conditions: [
						{ ruleType: "age", parameters: { operator: "older_than", days: 90 } },
						{ ruleType: "size", parameters: { operator: "greater_than", sizeGb: 100 } },
					],
				} as CreateCleanupRule,
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

		it("creates and serializes a nested Trakt list condition", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Nested list rule" },
			});
			fireEvent.click(screen.getByText("Composite Rule"));
			fireEvent.click(screen.getByText("+ Add Condition"));
			fireEvent.change(screen.getByLabelText("Condition type"), {
				target: { value: "trakt_list_member" },
			});
			fireEvent.change(screen.getByLabelText("Trakt list (username/list-slug)"), {
				target: { value: "alice/favorites" },
			});
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(onSave.mock.calls[0]![0]).toMatchObject({
				ruleType: "composite",
				conditions: [
					{
						ruleType: "trakt_list_member",
						parameters: { listSlug: "alice/favorites", operator: "is_in" },
					},
				],
			});
		});

		it("serializes nested groups and NOT as a versioned expression", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Nested Test" },
			});
			fireEvent.click(screen.getByText("Composite Rule"));
			fireEvent.click(screen.getByText("+ Group"));
			fireEvent.click(screen.getAllByText("+ NOT")[0]!);
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			const savedData = onSave.mock.calls[0]![0] as CreateCleanupRule;
			expect(savedData.operator).toBeNull();
			expect(savedData.conditions).toBeNull();
			expect(savedData.expression).toMatchObject({
				version: 1,
				root: {
					type: "group",
					operator: "AND",
					children: [
						{
							type: "group",
							children: [{ type: "condition" }, { type: "not" }],
						},
					],
				},
			});
		});

		it("can negate a nested group", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Negated Group" },
			});
			fireEvent.click(screen.getByText("Composite Rule"));
			fireEvent.click(screen.getByText("+ NOT"));
			fireEvent.click(screen.getByText("Use group"));
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect((onSave.mock.calls[0]![0] as CreateCleanupRule).expression).toMatchObject({
				version: 1,
				root: {
					type: "group",
					children: [
						{
							type: "not",
							child: { type: "group", children: [{ type: "condition" }] },
						},
					],
				},
			});
		});

		it("authors the deepest UI expression at the same boundary accepted by the API", async () => {
			const onSave = vi.fn();
			renderDialog({ onSave });
			fireEvent.change(screen.getByPlaceholderText("e.g., Old low-rated movies"), {
				target: { value: "Depth Boundary" },
			});
			fireEvent.click(screen.getByText("Composite Rule"));
			fireEvent.click(screen.getByText("+ Group"));
			for (let depth = 0; depth < 5; depth++) {
				fireEvent.click(screen.getAllByText("+ Group")[0]!);
			}
			fireEvent.click(screen.getByText("Add Rule").closest("button")!);

			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			expect(createCleanupRuleSchema.safeParse(onSave.mock.calls[0]![0]).success).toBe(true);
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
