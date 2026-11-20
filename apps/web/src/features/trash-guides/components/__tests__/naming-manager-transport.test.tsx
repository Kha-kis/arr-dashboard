import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

type Event = { url: string; method: string; body: Record<string, unknown> | null };
let client: QueryClient;
const events: Event[] = [],
	unexpected: string[] = [],
	pending = new Set<Promise<Response>>();
const gates: Array<{
	promise: Promise<Response>;
	release: (response: Response) => void;
	closed: boolean;
}> = [];
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function gate() {
	let resolve!: (response: Response) => void;
	const value = {
		promise: new Promise<Response>((done) => {
			resolve = done;
		}),
		release: (result: Response) => {
			value.closed = true;
			resolve(result);
		},
		closed: false,
	};
	gates.push(value);
	return value;
}
function transport(handler: (event: Event) => Response | Promise<Response> | undefined) {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const event = {
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			events.push(event);
			const task = Promise.resolve().then(() => {
				const result = handler(event);
				if (!result) {
					unexpected.push(JSON.stringify(event));
					throw Error("Unexpected synthetic fetch " + event.url);
				}
				return result;
			});
			pending.add(task);
			void task.then(
				() => pending.delete(task),
				() => pending.delete(task),
			);
			return task;
		}),
	);
}
function mount(children: ReactNode) {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{children}
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
const service = {
	id: "radarr-a",
	service: "radarr",
	label: "Synthetic Radarr",
	baseUrl: "http://synthetic.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: true,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	tags: [],
};
beforeEach(() => {
	events.length = 0;
	unexpected.length = 0;
	gates.length = 0;
	localStorage.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "",
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent() {
				return false;
			},
		})),
	);
});
afterEach(async () => {
	await act(async () => {
		for (const held of gates)
			if (!held.closed) held.release(response({ message: "Synthetic teardown refusal" }, 503));
		await Promise.allSettled([...pending]);
	});
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	toast.dismiss();
	expect(pending.size).toBe(0);
	expect(gates.every((value) => value.closed)).toBe(true);
	expect(unexpected).toEqual([]);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

import { NamingManager } from "../naming-manager";

const selected = { serviceType: "RADARR", filePreset: "Synthetic file", folderPreset: null };
const presets = {
	success: true,
	presets: {
		serviceType: "RADARR",
		filePresets: [{ name: "Synthetic file", formatString: "{Movie Title}" }],
		folderPresets: [{ name: "Unselected folder", formatString: "folder" }],
	},
};
const preview = {
	success: true,
	preview: {
		comparisons: [
			{
				fieldGroup: "Movie file",
				arrApiField: "standardMovieFormat",
				presetName: "Synthetic file",
				currentValue: "old",
				presetValue: "{Movie Title}",
				changed: true,
			},
		],
		changedCount: 1,
		unchangedCount: 0,
	},
};
describe("Naming maintained transport/recovery", () => {
	it("W1 selected preview and held apply refusal retain draft, explicit retry reads current config", async () => {
		const held = gate();
		let attempts = 0,
			saves = 0,
			config: unknown = null;
		transport((event) => {
			if (event.url === "/api/services") return response({ services: [service] });
			if (event.url === "/api/trash-guides/naming/presets?serviceType=RADARR")
				return response(presets);
			if (event.url === "/api/trash-guides/naming/configs?instanceId=radarr-a")
				return response({ success: true, config });
			if (event.url.endsWith("/naming/preview")) return response(preview);
			if (event.url.endsWith("/naming/apply")) {
				attempts++;
				return attempts === 1
					? held.promise
					: response({
							success: true,
							fieldCount: 1,
							historyId: "history-a",
							message: "Selected naming applied",
						});
			}
			if (event.url.endsWith("/naming/configs") && event.method === "POST") {
				saves++;
				config = { instanceId: "radarr-a", selectedPresets: selected, syncStrategy: "manual" };
				return response({ success: true, config });
			}
		});
		mount(<NamingManager />);
		const instance = await screen.findByRole("button", { name: /Synthetic Radarr/ });
		fireEvent.click(instance);
		fireEvent.click(await screen.findByRole("button", { name: "Synthetic file" }));
		fireEvent.click(screen.getByRole("button", { name: "Preview Changes (1 field)" }));
		await screen.findByText("old");
		expect(events.filter((event) => event.url.endsWith("/naming/preview"))).toEqual([
			{
				url: "/api/trash-guides/naming/preview",
				method: "POST",
				body: { instanceId: "radarr-a", selectedPresets: selected },
			},
		]);
		expect(attempts).toBe(0);
		expect(saves).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: "Apply to Synthetic Radarr" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm Apply" }));
		await waitFor(() => expect(attempts).toBe(1));
		expect(instance).toBeDisabled();
		expect(saves).toBe(0);
		await act(async () => held.release(response({ message: "Naming refused" }, 502)));
		await screen.findByText("Apply failed: Naming refused");
		expect(screen.getByRole("button", { name: "Synthetic file" })).toHaveTextContent(
			"Synthetic file",
		);
		fireEvent.click(screen.getByRole("button", { name: "Apply to Synthetic Radarr" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm Apply" }));
		await screen.findByText("Selected naming applied");
		await waitFor(() => expect(saves).toBe(1));
		expect(
			events.filter((event) => event.url.endsWith("/naming/apply")).map((event) => event.body),
		).toEqual([
			{ instanceId: "radarr-a", selectedPresets: selected },
			{ instanceId: "radarr-a", selectedPresets: selected },
		]);
		await waitFor(() =>
			expect(
				events.filter((event) => event.url.includes("/naming/configs?")).length,
			).toBeGreaterThan(1),
		);
	});
	it("W2 current history rollback cancel, held refusal and deliberate retry keep exact selected history", async () => {
		let rolledBack = false,
			attempts = 0;
		const held = gate();
		transport((event) => {
			if (event.url === "/api/services") return response({ services: [service] });
			if (event.url.includes("/naming/presets?")) return response(presets);
			if (event.url.includes("/naming/configs?")) return response({ success: true, config: null });
			if (event.url.includes("/naming/history?"))
				return response({
					success: true,
					data: {
						history: [
							{
								id: "history-selected",
								status: "SUCCESS",
								deployedAt: "2026-01-01T00:00:00Z",
								changedFields: 1,
								totalFields: 2,
								rolledBack,
							},
						],
						pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
					},
				});
			if (event.url.endsWith("/naming/rollback")) {
				attempts++;
				if (attempts === 1) return held.promise;
				rolledBack = true;
				return response({ success: true, fieldCount: 2, message: "Rolled back" });
			}
		});
		mount(<NamingManager />);
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic Radarr/ }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "History" }));
			// Join the real lazy history import before the query's interaction budget starts.
			await vi.dynamicImportSettled();
		});
		fireEvent.click(await screen.findByRole("button", { name: "Rollback" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(attempts).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm Rollback" }));
		await screen.findByText("Rolling back...");
		await act(async () => held.release(response({ message: "Rollback refused" }, 502)));
		await screen.findByText(/Rollback refused/);
		expect(rolledBack).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Confirm Rollback" }));
		await screen.findByText("Rolled back");
		expect(
			events.filter((event) => event.url.endsWith("/naming/rollback")).map((event) => event.body),
		).toEqual([{ historyId: "history-selected" }, { historyId: "history-selected" }]);
	});
});
