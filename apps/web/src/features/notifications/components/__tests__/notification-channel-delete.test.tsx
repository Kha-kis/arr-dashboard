import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../../../../../../api/src/lib/notifications/notification-dispatcher";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError, apiRequest, UnauthorizedError } from "../../../../lib/api-client/base";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../../lib/auth-session-signal";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationsTab } from "../notifications-tab";

const privateDetail = "synthetic-private-delete-detail";
type ListedChannel = NotificationChannelResponse & {
	lastSentAt: string | null;
	lastSendResult: string | null;
};
const target: ListedChannel = {
	id: "owned-target",
	name: "Same synthetic channel",
	type: "WEBHOOK",
	enabled: true,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-06T12:00:00.000Z",
	lastTestedAt: null,
	lastTestResult: null,
	lastSentAt: null,
	lastSendResult: null,
	subscriptions: ["HUNT_COMPLETED"],
};
const sibling: ListedChannel = {
	id: "owned-sibling",
	name: "Same synthetic channel",
	type: "WEBHOOK",
	enabled: false,
	createdAt: "2026-10-02T12:00:00.000Z",
	updatedAt: "2026-10-05T12:00:00.000Z",
	lastTestedAt: null,
	lastTestResult: null,
	lastSentAt: null,
	lastSendResult: null,
	subscriptions: ["BACKUP_FAILED"],
};
const other: ListedChannel = {
	id: "other-channel",
	name: "Other synthetic channel",
	type: "DISCORD",
	enabled: true,
	createdAt: "2026-10-03T12:00:00.000Z",
	updatedAt: "2026-10-04T12:00:00.000Z",
	lastTestedAt: null,
	lastTestResult: null,
	lastSentAt: null,
	lastSendResult: null,
	subscriptions: [],
};
const baseline = [target, sibling, other];
// Actual metadata registry only; no dispatcher delivery/test/provider invocation.
const catalogue = new NotificationDispatcher().getPluginManifests();
const listPath = "/api/notifications/channels";
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
	{ label: "206 body", reply: () => new Response(privateDetail, { status: 206 }) },
	{
		label: "200 invalidJSON",
		reply: () =>
			new Response(privateDetail, { status: 200, headers: { "content-type": "application/json" } }),
	},
	{
		label: "200 body read loss",
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
function transport(
	reply: (id: string, attempt: number) => Response | Promise<Response>,
	list?: (count: number) => Response | Promise<Response>,
) {
	const pendingRead = held();
	const deletes: string[] = [];
	const reads: string[] = [];
	let listReads = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		if ("expectedSuccessStatus" in init) {
			violations.push("Response admission option leaked to fetch");
			throw new Error("Unexpected synthetic fetch option");
		}
		if (
			method === "DELETE" &&
			init.body === undefined &&
			["owned-target", "owned-sibling", "other-channel"].some((id) => path === `${listPath}/${id}`)
		) {
			const id = path.slice(listPath.length + 1);
			deletes.push(id);
			return reply(id, deletes.length);
		}
		if (
			method === "GET" &&
			init.body === undefined &&
			path === "/api/notifications/channel-types"
		) {
			reads.push(path);
			return json(catalogue);
		}
		if (method === "GET" && init.body === undefined && path === listPath) {
			reads.push(path);
			listReads++;
			return list ? list(listReads) : pendingRead.promise;
		}
		violations.push(`${method} ${path}`);
		throw new Error("Unexpected synthetic DELETE request");
	});
	return { deletes, reads, listReads: () => listReads };
}
function mount(options: { retry?: number; cache?: unknown; incognito?: boolean } = {}) {
	if (options.incognito) localStorage.setItem("arr-dashboard-incognito-mode", "true");
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: options.retry ?? false, retryDelay: 0 },
		},
	});
	clients.push(client);
	client.setQueryData(
		notificationKeys.channels,
		options.cache === undefined ? baseline : options.cache,
	);
	const tree = (visible: boolean) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>{visible ? <NotificationsTab /> : null}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const view = render(tree(true));
	return {
		...view,
		client,
		hide: () => view.rerender(tree(false)),
		show: () => view.rerender(tree(true)),
	};
}
async function row(index = 0) {
	await waitFor(() => expect(screen.getAllByTitle("Delete channel")).toHaveLength(3));
	const result = screen.getAllByTitle("Delete channel")[index]!.closest("div.rounded-xl");
	if (!(result instanceof HTMLElement)) throw new Error("Actual channel row unavailable");
	return result;
}
function confirm(region: HTMLElement) {
	fireEvent.click(within(region).getByTitle("Delete channel"));
	fireEvent.click(within(region).getByTitle("Click again to confirm delete"));
}
async function settled(client: QueryClient, count = 1) {
	await waitFor(() => {
		const entries = client.getMutationCache().getAll();
		expect(entries).toHaveLength(count);
		expect(["success", "error"]).toContain(entries.at(-1)?.state.status);
	});
}
async function recheck() {
	fireEvent.click(
		await screen.findByRole("button", { name: /recheck.*channel.*list|recheck.*channels/i }),
	);
}
afterEach(async () => {
	cleanup();
	for (const release of releases.splice(0)) release();
	for (const client of clients.splice(0)) client.clear();
	localStorage.removeItem("arr-dashboard-incognito-mode");
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	vi.useRealTimers();
	vi.unstubAllGlobals();
	expect(violations.splice(0)).toEqual([]);
});

