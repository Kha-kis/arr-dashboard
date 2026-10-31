import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError, UnauthorizedError } from "../../../../lib/api-client/base";
import {
	NotificationTestUnverifiedError,
	notificationsApi,
} from "../../../../lib/api-client/notifications";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../../lib/auth-session-signal";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationsTab } from "../notifications-tab";

const channel: NotificationChannelResponse = {
	id: "owned",
	name: "Synthetic owned channel",
	type: "WEBHOOK",
	enabled: true,
	lastTestedAt: null,
	lastTestResult: null,
	createdAt: "2026-10-01T12:00:00Z",
	updatedAt: "2026-10-06T12:00:00Z",
	subscriptions: ["HUNT_COMPLETED"],
};
const other: NotificationChannelResponse = {
	...channel,
	id: "other",
	name: "Other synthetic channel",
	lastTestedAt: "2026-10-02T12:00:00Z",
	lastTestResult: "success",
};
const definitions = [
	{
		type: "WEBHOOK",
		label: "Webhook",
		icon: "Globe",
		formFields: [
			{ key: "url", label: "Webhook URL", type: "url", required: true },
			{ key: "method", label: "HTTP Method", type: "text", placeholder: "POST" },
			{ key: "secret", label: "Signing Secret", type: "password" },
			{ key: "headers", label: "Custom Headers", type: "headers" },
		],
	},
];
const clients: QueryClient[] = [];
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const uncertain = [
	{
		name: "network response loss",
		respond: () => {
			throw Error("synthetic-private-network-detail");
		},
	},
	{ name: "server503", respond: () => json({ message: "synthetic-private-server-detail" }, 503) },
	{ name: "request408", respond: () => json({ message: "synthetic-private-request-detail" }, 408) },
	{ name: "server500", respond: () => json({ message: "synthetic-private-server-detail" }, 500) },
	{ name: "null200", respond: () => json(null) },
	{
		name: "missing outcome200",
		respond: () => json({ message: "synthetic-private-missing-outcome" }),
	},
	{ name: "invalid positive200", respond: () => json({ success: "true", statusRecorded: true }) },
	{
		name: "invalid JSON200",
		respond: () =>
			new Response("synthetic-private-invalid-json", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	},
	{
		name: "bodyless200",
		respond: () =>
			new Response(null, { status: 200, headers: { "Content-Type": "application/json" } }),
	},
	{
		name: "body read loss200",
		respond: () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(Error("synthetic-private-body-read"));
					},
				}),
				{ status: 200, headers: { "Content-Type": "text/plain" } },
			),
	},
];
function row(value = channel) {
	const element = screen.getByText(value.name).closest(".rounded-xl");
	if (!element) throw Error("Synthetic row missing");
	return within(element as HTMLElement);
}
function fixture(
	respond: () => Response,
	options: { retry?: number; commit?: boolean; recordedFailure?: boolean } = {},
) {
	const requests: Array<{ path: string; method: string; body: unknown }> = [];
	const readbacks: Array<ReturnType<typeof deferred<Response>>> = [];
	let current = { ...channel };
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		requests.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (path === "/api/notifications/channels/owned/test" && method === "POST") {
			// Synthetic public post-completion status, not a real provider send or server commit.
			if (options.commit ?? true)
				current = {
					...current,
					lastTestedAt: "2026-10-06T13:00:00Z",
					lastTestResult: options.recordedFailure ? "failed" : "success",
				};
			return respond();
		}
		if (method !== "GET" || init.body !== undefined) throw Error("Unexpected synthetic mutation");
		if (path === "/api/notifications/channels") {
			const pending = deferred<Response>();
			readbacks.push(pending);
			return pending.promise;
		}
		if (path === "/api/notifications/channel-types") return json(definitions);
		throw Error("Unexpected synthetic read");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: options.retry ?? false, retryDelay: 0 },
		},
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channels, [channel, other]);
	client.setQueryData(notificationKeys.channelTypes, definitions);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationsTab />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		requests,
		readbacks,
		client,
		async finishRead(failed = false, index = 0) {
			await waitFor(() => expect(readbacks.length).toBeGreaterThan(index));
			await act(async () => {
				readbacks[index]!.resolve(
					failed ? json({ message: "synthetic-private-read-error" }, 503) : json([current, other]),
				);
			});
		},
	};
}
function assertUncertain() {
	const feedback = row().getByRole("group", { name: "Last test attempt" });
	const alert = within(feedback).getByRole("alert");
	expect(alert).toHaveTextContent(/outcome.*not confirmed/i);
	expect(alert).toHaveTextContent(/may have completed/i);
	expect(alert).toHaveTextContent(/check.*provider.*saved.*status.*before.*another test/i);
	expect(alert).not.toHaveTextContent(/test did not complete|test failed|test passed|sent!|retry/i);
	expect(row().queryByRole("status")).not.toBeInTheDocument();
	expect(row(other).queryByRole("group", { name: "Last test attempt" })).not.toBeInTheDocument();
	expect(document.body).not.toHaveTextContent("synthetic-private");
}
function assertSinglePost(f: ReturnType<typeof fixture>, count = 1) {
	expect(f.requests.filter((r) => r.method !== "GET")).toEqual(
		Array.from({ length: count }, () => ({
			path: "/api/notifications/channels/owned/test",
			method: "POST",
			body: {},
		})),
	);
}
beforeEach(() => {
	localStorage.clear();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
});

