import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { AppearanceTab } from "../appearance-tab";

type Request = { url: string; method: string; body: unknown };
const _json = (body: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
let requests: Request[];
let alerts: string[];
let clients: QueryClient[];
let gates: Array<{ promise: Promise<void>; release: () => void }>;
let active: Set<Promise<Response>>;
let respond: (request: Request) => Promise<Response>;
const receipts: unknown[] = [];
const writes = () => requests.filter((request) => request.method !== "GET");
beforeEach(() => {
	localStorage.clear();
	requests = [];
	alerts = [];
	clients = [];
	gates = [];
	active = new Set();
	respond = async (request) => {
		throw new Error(`Unexpected synthetic request ${request.method} ${request.url}`);
	};
	vi.stubGlobal(
		"alert",
		vi.fn((message: unknown) => {
			alerts.push(String(message));
		}),
	);
	vi.stubGlobal(
		"confirm",
		vi.fn(() => false),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, options?: RequestInit) => {
			const request = {
				url,
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(String(options.body)) : null,
			};
			requests.push(request);
			const task = respond(request);
			active.add(task);
			void task.then(
				() => active.delete(task),
				() => active.delete(task),
			);
			return task;
		}),
	);
});
async function settled() {
	await waitFor(() =>
		expect(
			clients
				.flatMap((client) => client.getMutationCache().getAll())
				.some((mutation) => mutation.state.status === "pending"),
		).toBe(false),
	);
}
afterEach(async () => {
	try {
		gates.forEach((gate) => {
			gate.release();
		});
		await act(async () => {
			await Promise.allSettled([...active]);
		});
		await settled();
		receipts.push({
			test: expect.getState().currentTestName,
			requests,
			alerts,
			heldWorkJoined: active.size === 0,
		});
	} finally {
		toast.dismiss();
		cleanup();
		clients.forEach((client) => {
			client.clear();
		});
		vi.unstubAllGlobals();
	}
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "appearance-requests.json"),
			JSON.stringify(receipts, null, 2),
		);
});
function show(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						{ui}
						<Toaster />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}

beforeEach(() => {
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-oled");
	document.documentElement.className = "";
	vi.stubGlobal(
		"matchMedia",
		vi.fn((media: string) => ({
			matches: false,
			media,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => true,
		})),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-oled");
	document.documentElement.className = "";
});
const appearance = () => (
	<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
		<AppearanceTab />
	</ThemeProvider>
);
const oled = () =>
	within(
		screen
			.getByText("Pure Black Background")
			.closest("div.flex.items-center.justify-between")! as HTMLElement,
	).getByRole("button");
describe("S4 maintained appearance local readback", () => {
	it("changes actual theme/OLED/week controls, persists DOM and storage, then remounts from storage without API", async () => {
		const view = show(appearance());
		await screen.findByRole("button", { name: "Green" });
		fireEvent.click(screen.getByRole("button", { name: "Dark" }));
		await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
		fireEvent.click(screen.getByRole("button", { name: "Green" }));
		await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "green"));
		fireEvent.click(oled());
		fireEvent.click(screen.getByRole("button", { name: "Mon" }));
		await waitFor(() => expect(document.documentElement).toHaveAttribute("data-oled", "true"));
		expect(localStorage.getItem("arr-color-theme")).toBe("green");
		expect(localStorage.getItem("arr-oled-mode")).toBe("true");
		expect(localStorage.getItem("arr-first-day-of-week")).toBe("1");
		expect(localStorage.getItem("theme")).toBe("dark");
		view.unmount();
		document.documentElement.removeAttribute("data-theme");
		document.documentElement.removeAttribute("data-oled");
		document.documentElement.className = "";
		show(appearance());
		await screen.findByRole("button", { name: "Green" });
		expect(document.documentElement).toHaveAttribute("data-theme", "green");
		expect(document.documentElement).toHaveAttribute("data-oled", "true");
		expect(screen.getByRole("button", { name: "Mon" })).toHaveClass("text-foreground");
		expect(requests).toEqual([]);
		expect(writes()).toEqual([]);
	});
	it("falls back safely when storage is unavailable and still updates current controls/DOM without server persistence", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("Synthetic storage denied", "SecurityError");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("Synthetic storage denied", "SecurityError");
		});
		show(appearance());
		await screen.findByRole("button", { name: "Blue" });
		expect(document.documentElement).not.toHaveAttribute("data-theme");
		fireEvent.click(screen.getByRole("button", { name: "Green" }));
		fireEvent.click(screen.getByRole("button", { name: "Mon" }));
		await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "green"));
		expect(screen.getByRole("button", { name: "Mon" })).toHaveClass("text-foreground");
		expect(requests).toEqual([]);
		expect(writes()).toEqual([]);
	});
});
