import { createServer, type Server } from "node:http";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { seerrKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationsTab } from "../notifications-tab";

const nodeFetch = globalThis.fetch;
let server: Server;
let queryClient: QueryClient;
let mode: "complete" | "partial" | "unavailable" | "empty" | "error";
let enabled: boolean;
let agentIds: string[];
let unavailableAgent: string;
let options: Map<string, Record<string, unknown>>;
let mutationPayloads: { path: string; config: Record<string, unknown> }[];
let events: { method: string; path: string }[];
let releaseRead: (() => void) | undefined;
let heldRead: Promise<void> | undefined;
const agent = (id = "discord", instanceId = "owned") => ({
	id,
	name: id === "discord" ? "Discord" : "Slack",
	enabled,
	types: 0,
	options: options.get(`${instanceId}:${id}`) ?? {},
});

beforeEach(async () => {
	mode = "complete";
	enabled = true;
	agentIds = ["discord"];
	unavailableAgent = "telegram";
	options = new Map([
		["owned:discord", { webhookUrl: "https://saved.example/discord" }],
		["owned:slack", { webhookUrl: "https://saved.example/slack" }],
		["peer:discord", { webhookUrl: "https://peer.example/discord" }],
	]);
	mutationPayloads = [];
	events = [];
	releaseRead = undefined;
	heldRead = undefined;
	localStorage.clear();
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	server = createServer(async (request, response) => {
		const path = request.url ?? "/";
		events.push({ method: request.method!, path });
		response.setHeader("content-type", "application/json");
		const read = /^\/api\/seerr\/notifications\/(owned|peer)$/.exec(path);
		if (request.method === "GET" && read) {
			if (heldRead) await heldRead;
			if (mode === "error") {
				response.writeHead(503).end(JSON.stringify({ message: "Synthetic API unavailable" }));
				return;
			}
			const agents =
				mode === "empty" || mode === "unavailable" ? [] : agentIds.map((id) => agent(id, read[1]));
			response.end(
				JSON.stringify({
					agents,
					coverage: mode === "empty" ? "complete" : mode,
					unavailableAgents:
						mode === "partial" || mode === "unavailable"
							? [
									{
										id: unavailableAgent,
										name: unavailableAgent === "discord" ? "Discord" : "Telegram",
									},
								]
							: [],
				}),
			);
			return;
		}
		const write = /^\/api\/seerr\/notifications\/(owned|peer)\/(discord|slack)$/.exec(path);
		if (request.method === "POST" && write) {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const config = JSON.parse(body);
			mutationPayloads.push({ path, config });
			if (typeof config.enabled === "boolean") enabled = config.enabled;
			if (config.options) options.set(`${write[1]}:${write[2]}`, config.options);
			response.end(JSON.stringify(agent(write[2], write[1])));
			return;
		}
		response.writeHead(405).end(JSON.stringify({ message: "Unexpected synthetic request" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Synthetic API absent");
	// Relative-URL adapter only: component, query hook, apiRequest and HTTP stay real.
	vi.stubGlobal("fetch", (input: RequestInfo | URL, options?: RequestInit) => {
		if (typeof input !== "string" || !input.startsWith("/api/seerr/"))
			throw new Error("Only owned synthetic API requests allowed");
		return nodeFetch(`http://127.0.0.1:${address.port}${input}`, options);
	});
});
afterEach(async () => {
	releaseRead?.();
	cleanup();
	await queryClient.cancelQueries();
	queryClient.clear();
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	vi.unstubAllGlobals();
});
function tab(instanceId = "owned") {
	return (
		<QueryClientProvider client={queryClient}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationsTab instanceId={instanceId} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}
function mount() {
	return render(tab());
}

describe("notification coverage presentation through actual query/API HTTP", () => {
	it("keeps complete verified controls usable", async () => {
		mount();
		await screen.findByRole("heading", { name: "Discord" });
		expect(screen.getByRole("button", { name: "Configure" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	it("shows partial coverage and known unavailable names while verified controls work", async () => {
		mode = "partial";
		mount();
		expect(await screen.findByRole("alert")).toHaveTextContent(/Telegram/);
		expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i);
		expect(screen.getAllByRole("heading", { name: "Discord" })).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		await screen.findByRole("button", { name: "Enable" });
		expect(events.filter((event) => event.method === "POST")).toEqual([
			{ method: "POST", path: "/api/seerr/notifications/owned/discord" },
		]);
		expect(screen.queryByRole("heading", { name: "Telegram" })).not.toBeInTheDocument();
	});
	it("renders unavailable rather than empty configuration when no read is verified", async () => {
		mode = "unavailable";
		mount();
		await screen.findByText(/notification agents unavailable/i);
		expect(screen.queryByText(/No supported notification agents/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	});
	it("shows a distinct complete empty unsupported state", async () => {
		mode = "empty";
		mount();
		await screen.findByText(/No supported notification agents/i);
		expect(screen.queryByText(/notification agents unavailable/i)).not.toBeInTheDocument();
	});
	it("retry is read-only, disabled while fetching and restores complete coverage", async () => {
		mode = "partial";
		mount();
		await screen.findByRole("alert");
		mode = "complete";
		heldRead = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(events).toHaveLength(2));
		expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
		await act(async () => {
			releaseRead?.();
		});
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
		expect(events.every((event) => event.method === "GET")).toBe(true);
	});
	it("initial transport failure is unavailable and explicit retry recovers", async () => {
		mode = "error";
		mount();
		await screen.findByText(/notification agents unavailable/i);
		mode = "complete";
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByRole("heading", { name: "Discord" });
		expect(events).toHaveLength(2);
		expect(events.every((event) => event.method === "GET")).toBe(true);
	});
	it("retained query data is last-known and all mutation controls stay disabled until recovery", async () => {
		mount();
		await screen.findByRole("heading", { name: "Discord" });
		mode = "error";
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: seerrKeys.notifications("owned") });
		});
		await screen.findByText(/last-known notification settings/i);
		expect(screen.getByRole("heading", { name: "Discord" })).toBeInTheDocument();
		for (const name of ["Configure", "Test", "Disable"])
			expect(screen.getByRole("button", { name })).toBeDisabled();
		mode = "complete";
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(screen.queryByText(/last-known notification settings/i)).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
		expect(events.every((event) => event.method === "GET")).toBe(true);
	});
});

async function openConfiguration(name = "Discord") {
	const heading = await screen.findByRole("heading", { name });
	const card = heading.closest<HTMLElement>(".group");
	if (!card) throw new Error("Verified agent card missing");
	fireEvent.click(within(card).getByRole("button", { name: "Configure" }));
	return screen.findByRole("dialog", { name: `${name} Configuration` });
}
async function refresh(instanceId = "owned") {
	await act(async () => {
		await queryClient.invalidateQueries({ queryKey: seerrKeys.notifications(instanceId) });
	});
}

describe("notification configuration editing session through actual query/API HTTP", () => {
	it("preserves dirty options across enabled readback and submits the edited value on Save", async () => {
		mount();
		const dialog = await openConfiguration();
		const field = within(dialog).getByLabelText("Webhook URL");
		expect(field).toHaveValue("https://saved.example/discord");
		fireEvent.change(field, { target: { value: "https://edited.example/discord" } });
		const toggle = within(dialog).getAllByRole("switch")[0]!;
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).not.toBeChecked());
		expect(queryClient.getQueryData(seerrKeys.notifications("owned"))).toMatchObject({
			agents: [{ enabled: false, options: { webhookUrl: "https://saved.example/discord" } }],
		});
		expect(field).toHaveValue("https://edited.example/discord");
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).toBeChecked());
		expect(field).toHaveValue("https://edited.example/discord");
		expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
		fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(mutationPayloads).toEqual([
			{ path: "/api/seerr/notifications/owned/discord", config: { enabled: false } },
			{ path: "/api/seerr/notifications/owned/discord", config: { enabled: true } },
			{
				path: "/api/seerr/notifications/owned/discord",
				config: { options: { webhookUrl: "https://edited.example/discord" } },
			},
		]);
		expect(options.get("owned:discord")).toEqual({ webhookUrl: "https://edited.example/discord" });
	});
	it("reopening initializes from the currently verified saved options, not the abandoned draft", async () => {
		mount();
		const dialog = await openConfiguration();
		fireEvent.change(within(dialog).getByLabelText("Webhook URL"), {
			target: { value: "https://abandoned.example" },
		});
		fireEvent.keyDown(document, { key: "Escape" });
		options.set("owned:discord", { webhookUrl: "https://fresh.example/discord" });
		await refresh();
		const reopened = await openConfiguration();
		expect(within(reopened).getByLabelText("Webhook URL")).toHaveValue(
			"https://fresh.example/discord",
		);
		expect(within(reopened).getByRole("button", { name: "Save" })).toBeDisabled();
		expect(mutationPayloads).toHaveLength(0);
	});
	for (const failure of ["disappearance", "unavailable", "error"] as const) {
		it(`removes an open dialog on ${failure} and initializes fresh verified options after recovery`, async () => {
			mount();
			const dialog = await openConfiguration();
			fireEvent.change(within(dialog).getByLabelText("Webhook URL"), {
				target: { value: "https://abandoned.example" },
			});
			if (failure === "disappearance") {
				mode = "partial";
				agentIds = ["slack"];
				unavailableAgent = "discord";
			} else mode = failure;
			await refresh();
			await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
			expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
			options.set("owned:discord", { webhookUrl: "https://recovered.example/discord" });
			mode = "complete";
			agentIds = ["discord"];
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			await screen.findByRole("heading", { name: "Discord" });
			await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
			const recovered = screen.queryByRole("dialog") ?? (await openConfiguration());
			expect(within(recovered).getByLabelText("Webhook URL")).toHaveValue(
				"https://recovered.example/discord",
			);
			expect(within(recovered).getByRole("button", { name: "Save" })).toBeDisabled();
			expect(mutationPayloads).toHaveLength(0);
		});
	}
	it("an intentional target change starts a new draft for that verified agent", async () => {
		agentIds = ["discord", "slack"];
		mount();
		const discord = await openConfiguration();
		fireEvent.change(within(discord).getByLabelText("Webhook URL"), {
			target: { value: "https://discord-draft.example" },
		});
		fireEvent.keyDown(document, { key: "Escape" });
		const slack = await openConfiguration("Slack");
		expect(within(slack).getByLabelText("Webhook URL")).toHaveValue("https://saved.example/slack");
		expect(within(slack).getByRole("button", { name: "Save" })).toBeDisabled();
		expect(mutationPayloads).toHaveLength(0);
	});
	it("an instance transition cannot submit the previous instance draft for the same agent ID", async () => {
		const view = mount();
		const dialog = await openConfiguration();
		fireEvent.change(within(dialog).getByLabelText("Webhook URL"), {
			target: { value: "https://owned-draft.example" },
		});
		view.rerender(tab("peer"));
		await waitFor(() =>
			expect(screen.getByLabelText("Webhook URL")).toHaveValue("https://peer.example/discord"),
		);
		const peer = screen.getByRole("dialog", { name: "Discord Configuration" });
		expect(within(peer).getByRole("button", { name: "Save" })).toBeDisabled();
		fireEvent.change(within(peer).getByLabelText("Webhook URL"), {
			target: { value: "https://peer-edit.example" },
		});
		fireEvent.click(within(peer).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(mutationPayloads).toEqual([
			{
				path: "/api/seerr/notifications/peer/discord",
				config: { options: { webhookUrl: "https://peer-edit.example" } },
			},
		]);
		expect(options.get("owned:discord")).toEqual({ webhookUrl: "https://saved.example/discord" });
	});
});
