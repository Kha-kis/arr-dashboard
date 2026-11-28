import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "@/contexts/IncognitoContext";
import { ColorThemeProvider } from "@/providers/color-theme-provider";
import { authKeys } from "@/lib/query-keys";
import SetupPage from "../page";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const clients: QueryClient[] = [];
const requests: string[] = [];
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
	requests.length = 0;
	router.push.mockClear();
	router.replace.mockClear();
});
afterEach(() => {
	for (const client of clients.splice(0)) client.clear();
});

function transport(read: () => Response | Promise<Response>) {
	vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
		const url = new URL(input, "https://synthetic.invalid");
		const request = `${init.method ?? "GET"} ${url.pathname}`;
		requests.push(request);
		if (url.origin !== "https://synthetic.invalid" || request !== "GET /auth/setup-required") {
			throw new Error("Unexpected setup transport operation");
		}
		return read();
	});
}
function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 20, gcTime: 0 } } });
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<SetupPage />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}
function blocked() {
	expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i);
	expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	expect(document.querySelector("form")).toBeNull();
	expect(screen.queryByRole("button", { name: "Password" })).not.toBeInTheDocument();
	expect(router.replace).not.toHaveBeenCalled();
	expect(requests.every((request) => request === "GET /auth/setup-required")).toBe(true);
}

describe("setup eligibility read recovery", () => {
	// Break: failed eligibility mounts enrollment and repeatedly remounts its observer.
	it("settles an unavailable read without enrollment or automatic remount retry rounds", async () => {
		transport(() => json({ message: "Synthetic unavailable" }, 503));
		const { client } = mount();
		await waitFor(() => expect(client.getQueryState(authKeys.setupRequired)?.status).toBe("error"));
		await screen.findByRole("alert");
		blocked();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 80));
		});
		expect(requests).toHaveLength(2);
		expect(
			client.getQueryCache().find({ queryKey: authKeys.setupRequired })?.getObserversCount(),
		).toBe(1);
	});
	// Break: absent, null or nonboolean eligibility grants enrollment or redirects.
	it.each([null, {}, { required: "true", passwordPolicy: "strict" }, { required: 1 }])(
		"blocks malformed eligibility %j",
		async (body) => {
			transport(() => json(body));
			mount();
			await screen.findByRole("alert");
			blocked();
		},
	);
	// Break: Retry cannot restore confirmed eligibility or loses the returned policy.
	it("recovers through Retry and propagates the relaxed password policy", async () => {
		let unavailable = true;
		transport(() =>
			unavailable ? json({}, 503) : json({ required: true, passwordPolicy: "relaxed" }),
		);
		mount();
		await screen.findByRole("alert");
		blocked();
		unavailable = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		fireEvent.click(await screen.findByRole("button", { name: "Password" }));
		expect(screen.getByPlaceholderText("Re-enter password")).toBeInTheDocument();
		expect(screen.getByText("At least 8 characters")).toBeInTheDocument();
		expect(screen.queryByText(/One uppercase letter/)).not.toBeInTheDocument();
		expect(requests).toHaveLength(3);
	});
	// Break: last-known required:true continues granting enrollment after a failed refresh.
	it("blocks stale enrollment authority on background failure and recovers", async () => {
		let unavailable = false;
		transport(() =>
			unavailable ? json({}, 503) : json({ required: true, passwordPolicy: "strict" }),
		);
		const { client } = mount();
		await screen.findByRole("button", { name: "Password" });
		unavailable = true;
		await act(async () => {
			await client.refetchQueries({ queryKey: authKeys.setupRequired });
		});
		await screen.findByRole("alert");
		blocked();
		expect(client.getQueryData(authKeys.setupRequired)).toMatchObject({ required: true });
		unavailable = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByRole("button", { name: "Password" })).toBeInTheDocument();
	});
	// Break: completed setup no longer redirects after an available read.
	it("redirects only confirmed completed setup to login", async () => {
		transport(() => json({ required: false, passwordPolicy: "strict" }));
		mount();
		await waitFor(() => expect(router.replace).toHaveBeenCalledExactlyOnceWith("/login"));
		expect(document.querySelector("form")).toBeNull();
		expect(requests).toHaveLength(1);
	});
});
