import type { AutoTagRule } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as api from "../../../../lib/api-client/auto-tag";
import { autoTagKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { AutoTagClient } from "../auto-tag-client";

// Unrelated webhook queries are excluded; rules, hooks, cache and table stay real.
vi.mock("../webhook-config-panel", () => ({ WebhookConfigPanel: () => null }));
const rule: AutoTagRule = {
	id: "rule-1",
	userId: "user-1",
	name: "Example rule",
	enabled: true,
	ruleType: "media_server_presence",
	parameters: { instanceId: "plex-1" },
	operator: null,
	conditions: null,
	serviceFilter: null,
	instanceFilter: null,
	excludeTags: null,
	excludeTitles: null,
	plexLibraryFilter: null,
	tagName: "present",
	lastRunAt: null,
	lastRunStatus: null,
	lastRunMessage: null,
	createdAt: "2026-09-14T00:00:00.000Z",
	updatedAt: "2026-09-14T00:00:00.000Z",
};
let client: QueryClient;
beforeEach(() => {
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.spyOn(api, "fetchAutoTagRules").mockResolvedValue([rule]);
	vi.spyOn(api, "runAutoTagRule");
	vi.spyOn(api, "deleteAutoTagRule");
	vi.spyOn(api, "createAutoTagRule");
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
});
function mount() {
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<QueryClientProvider client={client}>
					<AutoTagClient />
				</QueryClientProvider>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}
function noWrites() {
	expect(api.runAutoTagRule).not.toHaveBeenCalled();
	expect(api.deleteAutoTagRule).not.toHaveBeenCalled();
	expect(api.createAutoTagRule).not.toHaveBeenCalled();
}
describe("AutoTag rules read evidence", () => {
	it("reports a cold rules failure without suggesting a first rule, then retries the GET", async () => {
		vi.mocked(api.fetchAutoTagRules).mockRejectedValueOnce(new Error("unavailable"));
		mount();
		await screen.findByRole("alert");
		expect(screen.queryByText("No auto-tag rules yet")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Create your first rule" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		await screen.findByText(rule.name);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(api.fetchAutoTagRules).toHaveBeenCalledTimes(2);
		noWrites();
	});
	it("waits for a successful read before showing the first-rule empty state", async () => {
		let resolve!: (rules: AutoTagRule[]) => void;
		vi.mocked(api.fetchAutoTagRules).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		expect(screen.getByText(/Loading rules/)).toBeInTheDocument();
		expect(screen.queryByText("No auto-tag rules yet")).not.toBeInTheDocument();
		await act(async () => resolve([]));
		await screen.findByText("No auto-tag rules yet");
		noWrites();
	});
	it.each([false, true])(
		"keeps retained rules qualified after a failed refresh (empty=%s)",
		async (empty) => {
			vi.mocked(api.fetchAutoTagRules).mockResolvedValue(empty ? [] : [rule]);
			mount();
			await screen.findByText(empty ? "No auto-tag rules yet" : rule.name);
			vi.mocked(api.fetchAutoTagRules).mockRejectedValueOnce(new Error("refresh unavailable"));
			await act(async () => {
				await client.refetchQueries({ queryKey: autoTagKeys.rules });
			});
			expect(await screen.findByRole("alert")).toHaveTextContent(/last-known/i);
			if (empty) expect(screen.queryByText("No auto-tag rules yet")).not.toBeInTheDocument();
			else expect(screen.getByText(rule.name)).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /retry/i }));
			await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
			expect(api.fetchAutoTagRules).toHaveBeenCalledTimes(3);
			noWrites();
		},
	);
});
