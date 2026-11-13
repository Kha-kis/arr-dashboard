import type { NotificationChannelResponse, NotificationRuleResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationRulesTab } from "../notification-rules-tab";

// Only HTTP and the browser's absent matchMedia API are synthetic. The actual
// Tab, context toggle, hooks, client, observers/cache and Sonner renderer run.
const privateName = "Synthetic-private-rule-name";
const privateChannel = "Synthetic-private-channel-name";
const privateValue = "Synthetic-private-condition-value";
const privateZone = "Synthetic/Private-Timezone";
const privateError = "Synthetic-private-response-detail";
const firstRule: NotificationRuleResponse = {
	id: "rule-opaque-alpha",
	name: privateName,
	enabled: true,
	priority: 2,
	action: "route",
	conditions: [{ field: "title", operator: "contains", value: privateValue }],
	targetChannelIds: ["channel-opaque-beta"],
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-06T00:00:00.000Z",
};
const sibling: NotificationRuleResponse = {
	...firstRule,
	id: "rule-opaque-beta",
	enabled: false,
	priority: 9,
	action: "suppress",
	targetChannelIds: null,
};
const throttle: NotificationRuleResponse = {
	...firstRule,
	id: "rule-opaque-throttle",
	name: "Synthetic-private-throttle-name",
	priority: 19,
	action: "throttle",
	targetChannelIds: null,
	throttleMinutes: 17,
};
const quiet: NotificationRuleResponse = {
	...firstRule,
	id: "rule-opaque-quiet",
	name: "Synthetic-private-quiet-name",
	priority: 29,
	action: "quiet_hours",
	targetChannelIds: null,
	quietHoursStart: "legacy-private-start",
	quietHoursEnd: "legacy-private-end",
	quietHoursTimezone: privateZone,
};
const firstChannel: NotificationChannelResponse = {
	id: "channel-opaque-alpha",
	name: privateChannel,
	type: "DISCORD",
	enabled: true,
	lastTestedAt: null,
	lastTestResult: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-06T00:00:00.000Z",
	subscriptions: ["HUNT_COMPLETED"],
};
const secondChannel: NotificationChannelResponse = {
	...firstChannel,
	id: "channel-opaque-beta",
	type: "EMAIL",
};
const baseline = [firstRule, sibling, throttle, quiet];
const channels = [firstChannel, secondChannel];
const listPath = "/api/notifications/rules";
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const violations: string[] = [];

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function held() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((settle) => {
		resolve = settle;
	});
	releases.push(() => resolve(json(baseline)));
	return {
		promise,
		finish: async (response: Response) => {
			await act(async () => resolve(response));
		},
	};
}
interface Write {
	method: string;
	path: string;
	payload: Record<string, unknown> | undefined;
	body: BodyInit | null | undefined;
}
function fixture(
	options: {
		rules?: NotificationRuleResponse[];
		read?: () => Response | Promise<Response>;
		allowed?: "POST" | "PUT" | "DELETE";
		writeId?: string;
		write?: () => Response | Promise<Response>;
	} = {},
) {
	let rules = options.rules ?? baseline;
	const writes: Write[] = [];
	const reads: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		if (init.credentials !== "include" || "expectedSuccessStatus" in init) {
			violations.push("Unexpected scoped wire options");
			throw new Error("Unexpected scoped wire options");
		}
		if (method === "GET" && init.body === undefined && path === "/api/notifications/channels") {
			reads.push(path);
			return json(channels);
		}
		if (method === "GET" && init.body === undefined && path === listPath) {
			reads.push(path);
			return options.read ? options.read() : json(rules);
		}
		const writePath =
			options.allowed === "POST" ? listPath : `${listPath}/${options.writeId ?? firstRule.id}`;
		if (
			method !== options.allowed ||
			path !== writePath ||
			(method === "DELETE"
				? init.body !== undefined
				: new Headers(init.headers).get("Content-Type") !== "application/json")
		) {
			violations.push(`${method} ${path}`);
			throw new Error("Unexpected Rules UI synthetic edge");
		}
		const payload =
			init.body === undefined
				? undefined
				: (JSON.parse(String(init.body)) as Record<string, unknown>);
		writes.push({ method, path, payload, body: init.body });
		if (options.write) return options.write();
		if (method === "DELETE") {
			rules = rules.filter((rule) => path !== `${listPath}/${rule.id}`);
			return new Response(null, { status: 204 });
		}
		if (method === "POST") {
			const created = {
				...firstRule,
				...payload,
				id: "rule-opaque-created",
			} as NotificationRuleResponse;
			rules = [...rules, created].sort((a, b) => a.priority - b.priority);
			return json(created, 201);
		}
		rules = rules.map((rule) =>
			path === `${listPath}/${rule.id}`
				? ({ ...rule, ...payload } as NotificationRuleResponse)
				: rule,
		);
		return json(rules.find((rule) => path === `${listPath}/${rule.id}`));
	});
	return { writes, reads };
}
function PrivacyControl() {
	const [mode, setMode] = useIncognitoMode();
	return (
		<button type="button" aria-pressed={mode} onClick={() => setMode(!mode)}>
			Toggle privacy
		</button>
	);
}
function mount(options: { incognito?: boolean; two?: boolean } = {}) {
	if (options.incognito) localStorage.setItem("arr-dashboard-incognito-mode", "true");
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	const tree = (visible: boolean) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<PrivacyControl />
					<section aria-label="First Rules UI">{visible && <NotificationRulesTab />}</section>
					{options.two && (
						<section aria-label="Second Rules UI">{visible && <NotificationRulesTab />}</section>
					)}
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const view = render(tree(true));
	return { ...view, client, hideTab: () => view.rerender(tree(false)) };
}
async function populated(count = 4) {
	await waitFor(() => expect(screen.getAllByTitle("Edit rule")).toHaveLength(count));
}
async function edit(index = 0) {
	await populated();
	fireEvent.click(screen.getAllByTitle("Edit rule")[index]!);
	await screen.findByRole("button", { name: "Update Rule" });
}
function editor() {
	const heading = screen.getByRole("heading", { name: /^(Edit|New) Rule$/ });
	const region = heading.closest("div.rounded-xl");
	if (!(region instanceof HTMLElement)) throw new Error("Actual rule editor missing");
	return region;
}
// Setup locates controls independently of the missing associations under test.
// Accessibility assertions below use real label/role association, not this seam.
function input(label: string, scope: HTMLElement = editor()) {
	const text = within(scope).getByText(label, { selector: "label" });
	const control = text.parentElement?.querySelector("input");
	if (!(control instanceof HTMLInputElement)) throw new Error(`Actual ${label} input missing`);
	return control;
}
function values(scope: HTMLElement = editor()) {
	return within(scope).getAllByPlaceholderText<HTMLInputElement>("Value");
}
function channelButtons(scope: HTMLElement = editor()) {
	return within(scope).getAllByRole("button", { name: privateChannel });
}
function togglePrivacy() {
	fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
}
function privateSurfaces() {
	return (
		document.body.innerHTML +
		Array.from(
			document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
				"input,textarea,select",
			),
		)
			.map((element) => element.value)
			.join(" ")
	);
}
function assertMasked(
	markers = [
		privateName,
		privateChannel,
		privateValue,
		privateZone,
		"legacy-private-start",
		"legacy-private-end",
		throttle.name,
		quiet.name,
	],
) {
	for (const marker of markers) expect(privateSurfaces()).not.toContain(marker);
}
async function terminal(client: QueryClient) {
	await waitFor(() => {
		const entries = client.getMutationCache().getAll();
		expect(entries).toHaveLength(1);
		expect(["success", "error"]).toContain(entries[0]!.state.status);
	});
}
beforeEach(() => {
	localStorage.clear();
	toast.dismiss();
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
		for (const release of releases.splice(0)) release();
	});
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});

