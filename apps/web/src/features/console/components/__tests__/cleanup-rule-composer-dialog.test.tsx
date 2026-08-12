/**
 * Rendered tests for the composer's cleanup create/edit dialog — the flagship
 * WRITE path. These cover the populated-data paths an empty-dev-DB live-verify
 * is blind to (feedback_review_catches_data_dependent_bugs):
 *   - create → the exact merged v0 payload POSTed (core action + serialized
 *     condition quartet)
 *   - edit → a real two-condition composite prefilled from the read API's v1
 *     document, then saved as a PARTIAL update (advanced filters omitted →
 *     preserved by the route's !== undefined discipline)
 */

import type { AutomationRulesResponse, CleanupConfigResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

// jsdom polyfills for Radix Dialog
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

// ── Mocks ───────────────────────────────────────────────────────────

const createMutate = vi.fn().mockResolvedValue({});
const updateMutate = vi.fn().mockResolvedValue({});

let automationData: AutomationRulesResponse = { rules: [] };
let configData: CleanupConfigResponse | undefined;

vi.mock("@/hooks/api/useLibraryCleanup", () => ({
	useCleanupFieldOptions: () => ({ data: { hasPlex: false }, isLoading: false }),
	useCleanupConfig: () => ({ data: configData }),
	useCreateCleanupRule: () => ({ mutateAsync: createMutate, isPending: false }),
	useUpdateCleanupRule: () => ({ mutateAsync: updateMutate, isPending: false }),
}));

vi.mock("@/hooks/api/useAutomation", () => ({
	useAutomationRules: () => ({ data: automationData }),
}));

vi.mock("@/hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#3b82f6", to: "#8b5cf6", fromLight: "#3b82f610", fromMuted: "#3b82f630" },
	}),
}));

vi.mock("@/lib/theme-input-styles", () => ({
	getInputStyles: () => ({ base: "test-input", applyFocus: vi.fn(), removeFocus: vi.fn() }),
}));

// Import after mocks
import { CleanupRuleComposerDialog } from "../cleanup-rule-composer-dialog";

function wrapper(ui: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<IncognitoProvider>{ui}</IncognitoProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	createMutate.mockClear();
	updateMutate.mockClear();
	automationData = { rules: [] };
	configData = undefined;
});