describe("actual DELETE client requires the route204 acknowledgment", () => {
	it("default transport still admits other successful responses when status opt-in is absent", async () => {
		const calls = transport(() => json({ syntheticDefault: true }));
		await expect(apiRequest(`${listPath}/owned-target`, { method: "DELETE" })).resolves.toEqual({
			syntheticDefault: true,
		});
		expect(calls.deletes).toEqual(["owned-target"]);
	});
	it("unexpected successful DELETE status rejects without consuming a private response body", async () => {
		const response = json({ message: privateDetail });
		const readJson = vi.fn(async () => ({ message: privateDetail }));
		const readText = vi.fn(async () => privateDetail);
		response.json = readJson;
		response.text = readText;
		transport(() => response);
		const error = await notificationsApi
			.deleteChannel("owned-target")
			.catch((caught: unknown) => caught);
		expect(String(error)).toMatch(/delet.*outcome.*not.*verified/i);
		expect(readJson).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
		expect(String(error)).not.toContain(privateDetail);
		expect(error).not.toHaveProperty("cause");
	});
	it("admits bodyless204 without reading a promised body", async () => {
		const response = ack();
		response.json = async () => {
			throw new Error(privateDetail);
		};
		response.text = async () => {
			throw new Error(privateDetail);
		};
		const calls = transport(() => response);
		await expect(notificationsApi.deleteChannel("owned-target")).resolves.toBeUndefined();
		expect(calls.deletes).toEqual(["owned-target"]);
		expect(calls.reads).toEqual([]);
	});
	it.each([...invalidSuccess, ...uncertain])(
		"does not certify $label and never includes private causes",
		async ({ reply }) => {
			const calls = transport(reply);
			const result = await notificationsApi.deleteChannel("owned-target").then(
				() => ({ accepted: true }),
				(error: unknown) => ({ accepted: false, error }),
			);
			expect(result.accepted).toBe(false);
			if ("error" in result) {
				expect(result.error).toBeInstanceOf(Error);
				expect(String(result.error)).toMatch(/delet.*outcome.*not.*verified/i);
				expect(String(result.error)).not.toContain(privateDetail);
				expect(result.error).not.toHaveProperty("cause");
			}
			expect(calls.deletes).toEqual(["owned-target"]);
			expect(calls.reads).toEqual([]);
		},
	);
	it.each([400, 401, 403, 404, 409])(
		"preserves known%s rejection/auth semantics",
		async (status) => {
			const calls = transport(() => json({ message: privateDetail }, status));
			const error = await notificationsApi
				.deleteChannel("owned-target")
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status });
			expect(calls.deletes).toEqual(["owned-target"]);
			if (status === 401) {
				expect(error).toBeInstanceOf(UnauthorizedError);
				expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
			}
		},
	);
});

