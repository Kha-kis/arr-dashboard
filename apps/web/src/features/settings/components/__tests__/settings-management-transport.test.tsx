import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SettingsClient } from "../settings-client";

type Call = { method: string; path: string; body: unknown };
const initialTags = [
	{ id: "tag-a", name: "Environment A", createdAt: "2026-01-01T00:00:00.000Z" },
	{ id: "tag-b", name: "Environment B", createdAt: "2026-01-01T00:00:00.000Z" },
];

let client: QueryClient;
let calls: Call[];
let tags: typeof initialTags;
let readFails: boolean;
let createFails: boolean;
let deleteFails: boolean;
let releaseCreate: (() => void) | undefined;
let holdCreate: Promise<void> | undefined;
let releaseRead: (() => void) | undefined;
let holdRead: Promise<void> | undefined;
let inFlight: Set<Promise<Response>>;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mount() {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<SettingsClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

async function settled() {
	await waitFor(() => {
		expect(client.isFetching()).toBe(0);
		expect(client.isMutating()).toBe(0);
	});
}

beforeEach(() => {
	window.history.replaceState(null, "", "/settings#tags");
	localStorage.clear();
	calls = [];
	tags = initialTags.map((tag) => ({ ...tag }));
	readFails = false;
	createFails = false;
	deleteFails = false;
	releaseCreate = undefined;
	holdCreate = undefined;
	releaseRead = undefined;
	holdRead = undefined;
	inFlight = new Set();
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		calls.push({ path, method, body });
		const work = (async () => {
			if (path === "/api/services" && method === "GET") return json({ services: [] });
			if (path === "/auth/me" && method === "GET") {
				return json({
					user: {
						id: "owner-a",
						username: "Synthetic administrator",
						mustChangePassword: false,
						hasPassword: true,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				});
			}
			if (path === "/api/tags" && method === "GET") {
				await holdRead;
				return readFails ? json({ error: "Tags temporarily unavailable" }, 503) : json({ tags });
			}
			if (path === "/api/tags" && method === "POST") {
				await holdCreate;
				if (createFails) return json({ error: "Tag already exists" }, 409);
				const tag = {
					id: "tag-c",
					name: body.name,
					createdAt: "2026-01-01T00:00:00.000Z",
				};
				tags = [...tags, tag];
				return json({ tag }, 201);
			}
			if (path === "/api/tags/tag-b" && method === "DELETE") {
				if (deleteFails) return json({ error: "Tag removal unavailable" }, 503);
				tags = tags.filter((tag) => tag.id !== "tag-b");
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected controlled transport: ${method} ${path}`);
		})();
		inFlight.add(work);
		void work.finally(() => inFlight.delete(work));
		return work;
	});
});

afterEach(async () => {
	releaseCreate?.();
	releaseRead?.();
	await act(async () => {
		await Promise.allSettled([...inFlight]);
	});
	if (client) {
		await settled();
		await client.cancelQueries();
	}
	cleanup();
	client?.clear();
	vi.unstubAllGlobals();
});

describe("maintained Settings Tags transport and recovery", () => {
	it("creates a trimmed tag with held pending controls, then removes only the confirmed current ID", async () => {
		mount();
		await screen.findByText("Environment A");
		await settled();
		holdCreate = new Promise((resolve) => {
			releaseCreate = resolve;
		});
		fireEvent.change(screen.getByPlaceholderText("e.g., Production, Home, Testing"), {
			target: { value: "  Environment C  " },
		});
		fireEvent.click(screen.getByRole("button", { name: /add tag/i }));
		await screen.findByRole("button", { name: /creating/i });
		expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: /creating/i }));
		expect(calls.filter((call) => call.method === "POST")).toEqual([
			{ method: "POST", path: "/api/tags", body: { name: "Environment C" } },
		]);
		await act(async () => releaseCreate?.());
		await screen.findByText("Environment C");
		expect(screen.getByPlaceholderText("e.g., Production, Home, Testing")).toHaveValue("");
		fireEvent.click(screen.getByRole("button", { name: "Remove Environment B" }));
		expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Confirm remove Environment B" }));
		await waitFor(() => expect(screen.queryByText("Environment B")).not.toBeInTheDocument());
		expect(screen.getByText("Environment A")).toBeInTheDocument();
		expect(screen.getByText("Environment C")).toBeInTheDocument();
		expect(calls.filter((call) => call.method === "DELETE")).toEqual([
			{ method: "DELETE", path: "/api/tags/tag-b", body: null },
		]);
	});

	it("discloses a refused create, retains its draft, and allows a later explicit retry", async () => {
		createFails = true;
		mount();
		await screen.findByText("Environment A");
		fireEvent.change(screen.getByPlaceholderText("e.g., Production, Home, Testing"), {
			target: { value: "Environment C" },
		});
		fireEvent.click(screen.getByRole("button", { name: /add tag/i }));
		await settled();
		expect(screen.getByPlaceholderText("e.g., Production, Home, Testing")).toHaveValue(
			"Environment C",
		);
		expect.soft(screen.queryByRole("alert")).toBeInTheDocument();
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
		createFails = false;
		fireEvent.click(screen.getByRole("button", { name: /add tag/i }));
		await screen.findByText("Environment C");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
	});

	it("discloses refused deletion without hiding the tag and retries only after confirmation", async () => {
		deleteFails = true;
		mount();
		await screen.findByText("Environment B");
		fireEvent.click(screen.getByRole("button", { name: "Remove Environment B" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm remove Environment B" }));
		await settled();
		expect(screen.getByText("Environment B")).toBeInTheDocument();
		expect.soft(screen.queryByRole("alert")).toBeInTheDocument();
		expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
		deleteFails = false;
		fireEvent.click(screen.getByRole("button", { name: "Remove Environment B" }));
		expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Confirm remove Environment B" }));
		await waitFor(() => expect(screen.queryByText("Environment B")).not.toBeInTheDocument());
		expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
	});

	it("distinguishes unavailable tags from an empty list and recovers with a read-only retry", async () => {
		readFails = true;
		mount();
		await screen.findByRole("button", { name: /add tag/i });
		await settled();
		expect.soft(screen.queryByText("No tags yet")).not.toBeInTheDocument();
		expect.soft(screen.queryByRole("alert")).toBeInTheDocument();
		const retry = screen.queryByRole("button", { name: /retry/i });
		expect.soft(retry).toBeInTheDocument();
		if (retry) {
			readFails = false;
			fireEvent.click(retry);
			await screen.findByText("Environment A");
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		}
		expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
	});

	it("preserves a newer text draft when an earlier held create succeeds", async () => {
		mount();
		await screen.findByText("Environment A");
		holdCreate = new Promise((resolve) => {
			releaseCreate = resolve;
		});
		const input = screen.getByPlaceholderText("e.g., Production, Home, Testing");
		fireEvent.change(input, { target: { value: "Environment C" } });
		fireEvent.click(screen.getByRole("button", { name: /add tag/i }));
		await screen.findByRole("button", { name: /creating/i });
		fireEvent.change(input, { target: { value: "Next draft" } });
		await act(async () => releaseCreate?.());
		await screen.findByText("Environment C");
		expect(input).toHaveValue("Next draft");
		expect(calls.filter((call) => call.method === "POST")).toEqual([
			{ path: "/api/tags", method: "POST", body: { name: "Environment C" } },
		]);
	});

	it("keeps cached tags with stale disclosure and holds a GET-only retry until recovery", async () => {
		mount();
		await screen.findByText("Environment A");
		await settled();
		readFails = true;
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["service-tags"] });
		});
		expect(screen.getByText("Environment A")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/last.known|stale/i));
		const retry = screen.queryByRole("button", { name: /retry/i });
		expect.soft(retry).toBeInTheDocument();
		if (retry) {
			readFails = false;
			holdRead = new Promise((resolve) => {
				releaseRead = resolve;
			});
			const prior = calls.filter((call) => call.path === "/api/tags").length;
			fireEvent.click(retry);
			await waitFor(() => expect(retry).toBeDisabled());
			fireEvent.click(retry);
			expect(calls.filter((call) => call.path === "/api/tags")).toHaveLength(prior + 1);
			await act(async () => releaseRead?.());
			await settled();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(screen.getByText("Environment B")).toBeInTheDocument();
		}
		expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
	});
});