describe("actual mounted notification Test uncertainty and read-only recovery", () => {
	it.each(uncertain)(
		"completed Test with $name never invents failure or an acknowledgment",
		async ({ respond }) => {
			const f = fixture(respond);
			fireEvent.click(row().getByTitle("Send test notification"));
			await waitFor(() => expect(f.readbacks).toHaveLength(1));
			assertUncertain();
			expect(screen.getByText(/last-known.*checking current settings/i)).toBeInTheDocument();
			expect(row().getByText("Configured")).toBeInTheDocument();
			await f.finishRead();
			await waitFor(() => expect(row().getByText("Healthy")).toBeInTheDocument());
			assertUncertain();
			expect(row(other).getByText("Healthy")).toBeInTheDocument();
			assertSinglePost(f);
		},
	);
	it("failed reread retains qualified last-known metadata and never retries Test", async () => {
		const f = fixture(uncertain[0]!.respond);
		fireEvent.click(row().getByTitle("Send test notification"));
		await f.finishRead(true);
		await screen.findByText(/last-known.*refresh failed/i);
		assertUncertain();
		expect(row().getByText("Configured")).toBeInTheDocument();
		assertSinglePost(f);
		fireEvent.click(screen.getByRole("button", { name: "Retry notification channels" }));
		await f.finishRead(false, 1);
		await waitFor(() => expect(row().getByText("Healthy")).toBeInTheDocument());
		assertUncertain();
		assertSinglePost(f);
	});
	it("local no-retry policy prevents duplicate Test POST despite global mutation retry2", async () => {
		const f = fixture(uncertain[0]!.respond, { retry: 2 });
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByRole("alert")).toBeInTheDocument());
		expect(f.client.isMutating()).toBe(0);
		assertSinglePost(f);
		assertUncertain();
		await f.finishRead();
	});
	it("another Test is a deliberate operator action after checking readback, never automatic replay", async () => {
		let attempts = 0;
		const f = fixture(() =>
			++attempts === 1 ? uncertain[0]!.respond() : json({ success: true, statusRecorded: true }),
		);
		fireEvent.click(row().getByTitle("Send test notification"));
		await f.finishRead();
		await waitFor(() => expect(row().getByText("Healthy")).toBeInTheDocument());
		assertUncertain();
		assertSinglePost(f);
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByRole("status")).toHaveTextContent(/test passed/i));
		await f.finishRead(false, 1);
		assertSinglePost(f, 2);
	});
	it.each([
		{ status: 400, body: null },
		{ status: 400, body: { failureCategory: "invented", message: "synthetic-private-unknown" } },
		{
			status: 400,
			body: {
				failureCategory: "unknown",
				statusRecorded: false,
				message: "synthetic-private-unknown",
			},
		},
		{ status: 403, body: { message: "synthetic-private-forbidden" } },
	])(
		"unknown or uncategorized rejection remains honest and private: %#",
		async ({ status, body }) => {
			const f = fixture(() => json(body, status), { commit: false });
			fireEvent.click(row().getByTitle("Send test notification"));
			await f.finishRead();
			assertUncertain();
			expect(row().getByText("Configured")).toBeInTheDocument();
			assertSinglePost(f);
		},
	);
	it("known authentication failure retains actionable and unsaved-status guidance", async () => {
		const f = fixture(
			() =>
				json(
					{
						success: false,
						statusRecorded: false,
						failureCategory: "authentication",
						message: "synthetic-private-provider",
					},
					400,
				),
			{ commit: false },
		);
		fireEvent.click(row().getByTitle("Send test notification"));
		await f.finishRead();
		expect(row().getByRole("alert")).toHaveTextContent(
			/authentication.*credentials.*permissions.*status was not saved/i,
		);
		expect(row().getByRole("alert")).not.toHaveTextContent(/may have completed/i);
		expect(row(other).queryByRole("alert")).not.toBeInTheDocument();
		expect(document.body).not.toHaveTextContent("synthetic-private");
		assertSinglePost(f);
	});
	it.each([
		{
			name: "recorded success",
			result: { success: true, statusRecorded: true },
			commit: true,
			failure: false,
			badge: "Healthy",
			role: "status",
			guidance: /test passed/i,
		},
		{
			name: "legacy unrecorded success",
			result: { success: true },
			commit: false,
			failure: false,
			badge: "Configured",
			role: "status",
			guidance: /test passed.*not saved.*do not repeat/i,
		},
		{
			name: "negative controlled result",
			result: { success: false, statusRecorded: true, failureCategory: "timeout" },
			commit: true,
			failure: true,
			badge: "Offline",
			role: "alert",
			guidance: /timed out.*connectivity/i,
		},
	] as const)(
		"admitted $name preserves projection and server-only badge authority",
		async ({ result, commit, failure, badge, role, guidance }) => {
			const f = fixture(() => json({ ...result, config: "synthetic-private-extra-data" }), {
				commit,
				recordedFailure: failure,
			});
			fireEvent.click(row().getByTitle("Send test notification"));
			await f.finishRead();
			await waitFor(() => expect(row().getByRole(role)).toHaveTextContent(guidance));
			expect(row().getByText(badge)).toBeInTheDocument();
			expect(document.body).not.toHaveTextContent("synthetic-private");
			assertSinglePost(f);
		},
	);
});

