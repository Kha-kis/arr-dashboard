/**
 * Rendered tests for the composer's auto-tag create/edit dialog (PR-3c).
 * Mirrors the cleanup dialog tests, adapted for auto-tag: the action half is a
 * required `tagName`, update is PATCH `{id, payload}`, and — unlike cleanup —
 * there are NO defaulted fields to echo (auto-tag's update schema has none), so
 * the edit payload carries only composer-owned fields.
 */

import type { AutomationRulesResponse } from "@arr/shared";
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
let autoTagRules: Array<Record<string, unknown>> = [];

vi.mock("@/hooks/api/useAutoTag", () => ({
	useAutoTagRules: () => ({ data: autoTagRules }),
	useCreateAutoTagRule: () => ({ mutateAsync: createMutate, isPending: false }),
	useUpdateAutoTagRule: () => ({ mutateAsync: updateMutate, isPending: false }),
}));

vi.mock("@/hooks/api/useLibraryCleanup", () => ({
	useCleanupFieldOptions: () => ({ data: { hasPlex: false }, isLoading: false }),
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
import { AutoTagRuleComposerDialog } from "../auto-tag-rule-composer-dialog";

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
	autoTagRules = [];
});

describe("AutoTagRuleComposerDialog — create", () => {
	it("POSTs name + enabled + tagName + the serialized single-condition quartet", async () => {
		wrapper(<AutoTagRuleComposerDialog open onOpenChange={() => {}} />);

		fireEvent.change(screen.getByPlaceholderText(/tag kids movies/i), {
			target: { value: "Kids content" },
		});
		fireEvent.change(screen.getByPlaceholderText(/^e\.g\., kids$/i), { target: { value: "kids" } });
		fireEvent.click(screen.getByRole("button", { name: /create rule/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
		expect(createMutate).toHaveBeenCalledWith({
			name: "Kids content",
			enabled: true,
			tagName: "kids",
			ruleType: "age",
			parameters: { operator: "older_than", days: 30 },
			operator: null,
			conditions: null,
		});
	});

	it("blocks save on a whitespace-only tag (native `required` passes it, the trim guard catches it)", async () => {
		wrapper(<AutoTagRuleComposerDialog open onOpenChange={() => {}} />);
		fireEvent.change(screen.getByPlaceholderText(/tag kids movies/i), {
			target: { value: "Named but no tag" },
		});
		fireEvent.change(screen.getByPlaceholderText(/^e\.g\., kids$/i), { target: { value: "   " } });
		fireEvent.click(screen.getByRole("button", { name: /create rule/i }));
		await screen.findByText(/enter the tag to apply/i);
		expect(createMutate).not.toHaveBeenCalled();
	});
});

describe("AutoTagRuleComposerDialog — edit", () => {
	beforeEach(() => {
		automationData = {
			rules: [
				{
					id: "at-1",
					name: "Old anime",
					enabled: true,
					context: "auto-tag",
					document: {
						version: 1,
						root: {
							all: [
								{ kind: "age", params: { operator: "older_than", days: 365 } },
								{ kind: "genre", params: { operator: "includes_any", genres: ["Anime"] } },
							],
						},
					},
					unavailableKinds: [],
					unparseable: false,
				},
			],
		};
		autoTagRules = [
			{
				id: "at-1",
				name: "Old anime",
				enabled: true,
				tagName: "archive",
				// Scope filters that must survive an omitting PATCH.
				serviceFilter: ["sonarr"],
				excludeTitles: ["Keep me"],
			},
		];
	});

	it("prefills name + tagName + both composite conditions from the joined sources", async () => {
		wrapper(<AutoTagRuleComposerDialog open onOpenChange={() => {}} editRuleId="at-1" />);
		expect(await screen.findByDisplayValue("Old anime")).toBeTruthy();
		expect(screen.getByDisplayValue("archive")).toBeTruthy();
		expect(screen.getByText(/condition 1/i)).toBeTruthy();
		expect(screen.getByText(/condition 2/i)).toBeTruthy();
	});

	it("PATCHes {id, payload} with composer-owned fields only; scope filters omitted (preserved)", async () => {
		wrapper(<AutoTagRuleComposerDialog open onOpenChange={() => {}} editRuleId="at-1" />);
		await screen.findByDisplayValue("Old anime");

		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
		const arg = updateMutate.mock.calls[0]?.[0];
		expect(arg.id).toBe("at-1");
		expect(arg.payload).toEqual({
			name: "Old anime",
			enabled: true,
			tagName: "archive",
			ruleType: "composite",
			parameters: {},
			operator: "AND",
			conditions: [
				{ ruleType: "age", parameters: { operator: "older_than", days: 365 } },
				{ ruleType: "genre", parameters: { operator: "includes_any", genres: ["Anime"] } },
			],
		});
		// No defaulted fields exist on auto-tag's schema, so none are echoed; scope
		// filters are omitted → the PATCH route's undefined-preserves them.
		expect(arg.payload).not.toHaveProperty("serviceFilter");
		expect(arg.payload).not.toHaveProperty("excludeTitles");
		expect(arg.payload).not.toHaveProperty("priority");
	});

	it("shows a loading state until the auto-tag rule join resolves", async () => {
		autoTagRules = []; // summary present, rule not yet loaded → editDataReady false
		wrapper(<AutoTagRuleComposerDialog open onOpenChange={() => {}} editRuleId="at-1" />);
		expect(await screen.findByText(/loading rule/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
		expect(updateMutate).not.toHaveBeenCalled();
	});
});
