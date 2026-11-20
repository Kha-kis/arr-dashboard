import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationRulesTab } from "../notification-rules-tab";
import { NotificationsTab } from "../notifications-tab";

// Permission/enrollment is outside ordinary list admission. All list consumers,
// contexts, query hooks, API clients and query caches remain actual production code.
vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const firstChannel = {
	id: "channel-first",
	name: "Synthetic first channel",
	type: "LEGACY_CHANNEL",
	enabled: true,
	lastTestedAt: "2026-01-02T03:04:05.000Z",
	lastTestResult: "success",
	lastSentAt: "2026-01-03T03:04:05.000Z",
	lastSendResult: "failed",
	createdAt: "2026-01-01T03:04:05.000Z",
	updatedAt: "2026-01-04T03:04:05.000Z",
	subscriptions: ["LEGACY_EVENT", "HUNT_COMPLETED", "LEGACY_EVENT"],
};
const secondChannel = {
	...firstChannel,
	id: "channel-second",
	name: "Synthetic second channel",
	type: "WEBHOOK",
	enabled: false,
	lastTestedAt: null,
	lastTestResult: null,
	lastSentAt: null,
	lastSendResult: null,
	subscriptions: [],
};
const firstRule = {
	id: "rule-first",
	name: "Synthetic first rule",
	enabled: true,
	priority: 42,
	action: "quiet_hours",
	conditions: [
		{ field: "legacy.custom.field", operator: "equals", value: "" },
		{ field: "eventType", operator: "in", value: [] },
		{ field: "metadata.literal.key", operator: "in", value: ["", "literal, member", ""] },
		{ field: "metadata.count", operator: "greater_than", value: 0 },
	],
	targetChannelIds: ["channel-second", "channel-first"],
	throttleMinutes: 0,
	quietHoursStart: "",
	quietHoursEnd: "",
	quietHoursTimezone: "",
	createdAt: "2026-01-01T03:04:05.000Z",
	updatedAt: "2026-01-04T03:04:05.000Z",
};
const secondRule = {
	...firstRule,
	id: "rule-second",
	name: "Synthetic second rule",
	enabled: false,
	priority: 3,
	action: "suppress",
	conditions: [{ field: "eventType", operator: "equals", value: "LEGACY_EVENT" }],
	targetChannelIds: null,
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
};
const channels = [firstChannel, secondChannel];
const rules = [firstRule, secondRule];
type Domain = "channels" | "rules";
const clients: QueryClient[] = [];
const violations: string[] = [];
const writes: string[] = [];

class RenderBoundary extends Component<
	{ children: ReactNode; crashes: Error[] },
	{ crashed: boolean }