describe("Test client uncertainty normalization preserves known rejection semantics", () => {
	it.each(uncertain)(
		"$name has generic custom uncertainty without raw cause",
		async ({ respond }) => {
			vi.stubGlobal("fetch", async () => respond());
			let error: unknown;
			try {
				await notificationsApi.testChannel("owned");
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(NotificationTestUnverifiedError);
			expect((error as Error).name).toBe("NotificationTestUnverifiedError");
			expect((error as Error).message).toMatch(/outcome.*could not be verified/i);
			expect((error as Error).message).not.toMatch(/synthetic-private/);
			expect(error).not.toHaveProperty("cause");
		},
	);
	it.each([400, 401, 403, 404, 409, 429])(
		"known%s retains status, payload and auth signaling",
		async (status) => {
			const payload = {
				success: false,
				failureCategory: "configuration",
				statusRecorded: false,
				code: "SYNTHETIC_REJECTION",
				message: "synthetic-private-rejection",
			};
			vi.stubGlobal("fetch", async () => json(payload, status));
			let error: unknown;
			try {
				await notificationsApi.testChannel("owned");
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(status);
			if (status === 401) {
				expect(error).toBeInstanceOf(UnauthorizedError);
				expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
			} else expect((error as ApiError).payload).toEqual(payload);
		},
	);
});