describe("real channel row confirmation, uncertainty and retry boundaries", () => {
	it("one unconfirmed click does not delete and existing confirmation expires without mutation", async () => {
		const calls = transport(() => ack());
		mount();
		const region = await row();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fireEvent.click(within(region).getByTitle("Delete channel"));
		expect(calls.deletes).toEqual([]);
		expect(within(region).getByTitle("Click again to confirm delete")).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3001);
		});
		expect(within(region).getByTitle("Delete channel")).toBeInTheDocument();
		expect(calls.deletes).toEqual([]);
	});
	it("only explicit second click sends the ID and pending controls prevent overlapping DELETEs", async () => {
		const write = held();
		const calls = transport(() => write.promise);
		const view = mount();
		const region = await row();
		confirm(region);
		await waitFor(() => expect(calls.deletes).toEqual(["owned-target"]));
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
		for (const button of screen.getAllByTitle("Delete channel")) {
			expect(button).toBeDisabled();
			fireEvent.click(button);
			fireEvent.click(button);
		}
		expect(calls.deletes).toEqual(["owned-target"]);
		await write.finish(ack());
		await settled(view.client);
	});
	it("custom mutation retry2 reaches complete terminal state with exactly one uncertain DELETE", async () => {
		const calls = transport(uncertain[0]!.reply);
		const view = mount({ retry: 2 });
		confirm(await row());
		await settled(view.client);
		expect(calls.deletes).toEqual(["owned-target"]);
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
	});
	it.each([...invalidSuccess, ...uncertain])(
		"keeps $label unknown, last-known target retained and replay fenced",
		async ({ reply }) => {
			const calls = transport(reply);
			const view = mount();
			const region = await row();
			confirm(region);
			await settled(view.client);
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
			expect(screen.getByRole("alert")).toHaveTextContent(
				/delet.*(not.*verified|not.*confirmed|may)/i,
			);
			expect(document.body).not.toHaveTextContent(privateDetail);
			expect(calls.listReads()).toBe(1);
			const button = within(region).getByTitle("Delete channel");
			expect(button).toBeDisabled();
			fireEvent.click(button);
			fireEvent.click(button);
			await act(async () => {});
			expect(calls.deletes).toEqual(["owned-target"]);
		},
	);
	it.each([400, 403, 404, 409])(
		"known%s rejection retains row, shows generic guidance and permits new explicit confirmation",
		async (status) => {
			const calls = transport((_id, attempt) =>
				attempt === 1 ? json({ message: privateDetail }, status) : ack(),
			);
			const view = mount();
			const region = await row();
			confirm(region);
			await settled(view.client);
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
			expect(screen.getByRole("alert")).toHaveTextContent(/could not|not.*deleted|rejected/i);
			expect(document.body).not.toHaveTextContent(privateDetail);
			expect(calls.deletes).toEqual(["owned-target"]);
			expect(within(region).getByTitle("Delete channel")).toBeEnabled();
			confirm(region);
			await settled(view.client, 2);
			expect(calls.deletes).toEqual(["owned-target", "owned-target"]);
		},
	);
	it("incognito keeps names and raw error detail private while representing unknown deletion", async () => {
		const calls = transport(uncertain[0]!.reply);
		const view = mount({ incognito: true });
		confirm(await row());
		await settled(view.client);
		expect(document.body).not.toHaveTextContent("Same synthetic channel");
		expect(document.body).not.toHaveTextContent("Other synthetic channel");
		expect(document.body).not.toHaveTextContent(privateDetail);
		expect(screen.getByRole("alert")).toHaveTextContent(/delet.*(not.*verified|may)/i);
		expect(calls.deletes).toEqual(["owned-target"]);
	});
});

