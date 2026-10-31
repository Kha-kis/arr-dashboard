import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { CustomFormatsBrowser } from "../custom-formats-browser";

describe("Custom formats maintained selection and recovery", () => {
	const cached = [
		{ trash_id: "cached-a", name: "Selected cached", specifications: [] },
		{ trash_id: "cached-b", name: "Unselected cached", specifications: [] },
	];
	function fixture(
		extra: (event: Event) => Response | Promise<Response> | undefined,
		users: () => unknown[] = () => [],
	) {
		transport((event) => {
			if (event.url === "/api/services") return response({ services: [service] });
			if (event.url.startsWith("/api/trash-guides/cache/custom-formats/list"))
				return response({ radarr: cached, sonarr: [] });
			if (event.url.startsWith("/api/trash-guides/cache/cf-descriptions/list"))
				return response({ radarr: [], sonarr: [] });
			if (event.url === "/api/trash-guides/user-custom-formats" && event.method === "GET")
				return response({ success: true, customFormats: users(), count: users().length });
			return extra(event);
		});
	}
	it("W5 cached selected deployment partial refusal retains selection and deliberate retry excludes unselected CF", async () => {
		const held = gate();
		let attempts = 0;
		fixture((event) =>
			event.url.endsWith("/custom-formats/deploy-multiple")
				? ++attempts === 1
					? held.promise
					: response({ success: true, created: ["Selected cached"], updated: [], failed: [] })
				: undefined,
		);
		mount(<CustomFormatsBrowser />);
		fireEvent.click(
			await screen.findByRole("button", { name: "Select custom format: Selected cached" }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Deploy Selected/ }));
		const dialog = await screen.findByRole("dialog", { name: "Deploy Custom Formats" });
		fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "radarr-a" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Deploy" }));
		await screen.findByRole("button", { name: "Deploying..." });
		await act(async () =>
			held.release(
				response(
					{
						success: false,
						message: "Partial cached deployment refused",
						created: [],
						updated: [],
						failed: [{ name: "Selected cached", error: "Refused" }],
					},
					400,
				),
			),
		);
		await screen.findByText(/Partial cached deployment refused/);
		expect(
			screen.getByRole("button", { name: "Deselect custom format: Selected cached" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByText(/Successfully deployed/)).not.toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Deploy" }));
		await screen.findByText("Successfully deployed 1 custom formats");
		expect(
			events
				.filter((event) => event.url.endsWith("/custom-formats/deploy-multiple"))
				.map((event) => event.body),
		).toEqual([
			{ trashIds: ["cached-a"], instanceId: "radarr-a", serviceType: "RADARR" },
			{ trashIds: ["cached-a"], instanceId: "radarr-a", serviceType: "RADARR" },
		]);
		expect(
			screen.getByRole("button", { name: "Select custom format: Unselected cached" }),
		).toHaveAttribute("aria-pressed", "false");
	});
	it("W6 visible user-CF JSON create/read/deploy refusal recovery/delete, no invented edit control", async () => {
		let users: Array<Record<string, unknown>> = [],
			imports = 0,
			deploys = 0;
		vi.stubGlobal(
			"confirm",
			vi.fn(() => true),
		);
		fixture(
			(event) => {
				if (event.url.endsWith("/user-custom-formats/import-json")) {
					imports++;
					if (imports === 1) return response({ message: "Import refused" }, 503);
					users = [
						{
							id: "user-cf-a",
							name: "Imported owned CF",
							serviceType: "RADARR",
							description: null,
							includeCustomFormatWhenRenaming: false,
							specifications: [],
							defaultScore: 0,
							sourceInstanceId: null,
							sourceCFId: null,
							createdAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
						},
					];
					return response({
						success: true,
						created: ["Imported owned CF"],
						skipped: [],
						failed: [],
					});
				}
				if (event.url.endsWith("/user-custom-formats/deploy")) {
					deploys++;
					return deploys === 1
						? response({ message: "User deploy refused" }, 503)
						: response({ success: true, created: ["Imported owned CF"], updated: [], failed: [] });
				}
				if (event.method === "DELETE" && event.url.endsWith("/user-custom-formats/user-cf-a")) {
					users = [];
					return response({ success: true, message: "Deleted" });
				}
			},
			() => users,
		);
		mount(<CustomFormatsBrowser />);
		fireEvent.click(await screen.findByRole("button", { name: /Create.*Import|Add.*Custom/i }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Paste JSON" }));
		const input = within(dialog).getByRole("textbox");
		const json = '[{"name":"Imported owned CF","specifications":[]}]';
		fireEvent.change(input, { target: { value: json } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Import 1 Format" }));
		await screen.findByText("Import refused");
		expect(input).toHaveValue(json);
		fireEvent.click(within(dialog).getByRole("button", { name: "Import 1 Format" }));
		await screen.findByText("Imported owned CF");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		const checkbox = screen.getByRole("checkbox");
		fireEvent.click(checkbox);
		const select = screen
			.getAllByRole("combobox")
			.find((value) => within(value).queryByRole("option", { name: "Deploy to..." }))!;
		fireEvent.change(select, { target: { value: "radarr-a" } });
		fireEvent.click(screen.getByRole("button", { name: "Deploy (1)" }));
		await screen.findByText("User deploy refused");
		expect(checkbox).toBeChecked();
		fireEvent.click(screen.getByRole("button", { name: "Deploy (1)" }));
		await screen.findByText("Deployed custom formats");
		expect(
			events
				.filter((event) => event.url.endsWith("/user-custom-formats/deploy"))
				.map((event) => event.body),
		).toEqual([
			{ userCFIds: ["user-cf-a"], instanceId: "radarr-a" },
			{ userCFIds: ["user-cf-a"], instanceId: "radarr-a" },
		]);
		fireEvent.click(screen.getByTitle("Delete"));
		await waitFor(() => expect(screen.queryByText("Imported owned CF")).not.toBeInTheDocument());
		expect(events.filter((event) => event.method === "DELETE")).toEqual([
			{ method: "DELETE", url: "/api/trash-guides/user-custom-formats/user-cf-a", body: null },
		]);
	});
	it("W6 manual Add/spec-builder creates the exact draft through the real hook/client, not JSON import", async () => {
		const held = gate();
		let users: Array<Record<string, unknown>> = [];
		fixture(
			(event) => {
				if (event.method === "POST" && event.url === "/api/trash-guides/user-custom-formats")
					return held.promise;
			},
			() => users,
		);
		mount(<CustomFormatsBrowser />);
		fireEvent.click(await screen.findByRole("button", { name: /Create.*Import|Add.*Custom/i }));
		const dialog = await screen.findByRole("dialog"),
			create = within(dialog).getByRole("button", { name: "Create Custom Format" });
		expect(create).toBeDisabled();
		fireEvent.change(within(dialog).getByPlaceholderText("My Custom Format"), {
			target: { value: "  Manual owned CF  " },
		});
		expect(create).toBeDisabled();
		fireEvent.change(
			within(dialog).getByPlaceholderText("Optional description of what this format matches..."),
			{ target: { value: "  Manual specification draft  " } },
		);
		fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "42" } });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: "Include in renaming" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Add Spec" }));
		fireEvent.change(within(dialog).getByPlaceholderText("e.g., Must contain 'REMUX'"), {
			target: { value: "Manual title condition" },
		});
		fireEvent.change(within(dialog).getByPlaceholderText("Value"), {
			target: { value: "synthetic-manual" },
		});
		fireEvent.click(within(dialog).getByRole("checkbox", { name: "Required" }));
		fireEvent.click(create);
		await waitFor(() => expect(events.some((event) => event.method === "POST")).toBe(true));
		expect(create).toBeDisabled();
		const payload = {
			name: "Manual owned CF",
			serviceType: "RADARR",
			description: "Manual specification draft",
			includeCustomFormatWhenRenaming: true,
			defaultScore: 42,
			specifications: [
				{
					name: "Manual title condition",
					implementation: "ReleaseTitleSpecification",
					negate: false,
					required: true,
					fields: { value: "synthetic-manual" },
				},
			],
		};
		expect(events.filter((event) => event.method === "POST")).toEqual([
			{ url: "/api/trash-guides/user-custom-formats", method: "POST", body: payload },
		]);
		users = [
			{
				...payload,
				id: "manual-cf",
				sourceInstanceId: null,
				sourceCFId: null,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		];
		await act(async () => held.release(response({ success: true, customFormat: users[0] }, 201)));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(await screen.findByText("Manual owned CF")).toBeInTheDocument();
		expect(
			events.some(
				(event) => event.url.includes("import-json") || event.url.includes("import-from-instance"),
			),
		).toBe(false);
	});
	it("W6 instance-import selects and commits only the chosen format and reads the resulting owned list", async () => {
		let users: Array<Record<string, unknown>> = [];
		const held = gate();
		fixture(
			(event) => {
				if (
					event.url === "/api/trash-guides/user-custom-formats/instance-cfs/radarr-a" &&
					event.method === "GET"
				)
					return response({
						success: true,
						data: [
							{ id: 11, name: "Selected instance CF" },
							{ id: 12, name: "Unselected instance CF" },
						],
					});
				if (
					event.url === "/api/trash-guides/user-custom-formats/import-from-instance" &&
					event.method === "POST"
				)
					return held.promise;
			},
			() => users,
		);
		mount(<CustomFormatsBrowser />);
		fireEvent.click(await screen.findByRole("button", { name: /Create.*Import|Add.*Custom/i }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "From Instance" }));
		const select = within(dialog).getByRole("combobox");
		await within(select).findByRole("option", { name: /Synthetic Radarr/ });
		fireEvent.change(select, { target: { value: "radarr-a" } });
		fireEvent.click(within(select.parentElement!).getByRole("button"));
		const selected = await within(dialog).findByRole("checkbox", { name: "Selected instance CF" }),
			unselected = within(dialog).getByRole("checkbox", { name: "Unselected instance CF" });
		expect(unselected).not.toBeChecked();
		fireEvent.click(selected);
		fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "37" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Import 1 Format" }));
		await waitFor(() => expect(events.some((event) => event.method === "POST")).toBe(true));
		expect(selected).toBeChecked();
		expect(unselected).not.toBeChecked();
		expect(events.filter((event) => event.method === "POST")).toEqual([
			{
				url: "/api/trash-guides/user-custom-formats/import-from-instance",
				method: "POST",
				body: { instanceId: "radarr-a", cfIds: [11], defaultScore: 37 },
			},
		]);
		users = [
			{
				id: "instance-cf",
				name: "Selected instance CF",
				serviceType: "RADARR",
				description: null,
				includeCustomFormatWhenRenaming: true,
				specifications: [],
				defaultScore: 37,
				sourceInstanceId: "radarr-a",
				sourceCFId: 11,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		];
		await act(async () =>
			held.release(
				response({ success: true, created: ["Selected instance CF"], skipped: [], failed: [] }),
			),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(await screen.findByText("Selected instance CF")).toBeInTheDocument();
		expect(screen.queryByText("Unselected instance CF")).not.toBeInTheDocument();
		expect(
			events.some((event) => event.url.includes("deploy") || event.url.includes("import-json")),
		).toBe(false);
	});
});