describe("normal Rules UI wire and legacy controls", () => {
	it("renders all four actions, raw names and nonidentifying metadata normally", async () => {
		const wire = fixture();
		mount();
		await populated();
		expect(screen.getAllByText(privateName)).toHaveLength(2);
		for (const action of ["Suppress", "Throttle", "Route to channels", "Quiet Hours"])
			expect(screen.getByText(action)).toBeInTheDocument();
		expect(screen.getByText(/17m window/)).toBeInTheDocument();
		expect(
			screen.getByText(/legacy-private-start–legacy-private-end Synthetic\/Private-Timezone/),
		).toBeInTheDocument();
		expect(wire.writes).toEqual([]);
	});
	it.each([
		{
			index: 1,
			want: {
				name: privateName,
				action: "suppress",
				conditions: [{ field: "title", operator: "contains", value: privateValue }],
				priority: 9,
			},
		},
		{
			index: 2,
			want: {
				name: "Synthetic-private-throttle-name",
				action: "throttle",
				conditions: [{ field: "title", operator: "contains", value: privateValue }],
				priority: 19,
				throttleMinutes: 17,
			},
		},
		{
			index: 0,
			want: {
				name: privateName,
				action: "route",
				conditions: [{ field: "title", operator: "contains", value: privateValue }],
				priority: 2,
				targetChannelIds: ["channel-opaque-beta"],
			},
		},
		{
			index: 3,
			want: {
				name: "Synthetic-private-quiet-name",
				action: "quiet_hours",
				conditions: [{ field: "title", operator: "contains", value: privateValue }],
				priority: 29,
				quietHoursStart: "legacy-private-start",
				quietHoursEnd: "legacy-private-end",
				quietHoursTimezone: privateZone,
			},
		},
	])(
		"untouched $want.action edit sends exact original values and selected opaque ID",
		async ({ index, want }) => {
			const wire = fixture({ allowed: "PUT", writeId: baseline[index]!.id });
			const view = mount();
			await edit(index);
			fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
			await terminal(view.client);
			expect(wire.writes).toHaveLength(1);
			expect(wire.writes[0]!.payload).toEqual(want);
			expect(wire.writes[0]!.path).toBe(`${listPath}/${baseline[index]!.id}`);
			expect(wire.writes[0]!.payload).not.toHaveProperty("enabled");
			await waitFor(() => expect(screen.queryByText("Edit Rule")).not.toBeInTheDocument());
		},
	);
	it("untouched unknown fields, numeric and array condition values retain exact types on save", async () => {
		const legacy: NotificationRuleResponse = {
			...firstRule,
			action: "suppress",
			targetChannelIds: null,
			conditions: [
				{ field: "metadata.count", operator: "greater_than", value: 7 },
				{ field: "body", operator: "in", value: ["Literal A", "Literal B"] },
				{ field: "legacy.field", operator: "equals", value: "Literal string" },
			],
		};
		const wire = fixture({ rules: [legacy, sibling, throttle, quiet], allowed: "PUT" });
		const view = mount();
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload).toEqual({
			name: privateName,
			action: "suppress",
			priority: 2,
			conditions: [
				{ field: "metadata.count", operator: "greater_than", value: 7 },
				{ field: "body", operator: "in", value: ["Literal A", "Literal B"] },
				{ field: "legacy.field", operator: "equals", value: "Literal string" },
			],
		});
	});
	it("CREATE emits only literal real draft fields and the existing enabled default", async () => {
		const wire = fixture({ allowed: "POST" });
		const view = mount();
		await populated();
		fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
		fireEvent.change(input("Rule name"), { target: { value: "Created literal rule" } });
		fireEvent.change(values()[0]!, { target: { value: "HUNT_COMPLETED" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload).toEqual({
			name: "Created literal rule",
			action: "suppress",
			conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			priority: 0,
			enabled: true,
		});
		expect(wire.writes[0]!.path).toBe(listPath);
	});
	it("same-name row toggle changes only the selected opaque ID and enabled field", async () => {
		const wire = fixture({ allowed: "PUT", writeId: sibling.id });
		const view = mount();
		await populated();
		fireEvent.click(screen.getByTitle("Enable rule"));
		await terminal(view.client);
		expect(wire.writes[0]!.path).toBe("/api/notifications/rules/rule-opaque-beta");
		expect(wire.writes[0]!.payload).toEqual({ enabled: true });
		expect(
			view.client
				.getQueryData<NotificationRuleResponse[]>(notificationKeys.rules)
				?.find((rule) => rule.id === firstRule.id),
		).toEqual(firstRule);
	});
	it("privacy does not change selected opaque ID/bodyless DELETE or same-name sibling preservation", async () => {
		const wire = fixture({ allowed: "DELETE", writeId: sibling.id });
		const view = mount({ incognito: true });
		await populated();
		const selected = screen.getAllByTitle("Delete rule")[1]!;
		fireEvent.click(selected);
		expect(wire.writes).toHaveLength(0);
		fireEvent.click(screen.getByTitle("Click again to confirm"));
		await terminal(view.client);
		expect(wire.writes).toEqual([
			{
				method: "DELETE",
				path: "/api/notifications/rules/rule-opaque-beta",
				payload: undefined,
				body: undefined,
			},
		]);
		expect(
			view.client
				.getQueryData<NotificationRuleResponse[]>(notificationKeys.rules)
				?.map((rule) => rule.id),
		).toEqual(["rule-opaque-alpha", "rule-opaque-throttle", "rule-opaque-quiet"]);
	});
	it.each([400, 409])(
		"normal %s save rejection retains raw structured guidance and exact draft without replay",
		async (status) => {
			const wire = fixture({
				allowed: "PUT",
				write: () => json({ code: "RULE_SETTINGS_CONFLICT", message: privateError }, status),
			});
			const view = mount();
			await edit();
			fireEvent.change(input("Rule name"), { target: { value: "Retained literal draft" } });
			fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
			await terminal(view.client);
			await screen.findByText(privateError);
			expect(input("Rule name")).toHaveValue("Retained literal draft");
			expect(wire.writes).toHaveLength(1);
			expect(view.client.getQueryData(notificationKeys.rules)).toEqual(baseline);
		},
	);
});

describe("actual incognito presentation and draft admission", () => {
	it("masks list names, legacy quiet strings and identifying attributes while preserving public summaries", async () => {
		fixture();
		mount({ incognito: true });
		await populated();
		assertMasked();
		for (const action of ["Suppress", "Throttle", "Route to channels", "Quiet Hours"])
			expect(screen.getByText(action)).toBeInTheDocument();
		expect(screen.getByText("Priority 29")).toBeInTheDocument();
		expect(screen.getByText("Disabled")).toBeInTheDocument();
	});
	it("a late initial GET publishes only masked current list data in privacy mode", async () => {
		const read = held();
		const wire = fixture({ read: () => read.promise });
		const view = mount();
		await screen.findByRole("status", { name: "Loading table" });
		togglePrivacy();
		await read.finish(json(baseline));
		await populated();
		assertMasked();
		expect(view.client.getQueryData(notificationKeys.rules)).toEqual(baseline);
		expect(wire.writes).toHaveLength(0);
	});
	it("legacy quiet summary hides identifying time and timezone strings independently of rule names", async () => {
		fixture();
		mount({ incognito: true });
		await populated();
		assertMasked(["legacy-private-start", "legacy-private-end", privateZone]);
	});
	it.each([
		{ label: "name", value: privateName },
		{ label: "condition", value: privateValue },
	])(
		"stored $label is absent from actual editor input values independently of the list",
		async ({ value }) => {
			fixture();
			mount({ incognito: true });
			await edit();
			const rendered = Array.from(editor().querySelectorAll<HTMLInputElement>("input"))
				.map((control) => control.value)
				.join(" ");
			expect(rendered).not.toContain(value);
		},
	);
	it("same-name channel button text and attributes are masked independently of rule names", async () => {
		fixture();
		mount({ incognito: true });
		await edit();
		expect(editor().innerHTML).not.toContain(privateChannel);
	});
	it.each([0, 3])(
		"stored editor %s masks all identifying values and locks every draft control",
		async (index) => {
			fixture();
			mount({ incognito: true });
			await edit(index);
			assertMasked();
			for (const control of editor().querySelectorAll("input,select"))
				expect(control).toBeDisabled();
			expect(screen.getByRole("button", { name: "Update Rule" })).toBeDisabled();
			expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
		},
	);
	it("a forced save click in a private stored editor never writes a masked or real draft", async () => {
		const wire = fixture({ allowed: "PUT" });
		mount({ incognito: true });
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await act(async () => {});
		expect(wire.writes).toEqual([]);
	});
	it("Cancel closes the stored editor without leaving privacy or writing", async () => {
		const wire = fixture();
		mount({ incognito: true });
		await edit();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Edit Rule")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Toggle privacy" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(wire.writes).toEqual([]);
	});
	it("actual context on/off preserves a live quiet-hours draft without reread or write", async () => {
		const wire = fixture({ allowed: "PUT", writeId: quiet.id });
		const view = mount();
		await edit(3);
		fireEvent.change(input("Rule name"), { target: { value: "Quiet unsaved literal" } });
		fireEvent.change(input("Start time"), { target: { value: "21:13" } });
		fireEvent.change(input("End time"), { target: { value: "07:42" } });
		fireEvent.change(input("Timezone"), { target: { value: "Literal/Unsaved-Timezone" } });
		const reads = wire.reads.length;
		togglePrivacy();
		togglePrivacy();
		expect(input("Rule name")).toHaveValue("Quiet unsaved literal");
		expect(input("Start time")).toHaveValue("21:13");
		expect(input("End time")).toHaveValue("07:42");
		expect(input("Timezone")).toHaveValue("Literal/Unsaved-Timezone");
		expect(wire.reads).toHaveLength(reads);
		expect(wire.writes).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload).toEqual({
			name: "Quiet unsaved literal",
			action: "quiet_hours",
			conditions: [{ field: "title", operator: "contains", value: privateValue }],
			priority: 29,
			quietHoursStart: "21:13",
			quietHoursEnd: "07:42",
			quietHoursTimezone: "Literal/Unsaved-Timezone",
		});
	});
	it("late current-list refresh across privacy does not reset an existing unsaved editor draft", async () => {
		const read = held();
		let reads = 0;
		const wire = fixture({ read: () => (++reads === 1 ? json(baseline) : read.promise) });
		const view = mount();
		await edit();
		fireEvent.change(input("Rule name"), { target: { value: "Retained pending-read draft" } });
		fireEvent.change(values()[0]!, { target: { value: "Retained pending-read value" } });
		await act(async () => {
			void view.client.invalidateQueries({ queryKey: notificationKeys.rules });
		});
		await waitFor(() => expect(reads).toBe(2));
		togglePrivacy();
		await read.finish(
			json([{ ...firstRule, name: "Different current server name" }, sibling, throttle, quiet]),
		);
		togglePrivacy();
		expect(input("Rule name")).toHaveValue("Retained pending-read draft");
		expect(values()[0]).toHaveValue("Retained pending-read value");
		expect(wire.writes).toEqual([]);
	});
	it("explicit privacy-off restores stored real draft and same-name target without a read or alias write", async () => {
		const wire = fixture({ allowed: "PUT" });
		const view = mount({ incognito: true });
		await edit();
		const reads = wire.reads.length;
		fireEvent.click(screen.getByRole("button", { name: /turn off incognito to edit/i }));
		expect(input("Rule name")).toHaveValue(privateName);
		expect(values()[0]).toHaveValue(privateValue);
		expect(wire.reads).toHaveLength(reads);
		expect(wire.writes).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload).toEqual({
			name: privateName,
			action: "route",
			conditions: [{ field: "title", operator: "contains", value: privateValue }],
			priority: 2,
			targetChannelIds: ["channel-opaque-beta"],
		});
	});
	it("live unsaved draft values disappear from DOM when privacy turns on", async () => {
		const wire = fixture();
		mount();
		await edit();
		fireEvent.change(input("Rule name"), { target: { value: "Synthetic-private-unsaved-name" } });
		fireEvent.change(values()[0]!, { target: { value: "Synthetic-private-unsaved-value" } });
		togglePrivacy();
		assertMasked([
			"Synthetic-private-unsaved-name",
			"Synthetic-private-unsaved-value",
			privateChannel,
		]);
		expect(wire.writes).toEqual([]);
	});
	it("privacy locks action, priority, target and condition editing as well as save", async () => {
		fixture();
		mount();
		await edit();
		togglePrivacy();
		for (const control of editor().querySelectorAll("input,select")) expect(control).toBeDisabled();
		for (const control of within(editor()).getAllByRole("button")) {
			if (!/cancel|turn off incognito/i.test(control.textContent ?? ""))
				expect(control).toBeDisabled();
		}
	});
	it("off-on-off preserves exact unsaved name, conditions, priority and target selection without read/write", async () => {
		const wire = fixture({ allowed: "PUT" });
		const view = mount();
		await edit();
		fireEvent.change(input("Rule name"), { target: { value: "Synthetic-private-unsaved-name" } });
		fireEvent.change(input("Priority (0 = first)"), { target: { value: "31" } });
		fireEvent.change(values()[0]!, { target: { value: "Synthetic-private-unsaved-value" } });
		fireEvent.click(channelButtons()[0]!);
		fireEvent.click(channelButtons()[1]!);
		const reads = wire.reads.length;
		togglePrivacy();
		fireEvent.click(screen.getByRole("button", { name: /turn off incognito to edit/i }));
		expect(input("Rule name")).toHaveValue("Synthetic-private-unsaved-name");
		expect(input("Priority (0 = first)")).toHaveValue(31);
		expect(values()[0]).toHaveValue("Synthetic-private-unsaved-value");
		expect(wire.reads).toHaveLength(reads);
		expect(wire.writes).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload).toEqual({
			name: "Synthetic-private-unsaved-name",
			action: "route",
			conditions: [
				{ field: "title", operator: "contains", value: "Synthetic-private-unsaved-value" },
			],
			priority: 31,
			targetChannelIds: ["channel-opaque-alpha"],
		});
	});
	it("new unsaved CREATE draft remains real across privacy and cannot be published while locked", async () => {
		const wire = fixture({ allowed: "POST" });
		const view = mount();
		await populated();
		fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
		fireEvent.change(input("Rule name"), { target: { value: "Synthetic-private-create-name" } });
		fireEvent.change(values()[0]!, { target: { value: "Synthetic-private-create-value" } });
		togglePrivacy();
		fireEvent.click(screen.getByRole("button", { name: "Create Rule" }));
		await act(async () => {});
		expect(wire.writes).toEqual([]);
		assertMasked(["Synthetic-private-create-name", "Synthetic-private-create-value"]);
		fireEvent.click(screen.getByRole("button", { name: /turn off incognito to edit/i }));
		expect(input("Rule name")).toHaveValue("Synthetic-private-create-name");
		expect(values()[0]).toHaveValue("Synthetic-private-create-value");
		fireEvent.click(screen.getByRole("button", { name: "Create Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload).toEqual({
			name: "Synthetic-private-create-name",
			action: "suppress",
			conditions: [
				{ field: "eventType", operator: "equals", value: "Synthetic-private-create-value" },
			],
			priority: 0,
			enabled: true,
		});
	});
});