> {
	override state = { crashed: false };
	static getDerivedStateFromError() {
		return { crashed: true };
	}
	override componentDidCatch(error: Error, _info: ErrorInfo) {
		this.props.crashes.push(error);
	}
	override render() {
		return this.state.crashed ? (
			<div data-testid="render-crash">Render crashed</div>
		) : (
			this.props.children
		);
	}
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mount(domain: Domain, reply: (read: number) => Response) {
	let reads = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		const method = init.method ?? "GET";
		if (method !== "GET") writes.push(`${method} ${path}`);
		if (
			init.credentials !== "include" ||
			init.body !== undefined ||
			"expectedSuccessStatus" in init
		) {
			violations.push("Unexpected ordinary-list wire options");
			throw new Error("Unexpected synthetic wire options");
		}
		if (method === "GET" && path === `/api/notifications/${domain}`) return reply(++reads);
		if (method === "GET" && path === "/api/notifications/channels") return json(channels);
		if (method === "GET" && path === "/api/notifications/channel-types") {
			return json([{ type: "WEBHOOK", label: "Webhook", icon: "Globe", formFields: [] }]);
		}
		violations.push(`${method} ${path}`);
		throw new Error("Unexpected synthetic list-admission HTTP edge");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	const crashes: Error[] = [];
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<RenderBoundary crashes={crashes}>
						{domain === "channels" ? <NotificationsTab /> : <NotificationRulesTab />}
					</RenderBoundary>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { client, crashes, reads: () => reads, key: notificationKeys[domain] };
}

async function settled(view: ReturnType<typeof mount>) {
	await waitFor(() => {
		const state = view.client.getQueryState(view.key);
		expect(state?.fetchStatus).toBe("idle");
		expect(state?.status).not.toBe("pending");
		expect(screen.queryByLabelText("Loading notification channels")).not.toBeInTheDocument();
		expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
	});
}

function retryButton(domain: Domain) {
	return screen.queryByRole("button", {
		name: domain === "channels" ? "Retry notification channels" : "Try again",
	});
}

function assertReadError(domain: Domain, view: ReturnType<typeof mount>, retained = false) {
	expect
		.soft(view.client.getQueryState(view.key)?.status, "malformed GET must be a query error")
		.toBe("error");
	expect.soft(view.crashes, "query admission must prevent a render crash").toEqual([]);
	expect.soft(screen.queryByTestId("render-crash")).not.toBeInTheDocument();
	expect
		.soft(retryButton(domain), "the existing ordinary-read retry must be available")
		.toBeInTheDocument();
	expect
		.soft(screen.queryByText(/No notification (channels|rules) configured yet/))
		.not.toBeInTheDocument();
	const feedback = screen.queryByText(
		retained
			? /last-known.*(refresh failed|latest refresh failed)/i
			: /Couldn't load notification (channels|rules)/i,
	);
	expect.soft(feedback, "generic honest read-error feedback must be visible").toBeInTheDocument();
	if (!retained) {
		expect
			.soft(
				view.client.getQueryData(view.key),
				"no invalid or partial list enters the public cache",
			)
			.toBeUndefined();
		expect
			.soft(screen.queryAllByTitle(domain === "channels" ? "Edit channel" : "Edit rule"))
			.toHaveLength(0);
		expect
			.soft(screen.queryAllByTitle(domain === "channels" ? "Delete channel" : "Delete rule"))
			.toHaveLength(0);
	}
	expect.soft(writes).toEqual([]);
	expect.soft(view.client.getMutationCache().getAll()).toHaveLength(0);
}

function assertRows(domain: Domain, names: string[]) {
	const rows = screen.getAllByTitle(domain === "channels" ? "Edit channel" : "Edit rule");
	expect(rows).toHaveLength(names.length);
	for (const [index, name] of names.entries()) {
		const row = rows[index]?.closest("div.rounded-xl");
		if (!(row instanceof HTMLElement)) throw new Error("Actual notification row unavailable");
		expect(within(row).getByText(name)).toBeInTheDocument();
	}
}

beforeEach(() => {
	localStorage.removeItem("arr-dashboard-incognito-mode");
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

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.removeItem("arr-dashboard-incognito-mode");
	expect(violations.splice(0)).toEqual([]);
	expect(writes.splice(0)).toEqual([]);
});

describe.each(["channels", "rules"] as const)("mounted ordinary %s list admission", (domain) => {
	const first = domain === "channels" ? firstChannel : firstRule;
	const baseline = domain === "channels" ? channels : rules;
	const { id: _missingId, ...missingIdentity } = first;
	// These catch unchecked successful GET publication at real consumers, before
	// invalid roots/members/identities can become empty state or actionable rows.
	it.each([
		{ label: "null root", payload: null },
		{ label: "object root", payload: { items: baseline } },
		{ label: "null member among valid members", payload: [first, null] },
		{ label: "duplicate identity", payload: [first, { ...first, name: "Duplicate identity row" }] },
		{ label: "missing identity", payload: [first, missingIdentity] },
		{ label: "blank identity", payload: [first, { ...first, id: "  " }] },
	])("rejects $label as a complete generic read error", async ({ payload }) => {
		const view = mount(domain, () => json(payload));
		await settled(view);
		assertReadError(domain, view);
	});

	it("admits literal populated legacy DTOs in response order without rewriting public metadata", async () => {
		const view = mount(domain, () => json(baseline));
		await settled(view);
		expect(view.client.getQueryState(view.key)?.status).toBe("success");
		expect(view.client.getQueryData(view.key)).toEqual(baseline);
		expect(view.crashes).toEqual([]);
		assertRows(
			domain,
			domain === "channels"
				? ["Synthetic first channel", "Synthetic second channel"]
				: ["Synthetic first rule", "Synthetic second rule"],
		);
		if (domain === "rules") {
			fireEvent.click(screen.getAllByTitle("Edit rule")[0]!);
			expect(await screen.findByRole("button", { name: "Update Rule" })).toBeInTheDocument();
			expect(screen.getAllByLabelText("Condition field")[0]).toHaveValue("legacy.custom.field");
			expect(
				screen.getAllByLabelText("List value").map((input) => (input as HTMLInputElement).value),
			).toEqual(["", "literal, member", ""]);
		}
		expect(writes).toEqual([]);
	});

	it("admits a genuine empty array as successful empty state", async () => {
		const view = mount(domain, () => json([]));
		await settled(view);
		expect(view.client.getQueryState(view.key)?.status).toBe("success");
		expect(view.client.getQueryData(view.key)).toEqual([]);
		expect(screen.getByText(/No notification (channels|rules) configured yet/)).toBeInTheDocument();
		expect(retryButton(domain)).not.toBeInTheDocument();
		expect(view.crashes).toEqual([]);
	});

	it("retains populated cache identity, metadata and order after malformed refetch, then permits read-only retry", async () => {
		const view = mount(domain, (read) =>
			json(read === 2 ? [first, { ...first, id: "" }] : baseline),
		);
		await settled(view);
		const previous = view.client.getQueryData(view.key);
		const updatedAt = view.client.getQueryState(view.key)?.dataUpdatedAt;
		await act(async () => {
			await view.client.refetchQueries({ queryKey: view.key, exact: true });
		});
		await settled(view);
		assertReadError(domain, view, true);
		expect
			.soft(
				view.client.getQueryData(view.key),
				"failed refetch retains the exact prior cache identity",
			)
			.toBe(previous);
		expect.soft(view.client.getQueryData(view.key)).toEqual(baseline);
		expect.soft(view.client.getQueryState(view.key)?.dataUpdatedAt).toBe(updatedAt);
		const retry = retryButton(domain);
		if (retry) {
			fireEvent.click(retry);
			await waitFor(() => expect(view.reads()).toBe(3));
			await settled(view);
			expect(view.client.getQueryState(view.key)?.status).toBe("success");
			expect(view.client.getQueryData(view.key)).toEqual(baseline);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			assertRows(
				domain,
				domain === "channels"
					? ["Synthetic first channel", "Synthetic second channel"]
					: ["Synthetic first rule", "Synthetic second rule"],
			);
		}
	});

	it("control: retains populated rows through transport failure and recovers through the actual retry UI", async () => {
		const view = mount(domain, (read) =>
			read === 2 ? json({ message: "Synthetic read unavailable" }, 503) : json(baseline),
		);
		await settled(view);
		const previous = view.client.getQueryData(view.key);
		await act(async () => {
			await view.client.refetchQueries({ queryKey: view.key, exact: true });
		});
		await settled(view);
		assertReadError(domain, view, true);
		expect(view.client.getQueryData(view.key)).toBe(previous);
		assertRows(
			domain,
			domain === "channels"
				? ["Synthetic first channel", "Synthetic second channel"]
				: ["Synthetic first rule", "Synthetic second rule"],
		);
		fireEvent.click(retryButton(domain)!);
		await waitFor(() => expect(view.reads()).toBe(3));
		await settled(view);
		expect(view.client.getQueryState(view.key)?.status).toBe("success");
		expect(view.client.getQueryData(view.key)).toEqual(baseline);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("publishes only public metadata from a successful response containing unexpected private fields", async () => {
		const extra: Record<string, unknown> = {
			...first,
			config: { token: "synthetic-private-token" },
			userId: "synthetic-owner",
		};
		if (domain === "rules") {
			extra.conditions = firstRule.conditions.map((condition) => ({
				...condition,
				privateNote: "synthetic-private-note",
			}));
		}
		const view = mount(domain, () => json([extra, baseline[1]]));
		await settled(view);
		expect(view.client.getQueryState(view.key)?.status).toBe("success");
		expect(view.crashes).toEqual([]);
		expect(view.client.getQueryData(view.key)).toEqual(baseline);
	});
});

describe("mounted ordinary nested list admission", () => {
	it("rejects a channel subscription array containing a non-string member", async () => {
		const view = mount("channels", () =>
			json([firstChannel, { ...secondChannel, subscriptions: [null] }]),
		);
		await settled(view);
		assertReadError("channels", view);
	});
	it("rejects a rule whose conditions root is not an array", async () => {
		const view = mount("rules", () => json([firstRule, { ...secondRule, conditions: null }]));
		await settled(view);
		assertReadError("rules", view);
	});
	it("rejects nested non-string condition list members before the actual rule editor can open", async () => {
		const view = mount("rules", () =>
			json([
				{ ...firstRule, conditions: [{ field: "eventType", operator: "in", value: [["nested"]] }] },
			]),
		);
		await settled(view);
		const edit = screen.queryByTitle("Edit rule");
		if (edit) fireEvent.click(edit);
		assertReadError("rules", view);
		expect
			.soft(
				screen.queryByRole("button", { name: "Update Rule" }),
				"malformed nested data must never enter the editor",
			)
			.not.toBeInTheDocument();
		expect.soft(screen.queryByLabelText("List value")).not.toBeInTheDocument();
	});
});

describe("mounted channel public read structure", () => {
	it.each([
		{ label: "non-string name", change: { name: null } },
		{ label: "empty name", change: { name: "" } },
		{ label: "blank type", change: { type: " " } },
		{ label: "non-boolean enabled", change: { enabled: 1 } },
		{ label: "non-UTC creation timestamp", change: { createdAt: "2026-01-01T03:04:05+01:00" } },
		{ label: "null required update timestamp", change: { updatedAt: null } },
		{ label: "invalid last-tested timestamp", change: { lastTestedAt: "2026-13-01T03:04:05Z" } },
		{
			label: "private historical test result",
			change: { lastTestResult: "synthetic-private-diagnostic" },
		},
		{ label: "malformed optional delivery timestamp", change: { lastSentAt: 42 } },
		{ label: "malformed optional delivery result", change: { lastSendResult: false } },
		{ label: "blank subscription tag", change: { subscriptions: ["HUNT_COMPLETED", " "] } },
	])("rejects $label without partial public cache publication", async ({ change }) => {
		const view = mount("channels", () => json([firstChannel, { ...secondChannel, ...change }]));
		await settled(view);
		assertReadError("channels", view);
	});

	it("preserves omitted optional delivery fields without fabricating nullable values", async () => {
		const { lastSentAt: _sentAt, lastSendResult: _sendResult, ...withoutDelivery } = firstChannel;
		const view = mount("channels", () => json([withoutDelivery]));
		await settled(view);
		expect(view.client.getQueryState(view.key)?.status).toBe("success");
		expect(view.client.getQueryData(view.key)).toEqual([withoutDelivery]);
		assertRows("channels", ["Synthetic first channel"]);
		expect(view.crashes).toEqual([]);
	});
});

describe("mounted rule public read structure", () => {
	it.each([
		{ label: "non-string name", change: { name: { text: "synthetic" } } },
		{ label: "non-boolean enabled", change: { enabled: "true" } },
		{ label: "non-numeric priority", change: { priority: "3" } },
		{ label: "unknown action", change: { action: "legacy-unknown-action" } },
		{ label: "null condition member", change: { conditions: [null] } },
		{
			label: "unknown condition operator",
			change: { conditions: [{ field: "title", operator: "unknown", value: "" }] },
		},
		{
			label: "non-literal condition value",
			change: {
				conditions: [{ field: "title", operator: "equals", value: { text: "synthetic" } }],
			},
		},
		{ label: "non-string target member", change: { targetChannelIds: [42] } },
		{ label: "non-numeric nullable throttle", change: { throttleMinutes: "0" } },
		{ label: "non-string nullable quiet-hours setting", change: { quietHoursStart: false } },
		{ label: "non-string creation timestamp", change: { createdAt: 42 } },
	])("rejects $label as a complete read error", async ({ change }) => {
		const view = mount("rules", () => json([firstRule, { ...secondRule, ...change }]));
		await settled(view);
		assertReadError("rules", view);
	});

	it.each(["priority", "throttleMinutes", "condition value"] as const)(
		"rejects valid JSON numeric overflow in %s",
		async (field) => {
			const overflow =
				field === "condition value"
					? {
							...secondRule,
							conditions: [
								{
									field: "metadata.count",
									operator: "greater_than",
									value: "synthetic-exponent-overflow",
								},
							],
						}
					: { ...secondRule, [field]: "synthetic-exponent-overflow" };
			// JSON 1e400 is syntactically valid and parses to Infinity. This tests
			// finite-number admission through actual response parsing, not a fake parser.
			const body = JSON.stringify([firstRule, overflow]).replace(
				'"synthetic-exponent-overflow"',
				"1e400",
			);
			const view = mount(
				"rules",
				() => new Response(body, { headers: { "Content-Type": "application/json" } }),
			);
			await settled(view);
			assertReadError("rules", view);
		},
	);

	it("preserves historical empty conditions/settings and finite values outside creation ranges", async () => {
		const historical = {
			...firstRule,
			name: "",
			priority: -2.5,
			conditions: [],
			targetChannelIds: ["", "channel-second", "channel-second"],
			throttleMinutes: -0.5,
			createdAt: "",
			updatedAt: "historical timestamp",
		};
		const literalConditions = {
			...secondRule,
			conditions: [
				{ field: "", operator: "equals", value: "" },
				{ field: " ", operator: "greater_than", value: -2.5 },
			],
		};
		const view = mount("rules", () => json([historical, literalConditions]));
		await settled(view);
		expect(view.client.getQueryState(view.key)?.status).toBe("success");
		expect(view.client.getQueryData(view.key)).toEqual([historical, literalConditions]);
		expect(screen.getAllByTitle("Edit rule")).toHaveLength(2);
		fireEvent.click(screen.getAllByTitle("Edit rule")[1]!);
		expect(await screen.findByRole("button", { name: "Update Rule" })).toBeInTheDocument();
		expect(
			screen.getAllByLabelText("Field path").map((input) => (input as HTMLInputElement).value),
		).toEqual(["", " "]);
		expect(view.crashes).toEqual([]);
	});
});