describe("actual Tab acknowledged deletion cache and component lifetime", () => {
	it.each(["slow", "failed"])(
		"204 removes only target before %s GET reread, preserving same-name sibling",
		async (mode) => {
			const reread = held();
			const calls = transport(
				() => ack(),
				() => (mode === "slow" ? reread.promise : json({ message: privateDetail }, 503)),
			);
			const view = mount();
			const region = await row();
			confirm(region);
			await settled(view.client);
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual([sibling, other]);
			await waitFor(() => expect(region).not.toBeInTheDocument());
			expect(calls.deletes).toEqual(["owned-target"]);
			expect(calls.listReads()).toBe(1);
		},
	);
	it("late older GET cannot resurrect a204-acknowledged removed target", async () => {
		const oldRead = held(),
			currentRead = held();
		const calls = transport(
			() => ack(),
			(count) => (count === 1 ? oldRead.promise : currentRead.promise),
		);
		const view = mount();
		const region = await row();
		void view.client.refetchQueries({ queryKey: notificationKeys.channels, exact: true });
		await waitFor(() => expect(calls.listReads()).toBe(1));
		confirm(region);
		await settled(view.client);
		await oldRead.finish(json(baseline));
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([sibling, other]);
		expect(calls.deletes).toEqual(["owned-target"]);
	});
	it("204 arriving after actual Tab unmount still removes target in the shared cache", async () => {
		const write = held();
		const calls = transport(() => write.promise);
		const view = mount();
		confirm(await row());
		await waitFor(() => expect(calls.deletes).toEqual(["owned-target"]));
		view.hide();
		await write.finish(ack());
		await settled(view.client);
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([sibling, other]);
		view.show();
		expect(screen.getAllByTitle("Delete channel")).toHaveLength(2);
		expect(calls.deletes).toEqual(["owned-target"]);
	});
	it("a same-name row readback cannot act as204 or remove another ID after lost response", async () => {
		const calls = transport(uncertain[0]!.reply, () => json([sibling, other]));
		const view = mount();
		confirm(await row());
		await settled(view.client);
		await act(async () => {
			await view.client.refetchQueries({ queryKey: notificationKeys.channels, exact: true });
		});
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([sibling, other]);
		await waitFor(() => expect(screen.getAllByTitle("Delete channel")).toHaveLength(2));
		expect(screen.getByRole("alert")).toHaveTextContent(/delet.*(not.*verified|may)/i);
		expect(calls.deletes).toEqual(["owned-target"]);
	});
});