describe("privacy-current initial and late error feedback", () => {
	it("private initial GET errors render useful generic failure and retry without hidden raw detail", async () => {
		const wire = fixture({ read: () => json({ message: privateError }, 503) });
		mount({ incognito: true });
		await screen.findByRole("alert");
		expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load notification rules/i);
		expect(screen.getByRole("button", { name: /try again/i })).toBeEnabled();
		assertMasked([privateError]);
		expect(wire.writes).toEqual([]);
	});
	it.each([400, 409])(
		"late %s save failure uses current privacy mode and retains exact unsaved draft/cache",
		async (status) => {
			const response = held();
			const wire = fixture({ allowed: "PUT", write: () => response.promise });
			const view = mount();
			await edit();
			fireEvent.change(input("Rule name"), { target: { value: "Late private draft" } });
			fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
			await waitFor(() => expect(wire.writes).toHaveLength(1));
			togglePrivacy();
			await response.finish(
				json({ code: "RULE_SETTINGS_CONFLICT", message: privateError }, status),
			);
			await terminal(view.client);
			await waitFor(() =>
				expect(document.querySelector("[data-sonner-toast]")).toBeInTheDocument(),
			);
			assertMasked([privateError, "Late private draft"]);
			expect(document.querySelector("[data-sonner-toast]")?.textContent).toMatch(
				/failed|could not|unable/i,
			);
			expect(view.client.getQueryData(notificationKeys.rules)).toEqual(baseline);
			expect(wire.writes).toHaveLength(1);
			togglePrivacy();
			expect(input("Rule name")).toHaveValue("Late private draft");
		},
	);
	it("late toggle failure uses current privacy without changing cached enabled state", async () => {
		const response = held();
		const wire = fixture({ allowed: "PUT", write: () => response.promise });
		const view = mount();
		await populated();
		fireEvent.click(screen.getAllByTitle("Disable rule")[0]!);
		await waitFor(() => expect(wire.writes).toHaveLength(1));
		togglePrivacy();
		await response.finish(json({ message: privateError }, 409));
		await terminal(view.client);
		await waitFor(() => expect(document.querySelector("[data-sonner-toast]")).toBeInTheDocument());
		assertMasked([privateError]);
		expect(wire.writes[0]!.payload).toEqual({ enabled: false });
		expect(view.client.getQueryData(notificationKeys.rules)).toEqual(baseline);
	});
	it("late successful save closes editor and masks acknowledged names in current privacy", async () => {
		const response = held();
		const wire = fixture({
			allowed: "PUT",
			write: () => response.promise,
			read: () => json(baseline),
		});
		const view = mount();
		await edit();
		fireEvent.change(input("Rule name"), { target: { value: "Synthetic-private-ack-name" } });
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await waitFor(() => expect(wire.writes).toHaveLength(1));
		togglePrivacy();
		await response.finish(json({ ...firstRule, name: "Synthetic-private-ack-name" }));
		await terminal(view.client);
		await waitFor(() => expect(screen.queryByText("Edit Rule")).not.toBeInTheDocument());
		assertMasked([privateName, "Synthetic-private-ack-name"]);
		expect(wire.writes[0]!.payload?.name).toBe("Synthetic-private-ack-name");
	});
});