describe("CleanupRuleComposerDialog — create", () => {
	it("defaults a new rule to series scope", () => {
		wrapper(<CleanupRuleComposerDialog open onOpenChange={() => {}} />);

		expect(screen.getByRole("button", { name: /^Series/ })).toHaveAttribute("aria-pressed", "true");
	});

	it("serializes the constrained episode payload", async () => {
		wrapper(<CleanupRuleComposerDialog open onOpenChange={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));
		fireEvent.change(screen.getByPlaceholderText(/old low-rated movies/i), {
			target: { value: "Watched episodes" },
		});
		fireEvent.click(screen.getByRole("button", { name: /create rule/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
		expect(createMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "episode",
				ruleType: "plex_watch_count",
				parameters: { operator: "greater_than", count: 1 },
				serviceFilter: ["sonarr"],
				retentionMode: false,
				plexLibraryFilter: null,
				operator: null,
				conditions: null,
			}),
		);
	});

	it("POSTs the merged core-action + serialized single-condition payload", async () => {
		wrapper(<CleanupRuleComposerDialog open onOpenChange={() => {}} />);

		fireEvent.change(screen.getByPlaceholderText(/old low-rated movies/i), {
			target: { value: "My rule" },
		});
		fireEvent.click(screen.getByRole("button", { name: /create rule/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
		expect(createMutate).toHaveBeenCalledWith({
			name: "My rule",
			enabled: true,
			action: "delete",
			retentionMode: false,
			targetScope: "series",
			// Default seed condition is age; single → operator/conditions null.
			ruleType: "age",
			parameters: { operator: "older_than", days: 30 },
			operator: null,
			conditions: null,
		});
	});

	it("blocks save on a whitespace-only name (native `required` passes it, the trim guard catches it)", async () => {
		wrapper(<CleanupRuleComposerDialog open onOpenChange={() => {}} />);
		fireEvent.change(screen.getByPlaceholderText(/old low-rated movies/i), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByRole("button", { name: /create rule/i }));
		await screen.findByText(/give the rule a name/i);
		expect(createMutate).not.toHaveBeenCalled();
	});
});

describe("CleanupRuleComposerDialog — edit", () => {
	beforeEach(() => {
		// A real two-condition AND composite, as the read API would serve it (v1).
		automationData = {
			rules: [
				{
					id: "rule-1",
					name: "Old unwatched",
					enabled: true,
					context: "library-cleanup",
					document: {
						version: 1,
						root: {
							all: [
								{ kind: "age", params: { operator: "older_than", days: 90 } },
								{ kind: "plex_watch_count", params: { operator: "less_than", count: 1 } },
							],
						},
					},
					unavailableKinds: [],
					unparseable: false,
				},
			],
		};
		configData = {
			id: "cfg",
			enabled: true,
			intervalHours: 24,
			lastRunAt: null,
			nextRunAt: null,
			dryRunMode: false,
			maxRemovalsPerRun: 10,
			requireApproval: true,
			respectQuiSeeding: false,
			rejectionMemoryDays: 0,
			rules: [
				{
					id: "rule-1",
					name: "Old unwatched",
					enabled: true,
					priority: 0,
					targetScope: "series",
					ruleType: "composite",
					parameters: {},
					serviceFilter: ["sonarr"],
					instanceFilter: null,
					excludeTags: null,
					excludeTitles: ["Keep me"],
					plexLibraryFilter: null,
					action: "unmonitor",
					operator: "AND",
					conditions: [
						{ ruleType: "age", parameters: { operator: "older_than", days: 90 } },
						{ ruleType: "plex_watch_count", parameters: { operator: "less_than", count: 1 } },
					],
					retentionMode: true,
					useGlobalRejectionMemory: true,
					rejectionMemoryDays: null,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			],
		};
	});

	it("prefills name + action + both composite conditions from the joined sources", async () => {
		wrapper(<CleanupRuleComposerDialog open onOpenChange={() => {}} editRuleId="rule-1" />);

		expect(await screen.findByDisplayValue("Old unwatched")).toBeTruthy();
		// Two condition rows rendered (composite prefill).
		expect(screen.getByText(/condition 1/i)).toBeTruthy();
		expect(screen.getByText(/condition 2/i)).toBeTruthy();
	});

	it("saves a PARTIAL update — composer-owned fields only, advanced filters omitted (preserved)", async () => {
		wrapper(<CleanupRuleComposerDialog open onOpenChange={() => {}} editRuleId="rule-1" />);
		await screen.findByDisplayValue("Old unwatched");

		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
		const arg = updateMutate.mock.calls[0]?.[0];
		expect(arg.id).toBe("rule-1");
		expect(arg.data).toEqual({
			name: "Old unwatched",
			enabled: true,
			action: "unmonitor",
			retentionMode: true,
			targetScope: "series",
			// Defaulted fields the composer doesn't edit are ECHOED from the loaded
			// rule — base.partial() re-injects their defaults, so omitting them would
			// clobber the stored values (priority reset to 0, useGlobalRejectionMemory
			// to true). Echoing preserves them.
			priority: 0,
			useGlobalRejectionMemory: true,
			ruleType: "composite",
			parameters: {},
			operator: "AND",
			conditions: [
				{ ruleType: "age", parameters: { operator: "older_than", days: 90 } },
				{ ruleType: "plex_watch_count", parameters: { operator: "less_than", count: 1 } },
			],
		});
		// Fields WITHOUT a schema default are omitted → the route's !== undefined
		// discipline preserves them (no clobber risk).
		expect(arg.data).not.toHaveProperty("serviceFilter");
		expect(arg.data).not.toHaveProperty("excludeTitles");
		expect(arg.data).not.toHaveProperty("rejectionMemoryDays");
	});

	it("shows a loading state and blocks save until the config join resolves (no default-clobber)", async () => {
		// automation summary present, but config not yet loaded → editDataReady false.
		configData = undefined;
		wrapper(<CleanupRuleComposerDialog open onOpenChange={() => {}} editRuleId="rule-1" />);
		expect(await screen.findByText(/loading rule/i)).toBeTruthy();
		// The form (and its Save button) isn't rendered yet, so no default-seeded
		// payload can be submitted.
		expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
		expect(updateMutate).not.toHaveBeenCalled();
	});
});
