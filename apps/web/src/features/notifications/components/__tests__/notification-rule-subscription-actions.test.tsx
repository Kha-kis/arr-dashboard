import type {
	NotificationChannelResponse,
	NotificationRuleResponse,
	SubscriptionGrid as SubscriptionGridResponse,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { SubscriptionUpdateEntry } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationRulesTab } from "../notification-rules-tab";
import { SubscriptionGrid } from "../subscription-grid";

const activeRule: NotificationRuleResponse = {
	id: "active-rule",
	name: "Synthetic active rule",
	enabled: true,
	priority: 13,
	action: "suppress",
	conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
	targetChannelIds: null,
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};
const disabledRule: NotificationRuleResponse = {
	...activeRule,
	id: "disabled-rule",
	name: "Synthetic disabled rule",
	enabled: false,
	priority: 21,
	action: "throttle",
	throttleMinutes: 9,
};
const firstChannel: NotificationChannelResponse = {
	id: "first-channel",
	name: "Synthetic first channel",
	type: "DISCORD",
	enabled: true,
	lastTestedAt: null,
	lastTestResult: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	subscriptions: ["HUNT_COMPLETED"],
};
const secondChannel: NotificationChannelResponse = {
	...firstChannel,
	id: "second-channel",
	name: "Synthetic second channel",
	subscriptions: ["BACKUP_FAILED"],
};
const initialGrid: SubscriptionGridResponse = {
	channels: [firstChannel, secondChannel],
	events: ["HUNT_COMPLETED", "BACKUP_FAILED"],
	subscriptions: [
		{ channelId: "first-channel", eventType: "HUNT_COMPLETED" },
		{ channelId: "second-channel", eventType: "BACKUP_FAILED" },
	],
};
const ruleGuidance = "Reload the rules and reapply your changes.";
const subscriptionGuidance = "Reload the subscriptions and reapply your changes.";
const deleteGuidance = "Rule could not be deleted. Reload the rules and try again.";

interface RequestRecord {
	path: string;
	method: string;
	body: BodyInit | null | undefined;
	payload: Record<string, unknown> | undefined;
	credentials: RequestCredentials | undefined;
	contentType: string | null;
	status?: number;
}

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const clients: QueryClient[] = [];
const pendingCleanup: Array<() => void> = [];

beforeEach(() => {
	localStorage.clear();
	toast.dismiss();
	// jsdom lacks matchMedia, needed by the real Sonner Toaster environment.
	vi.stubGlobal("matchMedia", (media: string) => ({
		media,
		matches: false,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	}));
});