describe("RUI-S1 already-visible rule feedback follows actual current privacy", () => {
	it.each([
		{ action: "create", status: 400, hideTab: false },
		{ action: "update", status: 409, hideTab: false },
		{ action: "toggle", status: 409, hideTab: false },
		{ action: "create", status: 400, hideTab: true },
		{ action: "update", status: 409, hideTab: true },
		{ action: "toggle", status: 409, hideTab: true },
	])(
		"masks $action failure BEFORE privacy-on, tab removed=$hideTab, without replay or unrelated dismissal",
		async ({ action, status, hideTab }) => {
			const wire = fixture({
				allowed: action === "create" ? "POST" : "PUT",
				write: () => json({ code: "RULE_SETTINGS_CONFLICT", message: privateError }, status),
			});
			const view = mount();
			await populated();
			if (action === "create") {
				fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
				fireEvent.change(input("Rule name"), { target: { value: "Before privacy create draft" } });
				fireEvent.change(values()[0]!, { target: { value: "HUNT_COMPLETED" } });
				fireEvent.click(screen.getByRole("button", { name: "Create Rule" }));
			} else if (action === "update") {
				await edit();
				fireEvent.change(input("Rule name"), { target: { value: "Before privacy update draft" } });
				fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
			} else {
				fireEvent.click(screen.getAllByTitle("Disable rule")[0]!);
			}
			await terminal(view.client);
			const rawFeedback = await screen.findByText(privateError);
			expect(rawFeedback.closest("[data-sonner-toast]")).toBeInTheDocument();
			expect(wire.writes).toHaveLength(1);
			expect(wire.writes[0]!.method).toBe(action === "create" ? "POST" : "PUT");
			expect(wire.writes[0]!.path).toBe(
				action === "create" ? listPath : "/api/notifications/rules/rule-opaque-alpha",
			);
			if (action === "toggle") expect(wire.writes[0]!.payload).toEqual({ enabled: false });
			else
				expect(input("Rule name")).toHaveValue(
					action === "create" ? "Before privacy create draft" : "Before privacy update draft",
				);
			expect(view.client.getQueryData(notificationKeys.rules)).toEqual(baseline);
			await act(async () => {
				toast.success("Unrelated safe notification", {
					id: "unrelated-control",
					duration: Infinity,
				});
			});
			const unrelated = await screen.findByText("Unrelated safe notification");
			const reads = wire.reads.length;
			if (hideTab) {
				view.hideTab();
				expect(screen.queryByTitle("Edit rule")).not.toBeInTheDocument();
				expect(screen.getByText(privateError)).toBeInTheDocument();
			}
			togglePrivacy();
			// Independently execute preservation controls before the privacy RED.
			expect(unrelated).toBeInTheDocument();
			expect(screen.getByText("Unrelated safe notification")).toBe(unrelated);
			expect(wire.writes).toHaveLength(1);
			expect(wire.reads).toHaveLength(reads);
			expect(view.client.getQueryData(notificationKeys.rules)).toEqual(baseline);
			assertMasked([privateError]);
			const titles = Array.from(document.querySelectorAll("[data-sonner-toast] [data-title]")).map(
				(title) => title.textContent ?? "",
			);
			expect(titles.some((title) => /failed|could not|unable/i.test(title))).toBe(true);
			if (!hideTab && action !== "toggle") {
				togglePrivacy();
				expect(input("Rule name")).toHaveValue(
					action === "create" ? "Before privacy create draft" : "Before privacy update draft",
				);
				expect(wire.writes).toHaveLength(1);
			}
		},
	);
});

