import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationsTab } from "../notifications-tab";

const original: NotificationChannelResponse = {
	id: "owned",
	name: "First synthetic channel",
	type: "WEBHOOK",
	enabled: true,
	lastTestedAt: null,
	lastTestResult: null,
	createdAt: "2026-10-01T12:00:00Z",
	updatedAt: "2026-10-06T12:00:00Z",
	subscriptions: ["HUNT_COMPLETED"],
};
const other: NotificationChannelResponse = {
	...original,
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
const config = { url: "••••••••", method: "POST", secret: "••••••••", headers: "••••••••" };
const clients: QueryClient[] = [];
type Outcome = "network" | "server503" | "request408" | "ack";
type TestReply = { body: Record<string, unknown>; status?: number };
const passed: TestReply = { body: { success: true, statusRecorded: true } };
const rejected: TestReply = {
	body: {
		success: false,
		statusRecorded: true,
		failureCategory: "authentication",
		message: "synthetic-private-provider-detail",
	},
	status: 400,
};
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
function row(channel = original) {
	const element = screen.getByText(channel.name).closest(".rounded-xl");
	if (!element) throw Error("Synthetic channel row missing");
	return within(element as HTMLElement);
}
function fixture(options: { outcome?: Outcome; testReply?: TestReply; lateTest?: boolean } = {}) {
	const requests: Array<{ path: string; method: string; body: unknown }> = [];
	const readbacks: Array<ReturnType<typeof deferred<Response>>> = [];
	const testResponse = deferred<void>();
	const reply = options.testReply ?? passed;
	let current = { ...original };
	let replacement = false;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		requests.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (path === "/api/notifications/channels/owned/test" && method === "POST") {
			if (options.lateTest) await testResponse.promise;
			if (reply.body.statusRecorded === true)
				current = {
					...current,
					lastTestedAt: "2026-10-06T13:00:00Z",
					lastTestResult: reply.body.success === true ? "success" : "failed",
				};
			return json(reply.body, reply.status);
		}
		if (path === "/api/notifications/channels/owned" && method === "PUT") {
			// Model only public metadata of a committed replacement, not encryption/provider delivery.
			replacement = true;
			current = { ...current, lastTestedAt: null, lastTestResult: null };
			if (options.outcome === "ack") return json(current);
			if ((options.outcome ?? "network") === "network")
				throw Error("synthetic-private-lost-response");
			return json(
				{ message: "synthetic-private-save-error" },
				options.outcome === "server503" ? 503 : 408,
			);
		}
		if (method !== "GET" || init.body !== undefined) throw Error("Unexpected synthetic mutation");
		if (path === "/api/notifications/channels") {
			if (replacement && readbacks.length === 0) {
				const pending = deferred<Response>();
				readbacks.push(pending);
				return pending.promise;
			}
			return json([current, other]);
		}
		if (path === "/api/notifications/channels/owned/config")
			return json({ ...current, config, configRevision: (replacement ? "b" : "a").repeat(64) });
		if (path === "/api/notifications/channel-types") return json(definitions);
		throw Error("Unexpected synthetic read");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channels, [original, other]);
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
		async finishRead(failed = false) {
			await waitFor(() => expect(readbacks).toHaveLength(1));
			await act(async () => {
				readbacks[0]!.resolve(
					failed ? json({ message: "synthetic-private-read-error" }, 503) : json([current, other]),
				);
			});
		},
		async finishTest() {
			await act(async () => {
				testResponse.resolve();
			});
		},
	};
}
async function test(outcome: "passed" | "failed" = "passed") {
	fireEvent.click(row().getByTitle("Send test notification"));
	await waitFor(() =>
		expect(row().getByRole(outcome === "passed" ? "status" : "alert")).toHaveTextContent(
			outcome === "passed" ? /test passed/i : /authentication.*credentials/i,
		),
	);
}
async function replace() {
	fireEvent.click(row().getByTitle("Edit channel"));
	fireEvent.change(await screen.findByLabelText("Webhook URL"), {
		target: { value: "https://replacement.synthetic.invalid/hook" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Update" }));
}
function historical(outcome: RegExp, role: "status" | "alert" = "status") {
	const feedback = row().getByRole("group", { name: "Last test attempt" });
	expect(feedback).toHaveTextContent(/does not verify settings changed afterward/i);
	expect(within(feedback).getByRole(role)).toHaveTextContent(outcome);
	// Feedback must not add explanatory text inside the primary control strip.
	expect(row().getByTitle("Send test notification").parentElement).not.toContainElement(feedback);
	return feedback;
}
function explicitOnly(f: ReturnType<typeof fixture>, puts = 1) {
	expect(f.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
		"/api/notifications/channels/owned/test",
	]);
	expect(f.requests.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual(
		puts
			? [
					{
						name: original.name,
						enabled: true,
						config: { ...config, url: "https://replacement.synthetic.invalid/hook" },
						expectedRevision: "a".repeat(64),
					},
				]
			: [],
	);
	expect(f.requests.filter((r) => !["GET", "POST", "PUT"].includes(r.method))).toEqual([]);
	expect(document.body).not.toHaveTextContent("synthetic-private");
}
beforeEach(() => {
	localStorage.clear();
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("local Test history is not current saved-settings authority", () => {
	it.each(["network", "server503", "request408"] as const)(
		"prior passed Test stays historical after uncertain %s replacement and confirmed readback",
		async (outcome) => {
			const f = fixture({ outcome });
			await test();
			await waitFor(() => expect(row().getByText("Healthy")).toBeInTheDocument());
			await replace();
			await waitFor(() => expect(f.readbacks).toHaveLength(1));
			expect(screen.getByText(/last-known.*checking current settings/i)).toBeInTheDocument();
			await f.finishRead();
			await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
			expect(row().queryByText("Healthy")).not.toBeInTheDocument();
			expect(row().queryByText(/last tested:/i)).not.toBeInTheDocument();
			historical(/test passed/i);
			expect(row(other).getByText("Healthy")).toBeInTheDocument();
			expect(
				row(other).queryByRole("group", { name: "Last test attempt" }),
			).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
			explicitOnly(f);
		},
	);
	it("prior authentication failure and guidance remain historical after replacement", async () => {
		const f = fixture({ testReply: rejected });
		await test("failed");
		await replace();
		await f.finishRead();
		await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
		historical(/authentication.*credentials.*permissions/i, "alert");
		explicitOnly(f);
	});
	it("failed readback qualifies last-known healthy metadata while retaining historical Test", async () => {
		const f = fixture();
		await test();
		await waitFor(() => expect(row().getByText("Healthy")).toBeInTheDocument());
		await replace();
		await f.finishRead(true);
		await screen.findByText(/last-known.*refresh failed/i);
		expect(row().getByText("Healthy")).toBeInTheDocument();
		historical(/test passed/i);
		explicitOnly(f);
	});
	it.each([
		{
			name: "recorded success",
			reply: passed,
			role: "status",
			guidance: /test passed/i,
			badge: "Healthy",
		},
		{
			name: "unrecorded success",
			reply: { body: { success: true, statusRecorded: false } },
			role: "status",
			guidance: /test passed.*status was not saved.*do not repeat/i,
			badge: "Configured",
		},
		{
			name: "negative outcome",
			reply: { body: { success: false, statusRecorded: false, failureCategory: "timeout" } },
			role: "alert",
			guidance: /timed out.*connectivity.*status was not saved.*review current settings/i,
			badge: "Configured",
		},
		{
			name: "unrecorded authentication rejection",
			reply: { body: { ...rejected.body, statusRecorded: false }, status: 400 },
			role: "alert",
			guidance: /authentication.*credentials.*status was not saved.*review current settings/i,
			badge: "Configured",
		},
		{
			name: "uncertain server error",
			reply: { body: { message: "synthetic-private-provider-error" }, status: 500 },
			role: "alert",
			guidance:
				/outcome.*not confirmed.*may have completed.*provider.*saved test status.*before another test/i,
			badge: "Configured",
		},
	] as const)(
		"fresh $name preserves outcome/guidance without overriding server badge",
		async ({ reply, role, guidance, badge }) => {
			const f = fixture({ testReply: reply });
			fireEvent.click(row().getByTitle("Send test notification"));
			await waitFor(() => expect(row().getByRole(role)).toHaveTextContent(guidance));
			await waitFor(() => expect(row().getByText(badge)).toBeInTheDocument());
			historical(guidance, role);
			explicitOnly(f, 0);
		},
	);
	it("a confirmed save still clears matching earlier feedback without repeating Test", async () => {
		const f = fixture({ outcome: "ack" });
		await test();
		historical(/test passed/i);
		await replace();
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument(),
		);
		await f.finishRead();
		expect(row().queryByRole("group", { name: "Last test attempt" })).not.toBeInTheDocument();
		expect(row().getByText("Configured")).toBeInTheDocument();
		explicitOnly(f);
	});
	it("late unrecorded Test after uncertain replacement cannot certify new saved settings", async () => {
		const f = fixture({
			lateTest: true,
			testReply: { body: { success: true, statusRecorded: false } },
		});
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1));
		await replace();
		await f.finishRead();
		await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
		await f.finishTest();
		await waitFor(() =>
			expect(row().getByRole("status")).toHaveTextContent(/test passed.*status was not saved/i),
		);
		historical(/do not repeat the test solely to save its status/i);
		expect(row().getByText("Configured")).toBeInTheDocument();
		expect(row().queryByText("Healthy")).not.toBeInTheDocument();
		explicitOnly(f);
	});
	it("incognito retains safe historical guidance without exposing channel or transport detail", async () => {
		const f = fixture({ testReply: rejected });
		await test("failed");
		await act(async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		expect(screen.queryByText(original.name)).not.toBeInTheDocument();
		const feedback = screen.getByRole("group", { name: "Last test attempt" });
		expect(within(feedback).getByRole("alert")).toHaveTextContent(/authentication.*credentials/i);
		expect(document.body).not.toHaveTextContent("synthetic-private");
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
	});
});
