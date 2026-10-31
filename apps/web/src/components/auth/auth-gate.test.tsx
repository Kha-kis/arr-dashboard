import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../lib/api-client/base";
import { authKeys } from "../../lib/query-keys";
import { AuthGate } from "./auth-gate";

const routerPush = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: routerPush }));
const navigationState = vi.hoisted(() => ({ pathname: "/library" }));
vi.mock("next/navigation", () => ({
	usePathname: () => navigationState.pathname,
	useRouter: () => router,
}));

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

describe("AuthGate protected request recovery", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		routerPush.mockReset();
		navigationState.pathname = "/library";
	});

	it("hides protected content during one auth recheck and redirects only on confirmed sign-out", async () => {
		let authReads = 0;
		let finishRecheck: ((response: Response) => void) | undefined;
		const recheck = new Promise<Response>((resolve) => {
			finishRecheck = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string) => {
				if (input === "/auth/setup-required") return Promise.resolve(json({ required: false }));
				if (input === "/auth/me") {
					authReads++;
					return authReads === 1
						? Promise.resolve(json({ user: { id: "synthetic-user", username: "synthetic" } }))
						: recheck;
				}
				return Promise.resolve(new Response(null, { status: 401 }));
			}),
		);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<span>Protected content</span>
					<button type="button" onClick={() => void apiRequest("/api/services").catch(() => {})}>
						Protected read
					</button>
				</AuthGate>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(client.getQueryData(authKeys.currentUser)).toEqual({
				id: "synthetic-user",
				username: "synthetic",
			}),
		);
		expect(authReads).toBe(1);
		fireEvent.click(screen.getByRole("button", { name: "Protected read" }));
		await waitFor(() => expect(authReads).toBe(2));
		expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
		expect(routerPush).not.toHaveBeenCalled();
		finishRecheck?.(new Response(null, { status: 401 }));
		await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/login?redirectTo=%2Flibrary"));
		expect(authReads).toBe(2);
		client.clear();
	});

	it.each([
		{
			name: "a still-valid session",
			recheck: () =>
				Promise.resolve(json({ user: { id: "synthetic-user", username: "synthetic" } })),
		},
		{
			name: "an unavailable auth endpoint",
			recheck: () => Promise.reject(new Error("synthetic network failure")),
		},
	])("shows a retryable error without redirect for $name", async ({ name, recheck }) => {
		let authReads = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string) => {
				if (input === "/auth/setup-required") return Promise.resolve(json({ required: false }));
				if (input === "/auth/me") {
					authReads++;
					return authReads === 1
						? Promise.resolve(json({ user: { id: "synthetic-user", username: "synthetic" } }))
						: recheck();
				}
				return Promise.resolve(new Response(null, { status: 401 }));
			}),
		);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<span>Protected content</span>
					<button type="button" onClick={() => void apiRequest("/api/services").catch(() => {})}>
						Protected read
					</button>
				</AuthGate>
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(client.getQueryData(authKeys.currentUser)).toEqual({
				id: "synthetic-user",
				username: "synthetic",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Protected read" }));
		await screen.findByRole("alert");
		expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
		expect(routerPush).not.toHaveBeenCalled();
		expect(authReads).toBe(2);
		if (name === "an unavailable auth endpoint") {
			navigationState.pathname = "/dashboard";
			view.rerender(
				<QueryClientProvider client={client}>
					<AuthGate>
						<span>Protected content</span>
						<button type="button" onClick={() => void apiRequest("/api/services").catch(() => {})}>
							Protected read
						</button>
					</AuthGate>
				</QueryClientProvider>,
			);
			expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
			expect(screen.getByRole("alert")).toBeInTheDocument();
		}
		fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
		expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
		await waitFor(() => expect(authReads).toBe(3));
		if (name === "a still-valid session") {
			await waitFor(() => expect(screen.getByText("Protected content")).toBeInTheDocument());
		} else {
			await screen.findByRole("alert");
			expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
		}
		client.clear();
	});

	it("restarts a pending retry after protected-route navigation instead of staying blank", async () => {
		let authReads = 0;
		let finishOldRetry: ((response: Response) => void) | undefined;
		const oldRetry = new Promise<Response>((resolve) => {
			finishOldRetry = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string) => {
				if (input === "/auth/setup-required") return Promise.resolve(json({ required: false }));
				if (input === "/auth/me") {
					authReads++;
					if (authReads === 1 || authReads === 4)
						return Promise.resolve(json({ user: { id: "synthetic-user", username: "synthetic" } }));
					if (authReads === 2) return Promise.reject(new Error("synthetic network failure"));
					return oldRetry;
				}
				return Promise.resolve(new Response(null, { status: 401 }));
			}),
		);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const content = () => (
			<QueryClientProvider client={client}>
				<AuthGate>
					<span>Protected content</span>
					<button type="button" onClick={() => void apiRequest("/api/services").catch(() => {})}>
						Protected read
					</button>
				</AuthGate>
			</QueryClientProvider>
		);
		const view = render(content());
		await waitFor(() => expect(client.getQueryData(authKeys.currentUser)).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Protected read" }));
		await screen.findByRole("alert");
		fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
		await waitFor(() => expect(authReads).toBe(3));
		expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
		navigationState.pathname = "/dashboard";
		view.rerender(content());
		expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
		await waitFor(() => expect(authReads).toBe(4));
		await screen.findByText("Protected content");
		await act(async () => {
			finishOldRetry?.(new Response(null, { status: 401 }));
			await oldRetry;
		});
		expect(routerPush).not.toHaveBeenCalled();
		client.clear();
	});
});
