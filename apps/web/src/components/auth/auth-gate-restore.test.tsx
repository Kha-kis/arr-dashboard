import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../contexts/IncognitoContext";
import { clearRestoreHandoff, useRestoreBackup } from "../../hooks/api/useBackup";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../lib/auth-session-signal";
import { authKeys } from "../../lib/query-keys";
import { ColorThemeProvider } from "../../providers/color-theme-provider";
import { AuthGate } from "./auth-gate";

const navigation = vi.hoisted(() => ({ pathname: "/settings", push: vi.fn() }));
vi.mock("next/navigation", () => ({
	usePathname: () => navigation.pathname,
	useRouter: () => ({ push: navigation.push }),
}));
const restoreId = "767478b4-9726-485c-bc91-c379fb118d12";
const clients: QueryClient[] = [];
const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function RestoreTrigger() {
	const restore = useRestoreBackup();
	return (
		<button
			type="button"
			disabled={restore.isPending}
			onClick={() =>
				void restore
					.mutateAsync({ kind: "stored", request: { id: "a".repeat(24) } })
					.catch(() => {})
			}
		>
			Publish fixture
		</button>
	);
}

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	client.setQueryData(authKeys.setupRequired, { required: false });
	client.setQueryData(authKeys.currentUser, { id: "synthetic-old-user", username: "synthetic" });
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<RestoreTrigger />
					<AuthGate>
						<span>Protected old-account content</span>
					</AuthGate>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	clearRestoreHandoff();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	vi.unstubAllGlobals();
	navigation.pathname = "/settings";
	navigation.push.mockReset();
});

describe("Restore recovery outside the actual auth quarantine", () => {
	it.each([
		{ outcome: "committed", status: 200, reason: null, message: /Restore committed/ },
		{ outcome: "not-committed", status: 409, reason: "state-changed", message: /not committed/ },
		{
			outcome: "unavailable",
			status: 503,
			reason: "commit-unknown",
			message: /outcome is unavailable/,
		},
		{ outcome: "unconfirmed", status: 0, reason: null, message: /could not be confirmed/ },
	])(
		"retains focused $outcome recovery without exposing old account data or replaying",
		async (test) => {
			let posts = 0;
			let published = false;
			vi.stubGlobal("fetch", async (url: string) => {
				if (url === "/api/backup/restore-from-file") {
					posts++;
					published = true;
					if (!test.status) throw new Error("synthetic response loss");
					return response(
						{
							restoreId,
							outcome: test.outcome,
							success: test.outcome === "committed",
							reason: test.reason,
							restartRequired: true,
							restart: "manual-required",
						},
						test.status,
					);
				}
				if (url === "/auth/setup-required")
					return published
						? response({ error: "unavailable" }, 503)
						: response({ required: false });
				return response({ error: "unavailable" }, 503);
			});
			mount();
			fireEvent.click(screen.getByRole("button", { name: "Publish fixture" }));
			const notice = await screen.findByRole("region", { name: "Restore recovery" });
			expect(screen.getByText(test.message)).toBeInTheDocument();
			expect(screen.queryByText("Protected old-account content")).not.toBeInTheDocument();
			await waitFor(() => expect(notice).toHaveFocus());
			expect(posts).toBe(1);
			expect(screen.queryByRole("button", { name: "Restore backup" })).not.toBeInTheDocument();
		},
	);

	it("keeps protected content available after a verified preflight rejection", async () => {
		vi.stubGlobal("fetch", async (url: string) =>
			url === "/auth/setup-required"
				? response({ required: false })
				: response({ error: "Restore request rejected", category: "invalid-backup" }, 400),
		);
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Publish fixture" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Publish fixture" })).toBeEnabled(),
		);
		await waitFor(() =>
			expect(screen.getByText("Protected old-account content")).toBeInTheDocument(),
		);
		expect(screen.queryByRole("region", { name: "Restore recovery" })).not.toBeInTheDocument();
		expect(getPendingUnauthorizedRevision()).toBe(0);
	});

	it("requires a successful explicit protected status read before dismissal and never replays", async () => {
		let posts = 0;
		let statusReads = 0;
		vi.stubGlobal("fetch", async (url: string) => {
			if (url === "/api/backup/restore-from-file") {
				posts++;
				throw new Error("synthetic response loss");
			}
			if (url === "/api/backup/restore/status") {
				statusReads++;
				return statusReads === 1
					? response({ error: "unavailable" }, 503)
					: response({ latestCommitted: null });
			}
			return url === "/auth/setup-required"
				? response({ required: false })
				: response({ error: "unavailable" }, 503);
		});
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Publish fixture" }));
		await screen.findByRole("region", { name: "Restore recovery" });
		expect(statusReads).toBe(0);
		expect(screen.queryByRole("button", { name: "Clear recovery notice" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
		await screen.findByText(/Recovered status could not be verified/);
		expect(screen.queryByRole("button", { name: "Clear recovery notice" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
		await screen.findByText(/does not establish rollback/);
		expect(screen.getByRole("button", { name: "Clear recovery notice" })).toBeEnabled();
		expect(statusReads).toBe(2);
		expect(posts).toBe(1);
	});
});
