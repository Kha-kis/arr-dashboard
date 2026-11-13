import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationLogTable } from "../notification-log-table";

const firstPath = "/api/notifications/logs?page=1&limit=15";
const selectedPath = "/api/notifications/logs?page=2&limit=15&status=failed";
const firstKey = notificationKeys.logs(1, {});
const selectedKey = notificationKeys.logs(2, { status: "failed" });
const privateDetail = "synthetic-private-history-admission-detail";
// Complete literal wire DTOs. Historical nonblank tags are read metadata, not
// creation-enum inputs. Public title/body/stored failure guidance are retained.
const firstRow = {
	id: "synthetic-history-first",
	channelId: "synthetic-channel",
	channelType: "LEGACY_MAIL",
	eventType: "LEGACY_NOTICE",
	title: "Synthetic historical title",
	body: "Synthetic historical body",
	status: "historical_delivered",
	error: "Synthetic stored guidance",
	retryCount: 2,
	sentAt: "2026-10-06T12:00:00.000Z",
};
const secondRow = {
	id: "synthetic-history-second",
	channelId: "synthetic-channel",
	channelType: "DISCORD",
	eventType: "HUNT_COMPLETED",
	title: "Synthetic second title",
	body: "Synthetic second body",
	status: "sent",
	error: null,
	retryCount: 0,
	sentAt: "2026-10-05T12:00:00Z",
};
const baseline = { logs: [firstRow, secondRow], total: 30, page: 1, limit: 15 };
const selected = {
	logs: [
		{
			id: "synthetic-filtered-old",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_FAILED",
			title: "Synthetic selected known title",
			body: "Synthetic selected known body",
			status: "failed",
			error: "Synthetic selected guidance",
			retryCount: 1,
			sentAt: "2026-10-04T12:00:00Z",
		},
	],
	total: 30,
	page: 2,
	limit: 15,
};
const recovered = {
	logs: [
		{
			id: "synthetic-filtered-current",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_FAILED",
			title: "Synthetic selected current title",
			body: "Synthetic selected current body",
			status: "failed",
			error: "Synthetic current guidance",
			retryCount: 3,
			sentAt: "2026-10-06T12:00:00Z",
		},
	],
	total: 30,
	page: 2,
	limit: 15,
};
const clients: QueryClient[] = [];
const renderErrors: string[] = [];
const violations: string[] = [];

class HistoryReadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch(error: Error) {
		renderErrors.push(error.message);
	}
	override render() {
		return this.state.failed ? (
			<p role="alert">Synthetic History renderer boundary.</p>
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
function fixture(
	reply: (path: string) => Response | Promise<Response>,
	options: { seed?: boolean; mount?: boolean } = {},
) {
	const requests: Array<{ path: string; method: string }> = [];
	let currentReply = reply;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const request = { path: String(input), method: init.method ?? "GET" };
		requests.push(request);
		if (
			!request.path.startsWith("/api/notifications/logs?") ||
			request.method !== "GET" ||
			init.body !== undefined
		) {
			violations.push(`${request.method} ${request.path}`);
			throw new Error("Out-of-scope synthetic request");
		}
		return currentReply(request.path);
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
				staleTime: 30_000,
				gcTime: 300_000,
				retry: 1,
				retryDelay: 0,
				structuralSharing: true,
			},
		},
	});
	clients.push(client);
	if (options.seed) client.setQueryData(firstKey, baseline, { updatedAt: Date.now() - 1000 });
	if (options.mount !== false)
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<HistoryReadBoundary>
							<NotificationLogTable />
						</HistoryReadBoundary>
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
	return {
		client,
		requests,
		replaceReply(next: typeof reply) {
			currentReply = next;
		},
	};
}
async function settled(client: QueryClient, key: readonly unknown[] = firstKey) {
	await waitFor(() => {
		const state = client.getQueryState(key);
		expect(state?.fetchStatus).toBe("idle");
		expect(["success", "error"]).toContain(state?.status);
	});
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
function expectUnavailable(client: QueryClient, key: readonly unknown[] = firstKey) {
	expect.soft(renderErrors).toEqual([]);
	expect.soft(screen.queryByText("Synthetic History renderer boundary.")).not.toBeInTheDocument();
	expect.soft(client.getQueryState(key)?.status).toBe("error");
	expect.soft(client.getQueryData(key)).toBeUndefined();
	expect.soft(document.body).toHaveTextContent(/couldn't load notification logs/i);
	expect.soft(screen.queryByText("No notification logs yet")).not.toBeInTheDocument();
	expect.soft(screen.queryByRole("button", { name: "Try again" })).toBeInTheDocument();
	expect.soft(document.body).not.toHaveTextContent(privateDetail);
}
function expectPublicError(error: unknown) {
	expect.soft(error).toBeInstanceOf(Error);
	if (error instanceof Error) {
		expect.soft(error.message).not.toContain(privateDetail);
		expect.soft(error.cause).toBeUndefined();
		expect.soft(error).not.toHaveProperty("payload");
		expect.soft(error).not.toHaveProperty("response");
		expect.soft(JSON.stringify(error)).not.toContain(privateDetail);
	}
}
function expectReads(
	requests: Array<{ path: string; method: string }>,
	path = firstPath,
	count = 2,
) {
	expect.soft(requests).toHaveLength(count);
	for (const request of requests) expect(request).toEqual({ path, method: "GET" });
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	renderErrors.splice(0);
	expect(violations.splice(0)).toEqual([]);
});

describe("Notification History ordinary GET admission", () => {
	it("control: complete historical tags, owned content, row order and count differences remain usable", async () => {
		const { client, requests } = fixture(() => json(baseline));
		await settled(client);
		expect(client.getQueryData(firstKey)).toEqual(baseline);
		expect(screen.getByText("Synthetic historical title")).toBeInTheDocument();
		expect(screen.getByText("LEGACY_MAIL")).toBeInTheDocument();
		expect(screen.getByText("LEGACY_NOTICE")).toBeInTheDocument();
		expect(screen.getByText("historical_delivered")).toBeInTheDocument();
		expect(screen.getByText("Synthetic stored guidance")).toBeInTheDocument();
		expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
		expect(renderErrors).toEqual([]);
		expectReads(requests, firstPath, 1);
	});
	it("control: verified empty History is not a failed read", async () => {
		const { client, requests } = fixture(() => json({ logs: [], total: 0, page: 1, limit: 15 }));
		await settled(client);
		expect(client.getQueryData(firstKey)).toEqual({ logs: [], total: 0, page: 1, limit: 15 });
		expect(screen.getByText("No notification logs yet")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
		expectReads(requests, firstPath, 1);
	});
	it("control: positive-total empty History remains a legitimate retention/paging race", async () => {
		const { client, requests } = fixture(() => json({ logs: [], total: 1, page: 1, limit: 15 }));
		await settled(client);
		expect(client.getQueryState(firstKey)?.status).toBe("success");
		expect(client.getQueryData(firstKey)).toEqual({ logs: [], total: 1, page: 1, limit: 15 });
		expect(screen.getByText("No logs on this page")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
		expectReads(requests, firstPath, 1);
	});
	it.each([
		["null envelope", null],
		["nonarray logs", { logs: {}, total: 0, page: 1, limit: 15 }],
		["null row", { logs: [null], total: 1, page: 1, limit: 15 }],
		["incomplete row", { logs: [{ id: "incomplete" }], total: 1, page: 1, limit: 15 }],
		["string count", { logs: [], total: "0", page: 1, limit: 15 }],
		[
			"invalid timestamp",
			{ logs: [{ ...firstRow, sentAt: "not-a-date" }], total: 1, page: 1, limit: 15 },
		],
		["duplicate row identity", { logs: [firstRow, firstRow], total: 2, page: 1, limit: 15 }],
		["zero response limit", { logs: [], total: 0, page: 1, limit: 0 }],
		["wrong echoed page", { logs: [firstRow], total: 30, page: 2, limit: 15 }],
		["wrong echoed limit", { logs: [firstRow], total: 30, page: 1, limit: 10 }],
	] as const)("rejects successful %s before cache or renderer admission", async (_name, body) => {
		const { client, requests } = fixture(() => json(body));
		await settled(client);
		expectUnavailable(client);
		expectPublicError(client.getQueryState(firstKey)?.error);
		expectReads(requests);
	});
	it("invalid scoped refresh retains known object/time and selection; explicit retry reads that scope only", async () => {
		const { client, requests, replaceReply } = fixture(
			() =>
				json({
					logs: [
						{ ...selected.logs[0], title: "Unconfirmed History title" },
						{ id: "incomplete-refresh" },
					],
					total: 30,
					page: 2,
					limit: 15,
				}),
			{ seed: true },
		);
		client.setQueryData(
			notificationKeys.logs(1, { status: "failed" }),
			{ ...selected, page: 1 },
			{ updatedAt: Date.now() - 1000 },
		);
		client.setQueryData(selectedKey, selected, { updatedAt: Date.now() - 1000 });
		fireEvent.click(screen.getByRole("button", { name: /^Failed$/ }));
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		const prior = client.getQueryData(selectedKey);
		const updatedAt = client.getQueryState(selectedKey)?.dataUpdatedAt;
		await act(async () => {
			await client.invalidateQueries({ queryKey: selectedKey, exact: true });
		});
		await settled(client, selectedKey);
		expect.soft(client.getQueryData(selectedKey)).toBe(prior);
		expect.soft(client.getQueryState(selectedKey)?.dataUpdatedAt).toBe(updatedAt);
		expect.soft(document.body).toHaveTextContent(/last-known notification logs.*refresh failed/i);
		expect.soft(screen.queryByText("Synthetic selected known title")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Failed$/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
		replaceReply(() => json(recovered));
		const retry = screen.queryByRole("button", { name: "Try again" });
		expect.soft(retry).toBeInTheDocument();
		if (!retry) return;
		fireEvent.click(retry);
		await settled(client, selectedKey);
		expect(client.getQueryData(selectedKey)).toEqual(recovered);
		expect(screen.getByText("Synthetic selected current title")).toBeInTheDocument();
		expectReads(requests, selectedPath, 3);
	});
	it("explicit GET-only retry recovers initial invalid History without a mutation", async () => {
		const { client, requests, replaceReply } = fixture(() =>
			json({ logs: [], total: "0", page: 1, limit: 15 }),
		);
		await settled(client);
		replaceReply(() => json(baseline));
		const retry = screen.queryByRole("button", { name: "Try again" });
		expect.soft(retry).toBeInTheDocument();
		if (!retry) return;
		fireEvent.click(retry);
		await settled(client);
		expect(client.getQueryData(firstKey)).toEqual(baseline);
		expect(screen.getByText("Synthetic historical title")).toBeInTheDocument();
		expectReads(requests, firstPath, 3);
	});
	it("successful History read projects public envelope and row fields into cache", async () => {
		const { client, requests } = fixture(() =>
			json({
				...baseline,
				privateDiagnostic: privateDetail,
				logs: [
					{ ...firstRow, privateDiagnostic: privateDetail },
					{ ...secondRow, privateDiagnostic: privateDetail },
				],
			}),
		);
		await settled(client);
		expect(client.getQueryData(firstKey)).toEqual(baseline);
		expect(document.body).not.toHaveTextContent(privateDetail);
		expectReads(requests, firstPath, 1);
	});
	it("real History client returns fresh public envelope, list and row copies", async () => {
		let decoded: unknown;
		const { requests } = fixture(
			() => {
				const response = json({
					...baseline,
					privateDiagnostic: privateDetail,
					logs: [{ ...firstRow, privateDiagnostic: privateDetail }, secondRow],
				});
				const decode = response.json.bind(response);
				response.json = async () => {
					decoded = await decode();
					return decoded;
				};
				return response;
			},
			{ mount: false },
		);
		const result = await notificationsApi.getLogs(1, 15);
		expect.soft(result).toEqual(baseline);
		expect.soft(result).not.toBe(decoded);
		const raw = decoded as { logs: unknown[] };
		expect.soft(result.logs).not.toBe(raw.logs);
		expect.soft(result.logs[0]).not.toBe(raw.logs[0]);
		expectReads(requests, firstPath, 1);
	});
	it.each([
		["HTTP503", () => json({ message: privateDetail, privateDiagnostic: privateDetail }, 503)],
		["network loss", () => Promise.reject(new Error(privateDetail))],
	] as const)(
		"keeps %s diagnostics out of History read errors while permitting GET retries",
		async (_name, reply) => {
			const { client, requests } = fixture(reply);
			await settled(client);
			expectUnavailable(client);
			expectPublicError(client.getQueryState(firstKey)?.error);
			expectReads(requests);
		},
	);
});