describe("explicit list review never replays DELETE or resolves its prior outcome", () => {
	it("fresh review retains actual delivery fields, whitespace names and legacy subscription tags without certifying prior DELETE", async () => {
		const current = [
			{
				...target,
				name: " ",
				subscriptions: ["LEGACY_SYNTHETIC_TAG"],
				lastSentAt: "2026-10-06T13:00:00.000Z",
				lastSendResult: "success",
			},
			sibling,
			other,
		];
		const calls = transport(uncertain[0]!.reply, (count) =>
			count === 1 ? json({ message: privateDetail }, 503) : json(current),
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await recheck();
		await waitFor(() => expect(within(region).getByTitle("Delete channel")).toBeEnabled());
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual(current);
		expect(screen.getByRole("alert")).toHaveTextContent(/delet.*(not.*verified|may)/i);
		expect(calls.deletes).toEqual(["owned-target"]);
	});
	it.each([
		{ label: "null", rows: null },
		{ label: "object", rows: { channels: baseline } },
		{ label: "duplicate ID", rows: [target, { ...sibling, id: "owned-target" }, other] },
		{ label: "blank ID", rows: [{ ...target, id: " " }, sibling, other] },
		{ label: "missing row ID", rows: [{ ...target, id: undefined }, sibling, other] },
		{ label: "missing name", rows: [{ ...target, name: undefined }, sibling, other] },
		{
			label: "missing subscriptions",
			rows: [{ ...target, subscriptions: undefined }, sibling, other],
		},
		{ label: "invalid type", rows: [{ ...target, type: "UNSUPPORTED_SYNTHETIC" }, sibling, other] },
	])(
		"malformed successful $label recheck neither poisons last-known cache nor unfences DELETE",
		async ({ rows }) => {
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
				expect(view.client.getQueryState(notificationKeys.channels)?.fetchStatus).toBe("idle"),
			);
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
			expect(within(region).getByTitle("Delete channel")).toBeDisabled();
			fireEvent.click(within(region).getByTitle("Delete channel"));
			fireEvent.click(within(region).getByTitle("Delete channel"));
			expect(calls.deletes).toEqual(["owned-target"]);
			expect(document.body).not.toHaveTextContent(privateDetail);
		},
	);
	it("pending and failed GET-only rechecks stay fenced and retain same-name rows", async () => {
		const reread = held();
		const calls = transport(uncertain[0]!.reply, (count) =>
			count === 1 ? json({ message: privateDetail }, 503) : reread.promise,
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await waitFor(() =>
			expect(view.client.getQueryState(notificationKeys.channels)?.fetchStatus).toBe("idle"),
		);
		await recheck();
		await waitFor(() => expect(calls.listReads()).toBe(2));
		expect(within(region).getByTitle("Delete channel")).toBeDisabled();
		expect(calls.deletes).toEqual(["owned-target"]);
		await reread.finish(json({ message: privateDetail }, 503));
		await waitFor(() =>
			expect(view.client.getQueryState(notificationKeys.channels)?.fetchStatus).toBe("idle"),
		);
		expect(within(region).getByTitle("Delete channel")).toBeDisabled();
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
		expect(calls.deletes).toEqual(["owned-target"]);
	});
	it("successful explicit review of current rows permits only a NEW manual two-step attempt", async () => {
		const calls = transport(
			(_id, attempt) => (attempt === 1 ? uncertain[0]!.reply() : ack()),
			(count) => (count === 1 ? json({ message: privateDetail }, 503) : json(baseline)),
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await recheck();
		await waitFor(() => expect(within(region).getByTitle("Delete channel")).toBeEnabled());
		expect(calls.deletes).toEqual(["owned-target"]);
		expect(screen.getByRole("alert")).toHaveTextContent(/delet.*(not.*verified|may)/i);
		fireEvent.click(within(region).getByTitle("Delete channel"));
		expect(calls.deletes).toEqual(["owned-target"]);
		fireEvent.click(within(region).getByTitle("Click again to confirm delete"));
		await settled(view.client, 2);
		expect(calls.deletes).toEqual(["owned-target", "owned-target"]);
	});
	it("an older readback cannot clear newer uncertainty after a reviewed new attempt", async () => {
		const oldRead = held(),
			latestRead = held();
		const calls = transport(uncertain[0]!.reply, (count) =>
			count === 1 ? oldRead.promise : count === 2 ? json(baseline) : latestRead.promise,
		);
		const view = mount();
		const region = await row();
		confirm(region);
		await settled(view.client);
		await recheck();
		await waitFor(() => expect(within(region).getByTitle("Delete channel")).toBeEnabled());
		confirm(region);
		await settled(view.client, 2);
		await oldRead.finish(json(baseline));
		expect(within(region).getByTitle("Delete channel")).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(/delet.*(not.*verified|may)/i);
		expect(calls.deletes).toEqual(["owned-target", "owned-target"]);
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
	});
	it("automatic GET after unmount reconciles absence without issuing another DELETE", async () => {
		const reread = held();
		const calls = transport(uncertain[0]!.reply, () => reread.promise);
		const view = mount();
		confirm(await row());
		await settled(view.client);
		await waitFor(() => expect(calls.listReads()).toBe(1));
		view.hide();
		await reread.finish(json([sibling, other]));
		await waitFor(() =>
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual([sibling, other]),
		);
		expect(calls.deletes).toEqual(["owned-target"]);
	});
});
