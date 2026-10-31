import type { NotificationRuleResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useDeleteRule } from "../../../../hooks/api/useNotifications";
import { ApiError, UnauthorizedError } from "../../../../lib/api-client/base";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../../lib/auth-session-signal";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationRulesTab } from "../notification-rules-tab";

// Toast is only an external rendering sink: assert actual emitted arguments for
// privacy/guidance. The component, hooks, client and query observers remain real.
const sink = vi.hoisted(() => ({ errors: [] as unknown[][] }));
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => sink.errors.push(args) } }));

const privateDetail = "synthetic-private-rule-delete-detail";
const target: NotificationRuleResponse = {
	id: "rule-target",
	name: "Same synthetic rule",
	enabled: true,
	priority: 2,
	action: "suppress",
	conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
	targetChannelIds: null,
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-06T12:00:00.000Z",
};
const sibling: NotificationRuleResponse = {
	id: "rule-sibling",
	name: "Same synthetic rule",
	enabled: false,
	priority: 9,
	action: "route",
	conditions: [{ field: "title", operator: "contains", value: "Synthetic" }],
	targetChannelIds: [],
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-10-02T12:00:00.000Z",
	updatedAt: "2026-10-05T12:00:00.000Z",
};
const other: NotificationRuleResponse = {
	id: "rule-other",
	name: "Other synthetic rule",
	enabled: true,
	priority: 19,
	action: "throttle",
	conditions: [{ field: "metadata.count", operator: "greater_than", value: 2 }],
	targetChannelIds: null,
	throttleMinutes: 15,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-10-03T12:00:00.000Z",
	updatedAt: "2026-10-04T12:00:00.000Z",
};
const baseline = [target, sibling, other];
const listPath = "/api/notifications/rules";
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const violations: string[] = [];
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function ack() {
	return new Response(null, { status: 204 });
}
function held() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	releases.push(() => resolve(json(baseline)));
	return {
		promise,
		finish: async (response: Response) => {
			await act(async () => resolve(response));
		},
	};
}
const invalidSuccess = [
	{ label: "200 null", reply: () => json(null) },
	{ label: "200 metadata", reply: () => json({ ...target, message: privateDetail }) },
	{ label: "200 empty", reply: () => new Response(null, { status: 200 }) },
	{ label: "202 accepted", reply: () => json({ accepted: true, message: privateDetail }, 202) },
	{ label: "206 text", reply: () => new Response(privateDetail, { status: 206 }) },
	{
		label: "200 invalid JSON",
		reply: () =>
			new Response(privateDetail, { status: 200, headers: { "content-type": "application/json" } }),
	},
	{
		label: "200 body read lost",
		reply: () => {
			const response = json(null);
			response.json = async () => {
				throw new Error(privateDetail);
			};
			return response;
		},
	},
];
const uncertain = [
	{
		label: "network response loss",
		reply: () => {
			throw new Error(privateDetail);
		},
	},
	{ label: "408", reply: () => json({ message: privateDetail }, 408) },
	{ label: "500", reply: () => json({ message: privateDetail }, 500) },
	{ label: "503", reply: () => json({ message: privateDetail }, 503) },
];
const legacyCases = [
	{ action: "suppress", fields: { conditions: [], name: "", priority: -1 } },
	{
		action: "throttle",
		fields: {
			conditions: [{ field: "", operator: "equals", value: "" }],
			throttleMinutes: 0,
			priority: 2001,
		},
	},
	{ action: "route", fields: { conditions: [], targetChannelIds: [], name: " " } },
	{
		action: "quiet_hours",
		fields: {
			conditions: [],
			quietHoursStart: "",
			quietHoursEnd: "legacy-time",
			quietHoursTimezone: "Legacy/Unknown",
		},
	},
] as const;
function transport(
	reply: (id: string, attempt: number) => Response | Promise<Response>,
	list?: (count: number) => Response | Promise<Response>,
) {
	const pendingRead = held();
	const deletes: string[] = [];
	let listReads = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		if ("expectedSuccessStatus" in init) {
			violations.push("Admission option leaked to fetch");
			throw new Error("Unexpected synthetic fetch option");
		}
		if (
			method === "DELETE" &&
			init.body === undefined &&
			["rule-target", "rule-sibling", "rule-other"].some((id) => path === `${listPath}/${id}`)
		) {
			const id = path.slice(listPath.length + 1);
			deletes.push(id);
			return reply(id, deletes.length);
		}
		if (method === "GET" && init.body === undefined && path === "/api/notifications/channels")
			return json([]);
		if (method === "GET" && init.body === undefined && path === listPath) {
			listReads++;
			return list ? list(listReads) : pendingRead.promise;
		}
		violations.push(`${method} ${path}`);
		throw new Error("Unexpected synthetic rule-delete edge");
	});
	return { deletes, listReads: () => listReads };
}
function client(
	options: { retry?: number; cache?: NotificationRuleResponse[]; missingCache?: boolean } = {},
) {
	const value = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: options.retry ?? false, retryDelay: 0 },
		},
	});
	clients.push(value);
	if (!options.missingCache) value.setQueryData(notificationKeys.rules, options.cache ?? baseline);
	value.setQueryData(notificationKeys.channels, []);
	return value;
}
function mount(
	options: { retry?: number; cache?: NotificationRuleResponse[]; incognito?: boolean } = {},
) {
	if (options.incognito) localStorage.setItem("arr-dashboard-incognito-mode", "true");
	const value = client(options);
	const tree = (visible: boolean) => (
		<QueryClientProvider client={value}>
			<ColorThemeProvider>
				<IncognitoProvider>{visible ? <NotificationRulesTab /> : null}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const view = render(tree(true));
	return {
		...view,
		client: value,
		hide: () => view.rerender(tree(false)),
		show: () => view.rerender(tree(true)),
	};
}
async function row(index = 0) {
	await waitFor(() => expect(screen.getAllByTitle("Delete rule")).toHaveLength(3));
	const result = screen.getAllByTitle("Delete rule")[index]!.closest("div.rounded-xl");
	if (!(result instanceof HTMLElement)) throw new Error("Actual rule row unavailable");
	return result;
}
function confirm(region: HTMLElement) {
	fireEvent.click(within(region).getByTitle("Delete rule"));
	fireEvent.click(within(region).getByTitle("Click again to confirm"));
}
async function settled(value: QueryClient, count = 1) {
	await waitFor(() => {
		const entries = value.getMutationCache().getAll();
		expect(entries).toHaveLength(count);
		expect(["success", "error"]).toContain(entries.at(-1)?.state.status);
	});
}
function feedback() {
	return [
		...screen.queryAllByRole("alert").map((element) => element.textContent ?? ""),
		...sink.errors.flat().filter((value): value is string => typeof value === "string"),
	].join(" ");
}
async function unknownFeedback() {
	await waitFor(() =>
		expect(feedback()).toMatch(
			/delet.*(not.*verified|unverified|may.*deleted)|outcome.*(not|could not).*verif/i,
		),
	);
	expect(feedback()).not.toContain(privateDetail);
	expect(JSON.stringify(sink.errors)).not.toContain(privateDetail);
}
async function recheck() {
	fireEvent.click(
		await screen.findByRole("button", { name: /recheck.*rule.*list|recheck.*rules/i }),
	);
}
function cached(value: QueryClient) {
	return value.getQueryData(notificationKeys.rules);
}
afterEach(async () => {
	cleanup();
	await act(async () => {
		for (const release of releases.splice(0)) release();
	});
	for (const value of clients.splice(0)) value.clear();
	localStorage.removeItem("arr-dashboard-incognito-mode");
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	vi.useRealTimers();
	vi.unstubAllGlobals();
	sink.errors.splice(0);
	expect(violations.splice(0)).toEqual([]);
});

describe("actual rule DELETE client admits only route204", () => {
	it("bodyless204 never reads a promised response body", async () => {
		const response = ack();
		response.json = async () => {
			throw new Error(privateDetail);
		};
		response.text = async () => {
			throw new Error(privateDetail);
		};
		const calls = transport(() => response);
		await expect(notificationsApi.deleteRule("rule-target")).resolves.toBeUndefined();
		expect(calls.deletes).toEqual(["rule-target"]);
	});
	it("unexpected successful status is rejected before reading private body diagnostics", async () => {
		const response = json({ message: privateDetail });
		const readJson = vi.spyOn(response, "json"),
			readText = vi.spyOn(response, "text");
		transport(() => response);
		const error = await notificationsApi.deleteRule("rule-target").catch((value: unknown) => value);
		expect(error).toBeInstanceOf(Error);
		expect(readJson).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
	});
	it.each([...invalidSuccess, ...uncertain])(
		"$label cannot certify deletion or retain raw cause",
		async ({ reply }) => {
			const calls = transport(reply);
			const error = await notificationsApi
				.deleteRule("rule-target")
				.catch((value: unknown) => value);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(ApiError);
			expect((error as Error).message).toMatch(/delet.*(not.*verified|unverified)|outcome.*verif/i);
			expect((error as Error).message).not.toContain(privateDetail);
			expect(error).not.toHaveProperty("cause");
			expect(error).not.toHaveProperty("payload");
			expect(calls.deletes).toEqual(["rule-target"]);
		},
	);
	it.each([400, 401, 403, 404, 409])(
		"known%s preserves rejection/auth semantics",
		async (status) => {
			const beforeUnauthorized = getPendingUnauthorizedRevision();
			transport(() => json({ message: privateDetail }, status));
			const error = await notificationsApi
				.deleteRule("rule-target")
				.catch((value: unknown) => value);
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(status);
			if (status === 401) {
				expect(error).toBeInstanceOf(UnauthorizedError);
				expect(getPendingUnauthorizedRevision()).toBeGreaterThan(beforeUnauthorized);
			} else expect((error as ApiError).message).toBe(privateDetail);
		},
	);
});

describe("real rule confirmation and terminal mutation outcomes", () => {
	it("unconfirmed click never deletes and confirmation still expires after3seconds", async () => {
		const calls = transport(() => ack());
		mount();
		const region = await row();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fireEvent.click(within(region).getByTitle("Delete rule"));
		expect(calls.deletes).toEqual([]);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2999);
		});
		expect(within(region).getByTitle("Click again to confirm")).toBeEnabled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(within(region).getByTitle("Delete rule")).toBeEnabled();
		expect(calls.deletes).toEqual([]);
	});
	it("older row timer cannot erase a later row's still-valid confirmation", async () => {
		const calls = transport(() => ack());
		mount();
		const first = await row(),
			second = await row(1);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fireEvent.click(within(first).getByTitle("Delete rule"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		fireEvent.click(within(second).getByTitle("Delete rule"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(within(second).getByTitle("Click again to confirm")).toBeEnabled();
		fireEvent.click(within(second).getByTitle("Click again to confirm"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(calls.deletes).toEqual(["rule-sibling"]);
	});
	it("explicit second click sends selected opaque ID and pending disables overlapping confirmations", async () => {
		const write = held(),
			calls = transport(() => write.promise);
		const view = mount();
		const region = await row();
		confirm(region);
		await waitFor(() => expect(calls.deletes).toEqual(["rule-target"]));
		for (const button of screen.getAllByTitle("Delete rule")) {
			expect(button).toBeDisabled();
			fireEvent.click(button);
		}
		expect(calls.deletes).toEqual(["rule-target"]);
		await write.finish(ack());
		await settled(view.client);
	});
	it("custom mutation retry2 fully settles with only one uncertain DELETE", async () => {
		const calls = transport(uncertain[0]!.reply);
		const view = mount({ retry: 2 });
		confirm(await row());
		await settled(view.client);
		expect(calls.deletes).toEqual(["rule-target"]);
	});
	it.each([...invalidSuccess, ...uncertain])(
		"$label keeps last-known rows, generic guidance and no blind replay",
		async ({ reply }) => {
			const calls = transport(reply);
			const view = mount();
			const region = await row();
			confirm(region);
			await settled(view.client);
			expect(cached(view.client)).toEqual(baseline);
			await unknownFeedback();
			const button = within(region).getByTitle("Delete rule");
			expect(button).toBeDisabled();
			fireEvent.click(button);
			fireEvent.click(button);
			expect(calls.deletes).toEqual(["rule-target"]);
			expect(calls.listReads()).toBe(1);
		},
	);
	it.each([400, 403, 404, 409])(
		"known%s uses generic guidance and only new explicit confirmation retries",
		async (status) => {
			const calls = transport((_id, attempt) =>
				attempt === 1 ? json({ message: privateDetail }, status) : ack(),
			);
			const view = mount();
			const region = await row();
			confirm(region);
			await settled(view.client);
			expect(cached(view.client)).toEqual(baseline);
			await waitFor(() =>
				expect(feedback()).toMatch(/could not.*delet|delet.*(rejected|failed)|not.*deleted/i),
			);
			expect(feedback()).not.toContain(privateDetail);
			expect(JSON.stringify(sink.errors)).not.toContain(privateDetail);
			fireEvent.click(within(region).getByTitle("Delete rule"));
			expect(calls.deletes).toEqual(["rule-target"]);
			fireEvent.click(within(region).getByTitle("Click again to confirm"));
			await settled(view.client, 2);
			expect(calls.deletes).toEqual(["rule-target", "rule-target"]);
		},
	);
	it("incognito deletion feedback emits no private cause without redesigning preexisting rule labels", async () => {
		const calls = transport(uncertain[0]!.reply);
		const view = mount({ incognito: true });
		confirm(await row());
		await settled(view.client);
		expect(JSON.stringify(sink.errors)).not.toContain(privateDetail);
		expect(feedback()).not.toContain(privateDetail);
		await unknownFeedback();
		expect(calls.deletes).toEqual(["rule-target"]);
	});
});

describe("existing acknowledged rule DELETE cache controls", () => {
	it.each(["slow", "failed"])(
		"204 preserves exact-ID removal and order before %s reread",
		async (mode) => {
			const read = held();
			const calls = transport(
				() => ack(),
				() => (mode === "slow" ? read.promise : json({ message: privateDetail }, 503)),
			);
			const view = mount();
			const region = await row();
			confirm(region);
			await settled(view.client);
			expect(cached(view.client)).toEqual([sibling, other]);
			await waitFor(() => expect(region).not.toBeInTheDocument());
			expect(calls.deletes).toEqual(["rule-target"]);
			expect(calls.listReads()).toBe(1);
		},
	);
	it("late older GET cannot revive acknowledged target or remove its same-name sibling", async () => {
		const oldRead = held(),
			nextRead = held();
		const calls = transport(
			() => ack(),
			(count) => (count === 1 ? oldRead.promise : nextRead.promise),
		);
		const view = mount();
		const region = await row();
		void view.client.refetchQueries({ queryKey: notificationKeys.rules, exact: true });
		await waitFor(() => expect(calls.listReads()).toBe(1));
		confirm(region);
		await settled(view.client);
		await oldRead.finish(json(baseline));
		expect(cached(view.client)).toEqual([sibling, other]);
		expect(calls.deletes).toEqual(["rule-target"]);
	});
	it("204 ACK after actual Tab unmount still removes only target in shared cache", async () => {
		const write = held(),
			calls = transport(() => write.promise);
		const view = mount();
		confirm(await row());
		await waitFor(() => expect(calls.deletes).toEqual(["rule-target"]));
		view.hide();
		await write.finish(ack());
		await settled(view.client);
		expect(cached(view.client)).toEqual([sibling, other]);
		view.show();
		await waitFor(() => expect(screen.getAllByTitle("Delete rule")).toHaveLength(2));
		expect(calls.deletes).toEqual(["rule-target"]);
	});
	it("ACK does not invent baseline when no rule list is cached", async () => {
		const calls = transport(() => ack());
		const value = client({ missingCache: true });
		const hook = renderHook(() => useDeleteRule(), {
			wrapper: ({ children }) => (
				<QueryClientProvider client={value}>{children}</QueryClientProvider>
			),
		});
		await act(async () => {
			await hook.result.current.mutateAsync("rule-target");
		});
		expect(cached(value)).toBeUndefined();
		expect(calls.deletes).toEqual(["rule-target"]);
	});
});

describe("GET-only rule deletion review admits safe legacy metadata, not create policy", () => {
	it.each(legacyCases)(
		"existing legacy $action GET can render empty/null settings without applying CREATE policy",
		async ({ action, fields }) => {
			const historical = { ...target, action, ...fields };
			// Actual GET orders ascending priorities; the legacy2001 row comes last.
			const rows =
				action === "throttle" ? [sibling, other, historical] : [historical, sibling, other];
			const calls = transport(
				() => ack(),
				() => json(rows),
			);
			const view = mount();
			await act(async () => {
				await view.client.refetchQueries({ queryKey: notificationKeys.rules, exact: true });
			});
			expect(cached(view.client)).toEqual(rows);
			await waitFor(() => expect(screen.getAllByTitle("Delete rule")).toHaveLength(3));
			const region = screen
				.getAllByTitle("Delete rule")
				[action === "throttle" ? 2 : 0]!.closest("div.rounded-xl");
			if (!(region instanceof HTMLElement)) throw new Error("Actual legacy rule row unavailable");
			fireEvent.click(within(region).getByTitle("Delete rule"));
			expect(within(region).getByTitle("Click again to confirm")).toBeEnabled();
			expect(calls.deletes).toEqual([]);
			expect(calls.listReads()).toBe(1);
		},
	);
	it("automatic unknown reconciliation continues after Tab unmount without another DELETE", async () => {
		const write = held(),
			calls = transport(
				() => write.promise,
				() => json([sibling, other]),
			);
		const view = mount();
		confirm(await row());
		await waitFor(() => expect(calls.deletes).toEqual(["rule-target"]));
		view.hide();
		await write.finish(json({ message: privateDetail }, 503));
		await settled(view.client);
		await waitFor(() => expect(calls.listReads()).toBe(1));
		expect(cached(view.client)).toEqual([sibling, other]);
		expect(calls.deletes).toEqual(["rule-target"]);
	});
	it("same-name current absence never certifies earlier lost DELETE acknowledgment", async () => {
		const calls = transport(uncertain[0]!.reply, () => json([sibling, other]));
		const view = mount();
		confirm(await row());
		await settled(view.client);
		await act(async () => {
			await view.client.refetchQueries({ queryKey: notificationKeys.rules, exact: true });
		});
		expect(cached(view.client)).toEqual([sibling, other]);
		await waitFor(() => expect(screen.getAllByTitle("Delete rule")).toHaveLength(2));
		await unknownFeedback();
		expect(calls.deletes).toEqual(["rule-target"]);
	});
	it("pending and failed explicit review keeps unknown replay fenced and preserves cache", async () => {
		const read = held();
		const calls = transport(uncertain[0]!.reply, (count) =>
			count === 1 ? json({ message: privateDetail }, 503) : read.promise,
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await recheck();
		await waitFor(() => expect(calls.listReads()).toBe(2));
		expect(within(region).getByTitle("Delete rule")).toBeDisabled();
		await read.finish(json({ message: privateDetail }, 503));
		await waitFor(() => expect(feedback()).toMatch(/(could not|cannot).*verif|locked/i));
		expect(cached(view.client)).toEqual(baseline);
		expect(within(region).getByTitle("Delete rule")).toBeDisabled();
		expect(calls.deletes).toEqual(["rule-target"]);
		expect(feedback()).not.toContain(privateDetail);
	});
	it("valid current list permits only NEW manual two-click attempt with prior unknown retained", async () => {
		const calls = transport(
			(_id, attempt) => (attempt === 1 ? uncertain[0]!.reply() : ack()),
			() => json(baseline),
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await recheck();
		await waitFor(() => expect(within(region).getByTitle("Delete rule")).toBeEnabled());
		await unknownFeedback();
		expect(calls.deletes).toEqual(["rule-target"]);
		fireEvent.click(within(region).getByTitle("Delete rule"));
		expect(calls.deletes).toEqual(["rule-target"]);
		fireEvent.click(within(region).getByTitle("Click again to confirm"));
		await settled(view.client, 2);
		expect(calls.deletes).toEqual(["rule-target", "rule-target"]);
	});
	it("older automatic readback cannot clear newer unknown attempt after explicit fresh review", async () => {
		const oldRead = held(),
			newRead = held();
		const calls = transport(uncertain[0]!.reply, (count) =>
			count === 1 ? oldRead.promise : count === 2 ? json(baseline) : newRead.promise,
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await recheck();
		await waitFor(() => expect(within(region).getByTitle("Delete rule")).toBeEnabled());
		confirm(region);
		await settled(view.client, 2);
		await oldRead.finish(json(baseline));
		expect(within(region).getByTitle("Delete rule")).toBeDisabled();
		await unknownFeedback();
		expect(calls.deletes).toEqual(["rule-target", "rule-target"]);
	});
	it.each([
		{ label: "null list", rows: null },
		{ label: "object list", rows: { rules: baseline } },
		{ label: "duplicate IDs", rows: [target, { ...sibling, id: "rule-target" }, other] },
		{ label: "blank ID", rows: [{ ...target, id: " " }, sibling, other] },
		{ label: "missing ID", rows: [{ ...target, id: undefined }, sibling, other] },
		{ label: "malformed name", rows: [{ ...target, name: {} }, sibling, other] },
		{ label: "missing conditions", rows: [{ ...target, conditions: undefined }, sibling, other] },
		{ label: "object conditions", rows: [{ ...target, conditions: {} }, sibling, other] },
		{
			label: "malformed condition value",
			rows: [
				{ ...target, conditions: [{ field: "title", operator: "equals", value: {} }] },
				sibling,
				other,
			],
		},
		{ label: "unknown action", rows: [{ ...target, action: "unsupported" }, sibling, other] },
		{ label: "malformed enabled", rows: [{ ...target, enabled: "yes" }, sibling, other] },
		{ label: "malformed priority", rows: [{ ...target, priority: "high" }, sibling, other] },
		{ label: "malformed target IDs", rows: [{ ...target, targetChannelIds: [4] }, sibling, other] },
		{
			label: "malformed quiet metadata",
			rows: [{ ...target, quietHoursTimezone: {} }, sibling, other],
		},
	])("$label never publishes poison or releases unknown fence", async ({ rows }) => {
		const calls = transport(uncertain[0]!.reply, (count) =>
			count === 1 ? json({ message: privateDetail }, 503) : json(rows),
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await recheck();
		await waitFor(() => expect(calls.listReads()).toBe(2));
		await waitFor(() =>
			expect(view.client.getQueryState(notificationKeys.rules)?.fetchStatus).toBe("idle"),
		);
		expect(cached(view.client)).toEqual(baseline);
		expect(within(region).getByTitle("Delete rule")).toBeDisabled();
		expect(calls.deletes).toEqual(["rule-target"]);
		await unknownFeedback();
	});
	it.each(legacyCases)(
		"legacy $action read metadata remains intact and permits only new manual action",
		async ({ action, fields }) => {
			const historical = { ...target, action, ...fields };
			const rows =
				action === "throttle" ? [sibling, other, historical] : [historical, sibling, other];
			const calls = transport(uncertain[0]!.reply, (count) =>
				count === 1 ? json({ message: privateDetail }, 503) : json(rows),
			);
			const view = mount();
			const region = await row();
			confirm(region);
			await settled(view.client);
			await recheck();
			await waitFor(() => expect(cached(view.client)).toEqual(rows));
			await waitFor(() => expect(within(region).getByTitle("Delete rule")).toBeEnabled());
			await unknownFeedback();
			expect(calls.deletes).toEqual(["rule-target"]);
			fireEvent.click(within(region).getByTitle("Delete rule"));
			expect(calls.deletes).toEqual(["rule-target"]);
			fireEvent.click(within(region).getByTitle("Click again to confirm"));
			await settled(view.client, 2);
			expect(calls.deletes).toEqual(["rule-target", "rule-target"]);
		},
	);
});