describe("runtime accessible rule editor controls", () => {
	it.each([
		{ label: "Rule name", action: "Route to channels", type: "text" },
		{ label: "Priority (0 = first)", action: "Route to channels", type: "number" },
		{ label: "Throttle window (minutes)", action: "Throttle", type: "number" },
		{ label: "Start time", action: "Quiet Hours", type: "time" },
		{ label: "End time", action: "Quiet Hours", type: "time" },
		{ label: "Timezone", action: "Quiet Hours", type: "text" },
	])("$label labels its actual $type input", async ({ label, action, type }) => {
		fixture();
		mount();
		await edit();
		fireEvent.click(within(editor()).getByRole("button", { name: action }));
		const control = within(editor()).getByLabelText(label);
		expect(control).toHaveAttribute("type", type);
		expect(control).toBe(input(label));
	});
	it.each(["Action", "Target channels", "Conditions"])(
		"%s is an accessible named group, not a label for a div",
		async (name) => {
			fixture();
			mount();
			await edit();
			expect(within(editor()).getByRole("group", { name })).toBeInTheDocument();
		},
	);
	it.each([
		{ name: "Condition field", role: "combobox" },
		{ name: "Condition operator", role: "combobox" },
		{ name: "Condition value", role: "textbox" },
		{ name: "Remove condition", role: "button" },
	])("each condition exposes generic accessible $name control", async ({ name, role }) => {
		fixture();
		mount();
		await edit();
		const control = within(editor()).getByRole(role, { name });
		expect(control).toBeInTheDocument();
	});
	it("action selection has truthful pressed state before and after changing draft action", async () => {
		fixture();
		mount();
		await edit();
		const route = within(editor()).getByRole("button", { name: "Route to channels" });
		const suppress = within(editor()).getByRole("button", { name: "Suppress" });
		expect(route).toHaveAttribute("aria-pressed", "true");
		expect(suppress).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(suppress);
		expect(route).toHaveAttribute("aria-pressed", "false");
		expect(suppress).toHaveAttribute("aria-pressed", "true");
	});
	it("same-name target selection has truthful pressed state and emits only real selected IDs", async () => {
		const wire = fixture({ allowed: "PUT" });
		const view = mount();
		await edit();
		const [alpha, beta] = channelButtons();
		expect(alpha).toHaveAttribute("aria-pressed", "false");
		expect(beta).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(alpha!);
		fireEvent.click(beta!);
		expect(alpha).toHaveAttribute("aria-pressed", "true");
		expect(beta).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload?.targetChannelIds).toEqual(["channel-opaque-alpha"]);
	});
	it("simultaneous editors use distinct IDs and labels associated with their own inputs", async () => {
		fixture();
		mount({ two: true });
		await populated(8);
		for (const label of ["First Rules UI", "Second Rules UI"]) {
			const scope = screen.getByRole("region", { name: label });
			fireEvent.click(within(scope).getByRole("button", { name: "Add Rule" }));
		}
		const first = within(screen.getByRole("region", { name: "First Rules UI" })).getByLabelText(
			"Rule name",
		);
		const second = within(screen.getByRole("region", { name: "Second Rules UI" })).getByLabelText(
			"Rule name",
		);
		expect(first.id).not.toBe("");
		expect(second.id).not.toBe("");
		expect(first.id).not.toBe(second.id);
		for (const label of document.querySelectorAll<HTMLLabelElement>("label[for]")) {
			expect(document.querySelectorAll(`[id="${label.htmlFor}"]`)).toHaveLength(1);
			expect(label.control).toBeInTheDocument();
		}
		fireEvent.change(first, { target: { value: "First draft" } });
		expect(second).toHaveValue("");
	});
});

