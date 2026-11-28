import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as api from "../../../../lib/api-client/seerr";
import { seerrKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { AuditLogTab } from "../audit-log-tab";

const log: api.SeerrAuditLogEntry = {
	id: "audit-1",
	action: "approve_request",
	targetType: "request",
	targetId: "12",
	detail: { outcome: "unknown" },
	success: false,
	createdAt: "2026-09-28T00:00:00.000Z",
};
let client: QueryClient;
beforeEach(() => {
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.spyOn(api, "fetchSeerrAuditLog").mockResolvedValue([log]);
	// Catch any accidental action replay, rather than replacing the read hook.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function mount() {
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<QueryClientProvider client={client}>
					<AuditLogTab instanceId="seerr-1" />
				</QueryClientProvider>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}
describe("Seerr audit read evidence", () => {
	it("shows a cold audit failure and retries the read without replaying actions", async () => {
		vi.mocked(api.fetchSeerrAuditLog).mockRejectedValueOnce(new Error("unavailable"));
		mount();
		await screen.findByRole("alert");
		expect(screen.queryByText("No Action History")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		await screen.findByText("Unknown");
		expect(screen.getByText("Approve Request")).toBeInTheDocument();
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(api.fetchSeerrAuditLog).toHaveBeenCalledTimes(2);
		expect(api.fetchSeerrAuditLog).toHaveBeenLastCalledWith("seerr-1");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not infer empty history during loading", async () => {
		let resolve!: (logs: api.SeerrAuditLogEntry[]) => void;
		vi.mocked(api.fetchSeerrAuditLog).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		expect(screen.queryByText("No Action History")).not.toBeInTheDocument();
		await act(async () => resolve([]));
		await screen.findByText("No Action History");
	});
	it.each([false, true])(
		"qualifies last-known audit data on refresh failure (empty=%s)",
		async (empty) => {
			vi.mocked(api.fetchSeerrAuditLog).mockResolvedValue(empty ? [] : [log]);
			mount();
			await screen.findByText(empty ? "No Action History" : "Unknown");
			vi.mocked(api.fetchSeerrAuditLog).mockRejectedValueOnce(new Error("refresh unavailable"));
			await act(async () => {
				await client.refetchQueries({ queryKey: seerrKeys.audit("seerr-1") });
			});
			expect(await screen.findByRole("alert")).toHaveTextContent(/last-known/i);
			if (empty) expect(screen.queryByText("No Action History")).not.toBeInTheDocument();
			else expect(screen.getByText("Unknown")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /retry/i }));
			await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
			expect(api.fetchSeerrAuditLog).toHaveBeenCalledTimes(3);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
