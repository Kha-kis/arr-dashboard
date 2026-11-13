import type { AggregationConfigResponse, NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { AggregationConfig } from "../aggregation-config";
import { NotificationsTab } from "../notifications-tab";

// Browser permission/enrollment is a separate action boundary. Settings queries,
// mutations, API serialization, providers and both components remain real.
vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const original: AggregationConfigResponse = {
	eventType: "HUNT_CONTENT_FOUND",
	windowSeconds: 300,
	maxBatchSize: 10,
	enabled: true,
};
const channel: NotificationChannelResponse = {
	id: "synthetic-channel",
	name: "Synthetic channel",
	type: "DISCORD",
	enabled: true,
	lastTestedAt: null,
	lastTestResult: null,
	createdAt: "2026-10-06T00:00:00Z",
	updatedAt: "2026-10-06T00:00:00Z",
	subscriptions: [],
};
const privateError = "synthetic-private-provider-detail";
const clients: QueryClient[] = [];

function client() {
	const value = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(value);
	return value;
}

function mount(ui: React.ReactNode, queryClient: QueryClient) {
	return render(
		<QueryClientProvider client={queryClient}>
			<ColorThemeProvider>
				<IncognitoProvider>{ui}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function aggregationRow(label = "Hunt: Content Found") {
	const row = screen.getByText(label).parentElement?.parentElement;
	if (!row) throw new Error("Missing aggregation row");
	return within(row);
}

function seedAggregation(queryClient: QueryClient) {
	queryClient.setQueryData(notificationKeys.aggregation, [{ ...original }]);
}

afterEach(() => {
	cleanup();
	for (const value of clients.splice(0)) value.clear();
	vi.unstubAllGlobals();
});

describe("Notifications settings: real hook and API transport recovery", () => {
	it("persists disabling an existing aggregation row, sending only that explicit edit", async () => {
		let saved = [{ ...original }];
		const writes: unknown[] = [];
		vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
			expect(path).toBe("/api/notifications/aggregation");
			if (options.method === "PUT") {
				const body = JSON.parse(String(options.body));
				writes.push(body);
				saved = body.configs;
				return json({ success: true });
			}
			return json(saved);
		});
		const queryClient = client();
		seedAggregation(queryClient);
		mount(<AggregationConfig />, queryClient);
		fireEvent.click(aggregationRow().getByRole("button"));
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes).toEqual([
			{
				configs: [
					{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: false },
				],
			},
		]);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument(),
		);
		expect(saved).toEqual([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: false },
		]);
	});

	it("preserves an edited row on refetch while adopting changes to untouched rows", async () => {
		vi.stubGlobal("fetch", async () =>
			json([
				{ ...original, windowSeconds: 120 },
				{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: true },
			]),
		);
		const queryClient = client();
		seedAggregation(queryClient);
		mount(<AggregationConfig />, queryClient);
		fireEvent.change(aggregationRow().getByRole("combobox"), { target: { value: "600" } });
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: notificationKeys.aggregation });
		});
		await waitFor(() =>
			expect(aggregationRow("Security: Login Failed").getByRole("combobox")).toHaveValue("60"),
		);
		expect(aggregationRow().getByRole("combobox")).toHaveValue("600");
		expect(aggregationRow("Security: Login Failed").getByRole("combobox")).toHaveValue("60");
		expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
	});

	it("keeps a known rejected save draft, reports a generic error and permits the same retry", async () => {
		let fail = true;
		const writes: unknown[] = [];
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes.push(JSON.parse(String(options.body)));
				return fail ? json({ error: privateError }, 400) : json({ success: true });
			}
			return json([{ ...original, windowSeconds: 600 }]);
		});
		const queryClient = client();
		seedAggregation(queryClient);
		mount(<AggregationConfig />, queryClient);
		fireEvent.change(aggregationRow().getByRole("combobox"), { target: { value: "600" } });
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() =>
			expect(screen.getByText(/couldn't save.*aggregation/i)).toBeInTheDocument(),
		);
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
		expect(aggregationRow().getByRole("combobox")).toHaveValue("600");
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument(),
		);
		expect(writes).toEqual([
			{
				configs: [
					{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 600, maxBatchSize: 10, enabled: true },
				],
			},
			{
				configs: [
					{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 600, maxBatchSize: 10, enabled: true },
				],
			},
		]);
		expect(screen.queryByText(/couldn't save.*aggregation/i)).not.toBeInTheDocument();
	});

	it("locks draft controls during save so later edits cannot be discarded by its acknowledgment", async () => {
		let finish: (() => void) | undefined;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return json({ success: true });
			}
			return json([{ ...original, windowSeconds: 600 }]);
		});
		const queryClient = client();
		seedAggregation(queryClient);
		mount(<AggregationConfig />, queryClient);
		fireEvent.change(aggregationRow().getByRole("combobox"), { target: { value: "600" } });
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		try {
			await waitFor(() => expect(finish).toBeDefined());
			expect(aggregationRow().getByRole("button")).toBeDisabled();
			expect(aggregationRow().getByRole("combobox")).toBeDisabled();
			expect(aggregationRow().getByRole("spinbutton")).toBeDisabled();
		} finally {
			await act(async () => {
				finish?.();
			});
		}
	});

	it("retains an acknowledged save if its subsequent read fails, including after remount", async () => {
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) =>
			options.method === "PUT" ? json({ success: true }) : json({ error: privateError }, 503),
		);
		const queryClient = client();
		seedAggregation(queryClient);
		const view = mount(<AggregationConfig />, queryClient);
		fireEvent.click(aggregationRow().getByRole("button"));
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() =>
			expect(queryClient.getQueryState(notificationKeys.aggregation)?.status).toBe("error"),
		);
		expect(queryClient.getQueryData(notificationKeys.aggregation)).toEqual([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: false },
		]);
		view.unmount();
		mount(<AggregationConfig />, queryClient);
		expect(aggregationRow().queryByRole("combobox")).not.toBeInTheDocument();
		expect(screen.getByText(/last-known.*aggregation.*refresh failed/i)).toBeInTheDocument();
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
	});

	it("distinguishes a failed channel read from a confirmed empty list and recovers via retry", async () => {
		let fail = true;
		vi.stubGlobal("fetch", async (path: string) => {
			expect(path).toBe("/api/notifications/channels");
			return fail ? json({ error: privateError }, 503) : json([]);
		});
		const queryClient = client();
		queryClient.setQueryData(notificationKeys.channelTypes, []);
		mount(<NotificationsTab />, queryClient);
		await waitFor(() =>
			expect(queryClient.getQueryState(notificationKeys.channels)?.status).toBe("error"),
		);
		expect(screen.queryByText(/no notification channels configured/i)).not.toBeInTheDocument();
		expect(screen.getByText(/couldn't load notification channels/i)).toBeInTheDocument();
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry.*channels/i }));
		await waitFor(() =>
			expect(screen.getByText(/no notification channels configured/i)).toBeInTheDocument(),
		);
		expect(screen.queryByText(/couldn't load notification channels/i)).not.toBeInTheDocument();
	});

	it("marks retained channel rows last-known on read failure and replaces them on recovery", async () => {
		let fail = true;
		vi.stubGlobal("fetch", async (path: string) => {
			expect(path).toBe("/api/notifications/channels");
			return fail
				? json({ error: privateError }, 503)
				: json([{ ...channel, name: "Recovered synthetic channel" }]);
		});
		const queryClient = client();
		queryClient.setQueryData(notificationKeys.channels, [channel]);
		queryClient.setQueryData(notificationKeys.channelTypes, []);
		mount(<NotificationsTab />, queryClient);
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: notificationKeys.channels });
		});
		expect(screen.getByText("Synthetic channel")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByText(/last-known.*channels.*refresh failed/i)).toBeInTheDocument(),
		);
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry.*channels/i }));
		await waitFor(() =>
			expect(screen.getByText("Recovered synthetic channel")).toBeInTheDocument(),
		);
		expect(screen.queryByText("Synthetic channel")).not.toBeInTheDocument();
		expect(screen.queryByText(/last-known.*channels.*refresh failed/i)).not.toBeInTheDocument();
	});

	it("renders bounded initial aggregation loading, then an unavailable state, then a confirmed empty configuration", async () => {
		let finish: (() => void) | undefined;
		let fail = true;
		vi.stubGlobal("fetch", async (path: string) => {
			expect(path).toBe("/api/notifications/aggregation");
			if (fail) {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return json({ error: privateError }, 503);
			}
			return json([]);
		});
		const queryClient = client();
		mount(<AggregationConfig />, queryClient);
		expect(screen.getByRole("status", { name: /loading aggregation/i })).toBeInTheDocument();
		expect(screen.queryByText("Hunt: Content Found")).not.toBeInTheDocument();
		await act(async () => {
			finish?.();
		});
		await waitFor(() =>
			expect(screen.getByText(/couldn't load.*aggregation settings/i)).toBeInTheDocument(),
		);
		expect(screen.queryByText("Hunt: Content Found")).not.toBeInTheDocument();
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry aggregation/i }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Aggregate Hunt: Content Found" })).toHaveAttribute(
				"aria-pressed",
				"false",
			),
		);
		expect(screen.queryByText(/couldn't load.*aggregation settings/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
	});

	it("keeps draft and last-known rows through failed aggregation refresh and recovers untouched settings", async () => {
		let fail = true;
		vi.stubGlobal("fetch", async () =>
			fail
				? json({ error: privateError }, 503)
				: json([
						{ ...original, windowSeconds: 120 },
						{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: true },
					]),
		);
		const queryClient = client();
		seedAggregation(queryClient);
		mount(<AggregationConfig />, queryClient);
		fireEvent.change(aggregationRow().getByRole("combobox"), { target: { value: "600" } });
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: notificationKeys.aggregation });
		});
		await waitFor(() =>
			expect(screen.getByText(/last-known.*aggregation.*refresh failed/i)).toBeInTheDocument(),
		);
		expect(aggregationRow().getByRole("combobox")).toHaveValue("600");
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry aggregation/i }));
		await waitFor(() =>
			expect(aggregationRow("Security: Login Failed").getByRole("combobox")).toHaveValue("60"),
		);
		expect(aggregationRow().getByRole("combobox")).toHaveValue("600");
		expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
		expect(screen.queryByText(/last-known.*aggregation.*refresh failed/i)).not.toBeInTheDocument();
	});

	it("updates only edited rows in the acknowledged cache and leaves undisplayed saved events unchanged", async () => {
		const undisplayed = {
			eventType: "BACKUP_FAILED",
			windowSeconds: 900,
			maxBatchSize: 3,
			enabled: true,
		} as const;
		const writes: unknown[] = [];
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes.push(JSON.parse(String(options.body)));
				return json({ success: true });
			}
			return json({ error: privateError }, 503);
		});
		const queryClient = client();
		queryClient.setQueryData(notificationKeys.aggregation, [original, undisplayed]);
		mount(<AggregationConfig />, queryClient);
		fireEvent.click(aggregationRow().getByRole("button"));
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument(),
		);
		expect(writes).toEqual([
			{
				configs: [
					{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: false },
				],
			},
		]);
		expect(queryClient.getQueryData(notificationKeys.aggregation)).toEqual([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: false },
			{ eventType: "BACKUP_FAILED", windowSeconds: 900, maxBatchSize: 3, enabled: true },
		]);
	});

	it("unlocks after write acknowledgment without waiting for a slow follow-up read", async () => {
		let finishRead: (() => void) | undefined;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") return json({ success: true });
			await new Promise<void>((resolve) => {
				finishRead = resolve;
			});
			return json([{ ...original, enabled: false }]);
		});
		const queryClient = client();
		seedAggregation(queryClient);
		mount(<AggregationConfig />, queryClient);
		fireEvent.click(aggregationRow().getByRole("button"));
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		try {
			await waitFor(() => expect(finishRead).toBeDefined());
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument(),
			);
			expect(aggregationRow().getByRole("button")).not.toBeDisabled();
			expect(queryClient.getQueryData(notificationKeys.aggregation)).toEqual([
				{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: false },
			]);
		} finally {
			await act(async () => {
				finishRead?.();
			});
		}
	});
});