afterEach(async () => {
	cleanup();
	toast.dismiss();
	await act(async () => {
		for (const release of pendingCleanup.splice(0)) release();
	});
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

// Only the external transport is synthetic. Components, hooks, API serialization,
// providers, mutation state, invalidation, refetch and query cache remain real.
// Responses are in-memory fixtures, not evidence of server/provider persistence.
function fixture(options: { gridRead?: "pending" | "error" | "empty" } = {}) {
	let rules = [activeRule, disabledRule];
	let grid: SubscriptionGridResponse = {
		...initialGrid,
		subscriptions: [...initialGrid.subscriptions],
	};
	const requests: RequestRecord[] = [];
	const mutationPlans: Array<() => Promise<Response | undefined>> = [];
	const pendingGrid = options.gridRead === "pending" ? deferred<Response>() : undefined;
	if (pendingGrid) pendingCleanup.push(() => pendingGrid.resolve(json(initialGrid)));
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		if (typeof input !== "string") throw new Error("Unexpected synthetic request representation");
		const request: RequestRecord = {
			path: input,
			method: init.method ?? "GET",
			body: init.body,
			payload: init.body === undefined ? undefined : JSON.parse(String(init.body)),
			credentials: init.credentials,
			contentType: new Headers(init.headers).get("Content-Type"),
		};
		requests.push(request);
		let response: Response;
		if (request.method === "GET") {
			if (input === "/api/notifications/rules")
				response = json([...rules].sort((a, b) => a.priority - b.priority));
			else if (input === "/api/notifications/channels")
				response = json([firstChannel, secondChannel]);
			else if (input === "/api/notifications/subscriptions")
				response =
					options.gridRead === "error"
						? json({ message: "Synthetic generic read failure" }, 503)
						: options.gridRead === "empty"
							? json({
									channels: [],
									events: ["HUNT_COMPLETED", "BACKUP_FAILED"],
									subscriptions: [],
								})
							: pendingGrid
								? await pendingGrid.promise
								: json(grid);
			else throw new Error(`Unscoped synthetic GET ${input}`);
		} else {
			if (
				!(
					(request.method === "PUT" || request.method === "DELETE") &&
					/^\/api\/notifications\/rules\/(active-rule|disabled-rule)$/.test(input)
				) &&
				!(request.method === "POST" && input === "/api/notifications/rules") &&
				!(request.method === "PUT" && input === "/api/notifications/subscriptions")
			)
				throw new Error(`Unscoped synthetic mutation ${request.method} ${input}`);
			const planned = await mutationPlans.shift()?.();
			if (planned) response = planned;
			else if (request.method === "DELETE") {
				rules = rules.filter((rule) => input !== `/api/notifications/rules/${rule.id}`);
				response = new Response(null, { status: 204 });
			} else if (request.method === "POST") {
				const created = { ...activeRule, ...request.payload, id: "created-rule" };
				rules = [...rules, created];
				response = json(created, 201);
			} else if (input === "/api/notifications/subscriptions") {
				const entries = (request.payload as { subscriptions: SubscriptionUpdateEntry[] })
					.subscriptions;
				for (const entry of entries) {
					grid = {
						...grid,
						subscriptions: grid.subscriptions.filter(
							(sub) => sub.channelId !== entry.channelId || sub.eventType !== entry.eventType,
						),
					};
					if (entry.enabled)
						grid.subscriptions.push({ channelId: entry.channelId, eventType: entry.eventType });
				}
				response = json({ success: true, grid, omittedCount: 0 });
			} else {
				rules = rules.map((rule) =>
					input === `/api/notifications/rules/${rule.id}` ? { ...rule, ...request.payload } : rule,
				);
				response = json(rules.find((rule) => input === `/api/notifications/rules/${rule.id}`));
			}
		}
		request.status = response.status;
		return response;
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	return {
		client,
		requests,
		writes: () => requests.filter((request) => request.method !== "GET"),
		reads: (path: string) =>
			requests.filter((request) => request.method === "GET" && request.path === path),
		deferMutation() {
			const gate = deferred<Response | undefined>();
			mutationPlans.push(() => gate.promise);
			pendingCleanup.push(() => gate.resolve(undefined));
			return gate;
		},
		releaseGrid: async () => {
			await act(async () => pendingGrid?.resolve(json(initialGrid)));
		},
		mount(component: "rules" | "subscriptions") {
			return render(
				<QueryClientProvider client={client}>
					<ColorThemeProvider>
						<IncognitoProvider>
							{component === "rules" ? <NotificationRulesTab /> : <SubscriptionGrid />}
							<Toaster theme="light" duration={60_000} />
						</IncognitoProvider>
					</ColorThemeProvider>
				</QueryClientProvider>,
			);
		},
	};
}

function ruleRow(name: string) {
	const row = screen.getByText(name).closest(".rounded-xl");
	if (!(row instanceof HTMLElement)) throw new Error("Missing actual populated rule row");
	return within(row);
}

const cachedRules = (client: QueryClient) =>
	client.getQueryData<NotificationRuleResponse[]>(notificationKeys.rules)!;
const cachedGrid = (client: QueryClient) =>
	client.getQueryData<SubscriptionGridResponse>(notificationKeys.subscriptions)!;

async function populatedRules(value: ReturnType<typeof fixture>) {
	value.mount("rules");
	await screen.findByText("Synthetic active rule");
	expect(screen.getByText("Synthetic disabled rule")).toBeInTheDocument();
}

describe("notification rule actions through actual hooks and client", () => {
	it("toggle stays truthful while pending/409, then explicit retry refetches only the intended change", async () => {
		const value = fixture();
		const pending = value.deferMutation();
		await populatedRules(value);
		fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Disable rule"));
		await waitFor(() => expect(value.writes()).toHaveLength(1));
		expect(value.writes()[0]).toMatchObject({
			path: "/api/notifications/rules/active-rule",
			method: "PUT",
			payload: { enabled: false },
			credentials: "include",
			contentType: "application/json",
		});
		expect(value.writes()[0]!.payload).toEqual({ enabled: false });
		expect(ruleRow("Synthetic active rule").getByText("Active")).toBeInTheDocument();
		expect(ruleRow("Synthetic active rule").getByTitle("Disable rule")).toBeDisabled();
		expect(cachedRules(value.client)[0]).toMatchObject({ enabled: true, priority: 13 });
		await act(async () =>
			pending.resolve(json({ code: "RULE_SETTINGS_CONFLICT", message: ruleGuidance }, 409)),
		);
		await screen.findByText(ruleGuidance);
		await waitFor(() =>
			expect(ruleRow("Synthetic active rule").getByTitle("Disable rule")).toBeEnabled(),
		);
		expect(value.writes()).toHaveLength(1);
		expect(value.writes()[0]!.status).toBe(409);
		expect(value.reads("/api/notifications/rules")).toHaveLength(1);
		expect(cachedRules(value.client)).toEqual([activeRule, disabledRule]);
		fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Disable rule"));
		await waitFor(() =>
			expect(ruleRow("Synthetic active rule").getByText("Disabled")).toBeInTheDocument(),
		);
		expect(value.writes()).toHaveLength(2);
		expect(value.writes()[1]!.payload).toEqual({ enabled: false });
		expect(value.writes()[1]!.status).toBe(200);
		expect(value.reads("/api/notifications/rules")).toHaveLength(2);
		expect(cachedRules(value.client)[0]).toMatchObject({
			enabled: false,
			priority: 13,
			name: "Synthetic active rule",
		});
		expect(cachedRules(value.client)[1]).toEqual(disabledRule);
	});

	it("editing a disabled rule retains disabled unless the user explicitly toggles it", async () => {
		const value = fixture();
		await populatedRules(value);
		fireEvent.click(ruleRow("Synthetic disabled rule").getByTitle("Edit rule"));
		fireEvent.change(screen.getByPlaceholderText("e.g. Suppress hunt noise"), {
			target: { value: "Renamed disabled rule" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await screen.findByText("Renamed disabled rule");
		await waitFor(() => expect(screen.queryByText("Edit Rule")).not.toBeInTheDocument());
		expect(value.writes()).toHaveLength(1);
		expect(value.writes()[0]).toMatchObject({
			method: "PUT",
			path: "/api/notifications/rules/disabled-rule",
			status: 200,
		});
		expect(value.reads("/api/notifications/rules")).toHaveLength(2);
		expect.soft(value.writes()[0]!.payload).toMatchObject({
			name: "Renamed disabled rule",
			priority: 21,
			action: "throttle",
			throttleMinutes: 9,
		});
		expect.soft(value.writes()[0]!.payload).not.toHaveProperty("enabled");
		expect
			.soft(cachedRules(value.client)[1])
			.toMatchObject({ name: "Renamed disabled rule", enabled: false, priority: 21 });
		expect.soft(ruleRow("Renamed disabled rule").queryByText("Disabled")).toBeInTheDocument();
		expect(cachedRules(value.client)[0]).toEqual(activeRule);
	});

	it("saving an open editor does not undo a separately acknowledged toggle", async () => {
		const value = fixture();
		await populatedRules(value);
		fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Edit rule"));
		fireEvent.change(screen.getByPlaceholderText("e.g. Suppress hunt noise"), {
			target: { value: "Draft retained after toggle" },
		});
		fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Disable rule"));
		await waitFor(() =>
			expect(ruleRow("Synthetic active rule").getByText("Disabled")).toBeInTheDocument(),
		);
		expect(cachedRules(value.client)[0]).toMatchObject({ enabled: false, priority: 13 });
		expect(screen.getByPlaceholderText("e.g. Suppress hunt noise")).toHaveValue(
			"Draft retained after toggle",
		);
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await screen.findByText("Draft retained after toggle");
		await waitFor(() => expect(screen.queryByText("Edit Rule")).not.toBeInTheDocument());
		expect(value.writes()).toHaveLength(2);
		expect(value.writes()[0]!.payload).toEqual({ enabled: false });
		expect.soft(value.writes()[1]!.payload).not.toHaveProperty("enabled");
		expect.soft(cachedRules(value.client)[0]).toMatchObject({
			name: "Draft retained after toggle",
			enabled: false,
			priority: 13,
		});
		expect.soft(ruleRow("Draft retained after toggle").queryByText("Disabled")).toBeInTheDocument();
		expect(cachedRules(value.client)[1]).toEqual(disabledRule);
	});

	it("a save conflict retains the visible draft without retry, then explicit save closes and refetches", async () => {
		const value = fixture();
		const pending = value.deferMutation();
		await populatedRules(value);
		fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Edit rule"));
		fireEvent.change(screen.getByPlaceholderText("e.g. Suppress hunt noise"), {
			target: { value: "Renamed active draft" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await waitFor(() => expect(value.writes()).toHaveLength(1));
		expect(screen.getByRole("button", { name: "Update Rule" })).toBeDisabled();
		expect(screen.getByText("Edit Rule")).toBeInTheDocument();
		expect(cachedRules(value.client)[0]).toEqual(activeRule);
		await act(async () =>
			pending.resolve(json({ code: "RULE_SETTINGS_CONFLICT", message: ruleGuidance }, 409)),
		);
		await screen.findByText(ruleGuidance);
		expect(screen.getByPlaceholderText("e.g. Suppress hunt noise")).toHaveValue(
			"Renamed active draft",
		);
		await waitFor(() => expect(screen.getByRole("button", { name: "Update Rule" })).toBeEnabled());
		expect(value.writes()).toHaveLength(1);
		expect(value.writes()[0]!.payload).toEqual({
			name: "Renamed active draft",
			action: "suppress",
			conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			priority: 13,
		});
		expect(value.reads("/api/notifications/rules")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await screen.findByText("Renamed active draft");
		await waitFor(() => expect(screen.queryByText("Edit Rule")).not.toBeInTheDocument());
		expect(value.writes()).toHaveLength(2);
		expect(value.writes().map((request) => request.status)).toEqual([409, 200]);
		expect(value.reads("/api/notifications/rules")).toHaveLength(2);
		expect(cachedRules(value.client)[0]).toMatchObject({
			name: "Renamed active draft",
			enabled: true,
			priority: 13,
		});
		expect(cachedRules(value.client)[1]).toEqual(disabledRule);
	});

	it("creation retains enabled=true default and preserves populated existing rules", async () => {
		const value = fixture();
		await populatedRules(value);
		fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
		fireEvent.change(screen.getByPlaceholderText("e.g. Suppress hunt noise"), {
			target: { value: "Synthetic created rule" },
		});
		fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "HUNT_COMPLETED" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Rule" }));
		await screen.findByText("Synthetic created rule");
		expect(value.writes()).toHaveLength(1);
		expect(value.writes()[0]).toMatchObject({
			method: "POST",
			path: "/api/notifications/rules",
			status: 201,
		});
		expect(value.writes()[0]!.payload).toEqual({
			name: "Synthetic created rule",
			action: "suppress",
			conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			priority: 0,
			enabled: true,
		});
		expect(cachedRules(value.client)).toHaveLength(3);
		expect(cachedRules(value.client).map((rule) => rule.id)).toEqual([
			"created-rule",
			"active-rule",
			"disabled-rule",
		]);
		expect(cachedRules(value.client).slice(1)).toEqual([activeRule, disabledRule]);
		expect(ruleRow("Synthetic created rule").getByText("Active")).toBeInTheDocument();
	});

	it.each([404, 500])(
		"bodyless delete keeps%s truthful; unknown requires fresh list review before a new confirmation",
		async (status) => {
			const value = fixture();
			const pending = value.deferMutation();
			await populatedRules(value);
			fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Delete rule"));
			expect(value.writes()).toHaveLength(0);
			expect(
				ruleRow("Synthetic active rule").getByTitle("Click again to confirm"),
			).toBeInTheDocument();
			fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Click again to confirm"));
			await waitFor(() => expect(value.writes()).toHaveLength(1));
			expect(value.writes()[0]).toMatchObject({
				method: "DELETE",
				path: "/api/notifications/rules/active-rule",
				body: undefined,
				payload: undefined,
				contentType: null,
				credentials: "include",
			});
			expect(screen.getByText("Synthetic active rule")).toBeInTheDocument();
			await act(async () => pending.resolve(json({ message: deleteGuidance }, status)));
			if (status === 500) {
				await screen.findByText(/rule deletion outcome could not be verified/i);
				await waitFor(() => expect(value.reads("/api/notifications/rules")).toHaveLength(2));
				const button = ruleRow("Synthetic active rule").getByTitle("Delete rule");
				expect(button).toBeDisabled();
				fireEvent.click(button);
				fireEvent.click(button);
				expect(value.writes()).toHaveLength(1);
				expect(cachedRules(value.client)).toEqual([activeRule, disabledRule]);
				fireEvent.click(screen.getByRole("button", { name: "Recheck rule list" }));
				await waitFor(() => expect(value.reads("/api/notifications/rules")).toHaveLength(3));
				expect(value.writes()).toHaveLength(1);
				expect(screen.getByRole("alert")).toHaveTextContent(/previous outcome remains unverified/i);
			} else {
				await screen.findByText(/rule could not be deleted/i);
				expect(value.reads("/api/notifications/rules")).toHaveLength(1);
			}
			expect(document.body).not.toHaveTextContent(deleteGuidance);
			await waitFor(() =>
				expect(ruleRow("Synthetic active rule").getByTitle("Delete rule")).toBeEnabled(),
			);
			expect(value.writes()).toHaveLength(1);
			expect(cachedRules(value.client)).toEqual([activeRule, disabledRule]);
			fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Delete rule"));
			expect(value.writes()).toHaveLength(1);
			fireEvent.click(ruleRow("Synthetic active rule").getByTitle("Click again to confirm"));
			await waitFor(() =>
				expect(screen.queryByText("Synthetic active rule")).not.toBeInTheDocument(),
			);
			expect(value.writes()).toHaveLength(2);
			expect(value.writes().map((request) => request.status)).toEqual([status, 204]);
			expect(cachedRules(value.client)).toEqual([disabledRule]);
			await waitFor(() =>
				expect(value.reads("/api/notifications/rules")).toHaveLength(status === 500 ? 4 : 2),
			);
		},
	);
});

describe("notification subscription grid through actual hooks and client", () => {
	it("sends minimal changes, retains a pending/conflicted draft and explicitly retries with real refetch", async () => {
		const value = fixture();
		const pending = value.deferMutation();
		value.mount("subscriptions");
		await screen.findByRole("table");
		expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Unsubscribe Synthetic first channel from Hunt Completed",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Subscribe Synthetic first channel from Backup Failed" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(value.writes()).toHaveLength(1));
		expect(value.writes()[0]).toMatchObject({
			method: "PUT",
			path: "/api/notifications/subscriptions",
			credentials: "include",
			contentType: "application/json",
		});
		expect(value.writes()[0]!.payload).toEqual({
			subscriptions: [
				{ channelId: "first-channel", eventType: "HUNT_COMPLETED", enabled: false },
				{ channelId: "first-channel", eventType: "BACKUP_FAILED", enabled: true },
			],
		});
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Subscribe Synthetic first channel from Hunt Completed" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Unsubscribe Synthetic first channel from Backup Failed",
			}),
		).toBeInTheDocument();
		expect(cachedGrid(value.client).subscriptions).toEqual([
			{ channelId: "first-channel", eventType: "HUNT_COMPLETED" },
			{ channelId: "second-channel", eventType: "BACKUP_FAILED" },
		]);
		await act(async () =>
			pending.resolve(
				json({ code: "SUBSCRIPTION_OWNERSHIP_CONFLICT", message: subscriptionGuidance }, 409),
			),
		);
		await screen.findByText("Subscriptions could not be saved. Review your draft and try again.");
		await waitFor(() => expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled());
		expect(value.writes()).toHaveLength(1);
		expect(value.reads("/api/notifications/subscriptions")).toHaveLength(1);
		expect(
			screen.getByRole("button", {
				name: "Unsubscribe Synthetic second channel from Backup Failed",
			}),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument(),
		);
		await waitFor(() =>
			expect(cachedGrid(value.client).subscriptions).toEqual(
				expect.arrayContaining([
					{ channelId: "first-channel", eventType: "BACKUP_FAILED" },
					{ channelId: "second-channel", eventType: "BACKUP_FAILED" },
				]),
			),
		);
		expect(cachedGrid(value.client).subscriptions).toHaveLength(2);
		expect(value.writes()).toHaveLength(2);
		expect(value.writes()[1]!.payload).toEqual({
			subscriptions: [
				{ channelId: "first-channel", eventType: "HUNT_COMPLETED", enabled: false },
				{ channelId: "first-channel", eventType: "BACKUP_FAILED", enabled: true },
			],
		});
		expect(value.writes().map((request) => request.status)).toEqual([409, 200]);
		expect(value.reads("/api/notifications/subscriptions")).toHaveLength(2);
		expect(
			screen.getByRole("button", { name: "Subscribe Synthetic first channel from Hunt Completed" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Unsubscribe Synthetic second channel from Backup Failed",
			}),
		).toBeInTheDocument();
	});

	it("pending initial subscription read cannot expose saved controls early", async () => {
		const value = fixture({ gridRead: "pending" });
		value.mount("subscriptions");
		await waitFor(() => expect(value.reads("/api/notifications/subscriptions")).toHaveLength(1));
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
		expect(value.client.getQueryState(notificationKeys.subscriptions)?.status).toBe("pending");
		await value.releaseGrid();
		await screen.findByRole("table");
		expect(value.writes()).toHaveLength(0);
	});

	it("subscription read failure exposes a generic refresh category without mutation", async () => {
		const value = fixture({ gridRead: "error" });
		value.mount("subscriptions");
		expect(await screen.findByRole("alert")).toHaveTextContent(/subscriptions are unavailable/i);
		expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		expect(value.client.getQueryState(notificationKeys.subscriptions)?.status).toBe("error");
		expect(value.writes()).toHaveLength(0);
	});

	it("empty channel read asks for a channel without reporting subscription changes", async () => {
		const value = fixture({ gridRead: "empty" });
		value.mount("subscriptions");
		await screen.findByText(
			"Create at least one notification channel before configuring event subscriptions.",
		);
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
		expect(value.writes()).toHaveLength(0);
		expect(cachedGrid(value.client).channels).toEqual([]);
	});
});