describe("stable local condition identity independent of wire conditions", () => {
	function duplicateFixture() {
		return fixture({
			allowed: "PUT",
			rules: [
				{
					...firstRule,
					action: "suppress",
					targetChannelIds: null,
					conditions: [
						{ field: "title", operator: "contains", value: "Duplicate literal" },
						{ field: "title", operator: "contains", value: "Duplicate literal" },
						{ field: "body", operator: "contains", value: "Third literal" },
					],
				},
				sibling,
				throttle,
				quiet,
			],
		});
	}
	it("removing the first duplicate preserves surviving input DOM identity, focus and value", async () => {
		duplicateFixture();
		mount();
		await edit();
		const second = values()[1]!;
		second.focus();
		expect(second).toHaveFocus();
		fireEvent.click(within(editor()).getAllByTitle("Remove condition")[0]!);
		expect(values()[0]).toBe(second);
		expect(second).toHaveFocus();
		expect(second).toHaveValue("Duplicate literal");
	});
	it("removing an earlier row keeps focus on the same surviving logical condition", async () => {
		duplicateFixture();
		mount();
		await edit();
		values()[1]!.focus();
		fireEvent.click(within(editor()).getAllByTitle("Remove condition")[0]!);
		expect(values()[0]).toHaveFocus();
	});
	it("removing an earlier row does not replace the focused surviving value with a different row", async () => {
		duplicateFixture();
		mount();
		await edit();
		const second = values()[1]!;
		second.focus();
		fireEvent.click(within(editor()).getAllByTitle("Remove condition")[0]!);
		expect(second).toHaveValue("Duplicate literal");
	});
	it("remove/update/add/remove retains correct literal condition order and never leaks local keys in DTO", async () => {
		const wire = duplicateFixture();
		const view = mount();
		await edit();
		fireEvent.click(within(editor()).getAllByTitle("Remove condition")[0]!);
		fireEvent.change(values()[0]!, { target: { value: "Changed surviving literal" } });
		fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
		fireEvent.change(values()[2]!, { target: { value: "HUNT_COMPLETED" } });
		fireEvent.click(within(editor()).getAllByTitle("Remove condition")[1]!);
		fireEvent.click(screen.getByRole("button", { name: "Update Rule" }));
		await terminal(view.client);
		expect(wire.writes[0]!.payload).toEqual({
			name: privateName,
			action: "suppress",
			priority: 2,
			conditions: [
				{ field: "title", operator: "contains", value: "Changed surviving literal" },
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			],
		});
	});
});
