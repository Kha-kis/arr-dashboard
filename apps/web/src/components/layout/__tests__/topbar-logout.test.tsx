import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import { afterEach, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../contexts/IncognitoContext";
import { authKeys } from "../../../lib/query-keys";
import { ColorThemeProvider } from "../../../providers/color-theme-provider";
import { Dialog } from "../../ui/dialog";
import { TopBar } from "../topbar";

const { clientReplace, navigateToSignedOutPage } = vi.hoisted(() => ({
	clientReplace: vi.fn(),
	navigateToSignedOutPage: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/dashboard",
	useRouter: () => ({ replace: clientReplace }),
}));
vi.mock("../../../lib/auth-navigation", () => ({ navigateToSignedOutPage }));

let client: QueryClient;
afterEach(() => {
	cleanup();
	client?.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

it("retains a refused session and navigates outside the client router only after an acknowledged retry", async () => {
	localStorage.clear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const user = { id: "synthetic-owner", username: "Synthetic owner" };
	client.setQueryData(authKeys.currentUser, user);
	let acknowledge: (response: Response) => void = () => {};
	const pending = new Promise<Response>((resolve) => {
		acknowledge = resolve;
	});
	let requests = 0;
	const fetch = vi.fn(async (path: string, options: RequestInit) => {
		expect(path).toBe("/auth/logout");
		expect(options.method).toBe("POST");
		requests++;
		return requests === 1
			? new Response(JSON.stringify({ error: "Synthetic logout unavailable" }), {
					status: 503,
					headers: { "content-type": "application/json" },
				})
			: pending;
	});
	vi.stubGlobal("fetch", fetch);
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({ matches: true, addListener() {}, removeListener() {} })),
	);
	const expectedFailure = vi.spyOn(console, "error").mockImplementation(() => {});
	navigateToSignedOutPage.mockImplementation(() => {
		expect(client.getQueryData(authKeys.currentUser)).toBeNull();
	});
	render(
		<QueryClientProvider client={client}>
			<ThemeProvider forcedTheme="dark">
				<ColorThemeProvider>
					<IncognitoProvider>
						<Dialog>
							<TopBar />
						</Dialog>
					</IncognitoProvider>
				</ColorThemeProvider>
			</ThemeProvider>
		</QueryClientProvider>,
	);

	fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
	await waitFor(() => expect(expectedFailure).toHaveBeenCalledOnce());
	expect(expectedFailure).toHaveBeenCalledWith("Logout failed", expect.any(Error));
	await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled());
	expect(requests).toBe(1);
	expect(client.getQueryData(authKeys.currentUser)).toEqual(user);
	expect(navigateToSignedOutPage).not.toHaveBeenCalled();
	expect(clientReplace).not.toHaveBeenCalled();

	fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Signing out..." })).toBeDisabled(),
	);
	expect(requests).toBe(2);
	expect(navigateToSignedOutPage).not.toHaveBeenCalled();
	await act(async () => acknowledge(new Response(null, { status: 204 })));
	await waitFor(() => expect(navigateToSignedOutPage).toHaveBeenCalledOnce());
	expect(client.getQueryData(authKeys.currentUser)).toBeNull();
	expect(clientReplace).not.toHaveBeenCalled();
	expect(requests).toBe(2);
});
