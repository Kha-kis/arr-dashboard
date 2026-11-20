import type { NotificationChannelResponse } from "@arr/shared";
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
import { useUpdateChannel } from "../../../../hooks/api/useNotifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationsTab } from "../notifications-tab";

vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const original: NotificationChannelResponse & { lastSentAt: string; lastSendResult: string } = {
	id: "first-channel",
	name: "Synthetic channel",
	type: "DISCORD",
	enabled: true,
	lastTestedAt: "2026-01-01T00:00:00.000Z",
	lastTestResult: "success",
	lastSentAt: "2026-01-02T00:00:00.000Z",
	lastSendResult: "success",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	subscriptions: ["SYSTEM_ERROR"],
};
const other: NotificationChannelResponse = {
	...original,
	id: "other-channel",
	name: "Other synthetic channel",
	lastTestResult: "failed",
};
const types = [
	{
		type: "DISCORD",
		label: "Discord",
		icon: "Hash",
		formFields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
	},
];
const clients: QueryClient[] = [];

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mount(
	options: { read?: "pending" | "failed"; saveFailure?: boolean; equivalent?: boolean } = {},
) {
	const { lastSentAt: _lastSentAt, lastSendResult: _lastSendResult, ...responseFields } = original;
	const acknowledged: NotificationChannelResponse = {
		...responseFields,
		name: "Acknowledged synthetic name",
		lastTestedAt: options.equivalent ? original.lastTestedAt : null,
		lastTestResult: options.equivalent ? original.lastTestResult : null,
		updatedAt: "2026-02-01T00:00:00.000Z",
	};
	let current: NotificationChannelResponse = original;
	const writes: unknown[] = [];
	const reads: Array<{
		snapshot: NotificationChannelResponse[];
		resolve: (response: Response) => void;
	}> = [];
	let failedReads = 0;
	let posts = 0;
	vi.stubGlobal("fetch", async (path: string, request: RequestInit = {}) => {
		if (request.method === "PUT") {
			expect(path).toBe("/api/notifications/channels/first-channel");
			writes.push(JSON.parse(String(request.body)));
			if (options.saveFailure) return json({ message: "synthetic-private-error" }, 409);
			current = acknowledged;
			return json(acknowledged);
		}
		if (request.method === "POST") posts++;
		if (path.endsWith("/config"))
			return json({
				...current,
				configRevision: "a".repeat(64),
				config: { webhookUrl: "••••••••" },
			});
		expect(path).toBe("/api/notifications/channels");
		if (options.read === "failed") {
			failedReads++;
			return json({ message: "synthetic-private-read-error" }, 503);
		}
		if (options.read === "pending")
			return new Promise<Response>((resolve) =>
				reads.push({ snapshot: [current, other], resolve }),
			);
		return json([current, other]);
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channels, [original, other]);
	client.setQueryData(notificationKeys.channelTypes, types);
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
		client,
		acknowledged,
		writes,
		reads,
		get failedReads() {
			return failedReads;
		},
		get posts() {
			return posts;
		},
		async releaseRead(index: number, rows?: NotificationChannelResponse[]) {
			const read = reads[index];
			if (!read) throw new Error("Synthetic read not admitted");
			await act(async () => read.resolve(json(rows ?? read.snapshot)));
		},
	};
}

async function save(equivalent = false) {
	fireEvent.click(screen.getAllByTitle("Edit channel")[0]!);
	await screen.findByLabelText("Webhook URL");
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "Acknowledged synthetic name" },
	});
	if (!equivalent)
		fireEvent.change(screen.getByLabelText("Webhook URL"), {
			target: { value: "https://synthetic.invalid/replacement" },
		});
	fireEvent.click(screen.getByRole("button", { name: "Update" }));
}

function cached(client: QueryClient) {
	return client.getQueryData<NotificationChannelResponse[]>(notificationKeys.channels)!;
}

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

describe("acknowledged notification settings survive independent list revalidation", () => {
	it.each(["pending", "failed"] as const)(
		"publishes saved metadata and cleared Test proof when reread is %s",
		async (read) => {
			const fixture = mount({ read });
			await save();
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument(),
			);
			await waitFor(() =>
				expect(screen.getByText("Acknowledged synthetic name")).toBeInTheDocument(),
			);
			const row = within(
				screen.getByText("Acknowledged synthetic name").closest(".rounded-xl") as HTMLElement,
			);
			expect(row.getByText("Configured")).toBeInTheDocument();
			expect(row.queryByText("Healthy")).not.toBeInTheDocument();
			expect(cached(fixture.client)[0]).toEqual({ ...original, ...fixture.acknowledged });
			expect(cached(fixture.client)[1]).toEqual(other);
			expect(fixture.writes).toHaveLength(1);
			expect(fixture.posts).toBe(0);
			if (read === "failed") {
				await waitFor(() => expect(fixture.failedReads).toBe(1));
				expect(screen.getByRole("alert")).toHaveTextContent(/last-known.*refresh failed/i);
				expect(screen.queryByText("synthetic-private-read-error")).not.toBeInTheDocument();
			}
		},
	);

	it("preserves equivalent settings' verified Test and omitted last-send evidence after failed reread", async () => {
		const fixture = mount({ read: "failed", equivalent: true });
		await save(true);
		await waitFor(() =>
			expect(screen.getByText("Acknowledged synthetic name")).toBeInTheDocument(),
		);
		expect(cached(fixture.client)[0]).toEqual({ ...original, ...fixture.acknowledged });
		expect(cached(fixture.client)[0]?.lastTestResult).toBe("success");
		expect(fixture.writes).toHaveLength(1);
		expect(fixture.posts).toBe(0);
	});

	it("an older in-flight list cannot replace acknowledged settings; a new read can publish newer evidence", async () => {
		const fixture = mount({ read: "pending" });
		act(() => {
			void fixture.client.refetchQueries({ queryKey: notificationKeys.channels });
		});
		await waitFor(() => expect(fixture.reads).toHaveLength(1));
		await save();
		await waitFor(() => expect(fixture.reads).toHaveLength(2));
		await waitFor(() => expect(cached(fixture.client)[0]?.lastTestResult).toBeNull());
		await fixture.releaseRead(0);
		expect(cached(fixture.client)[0]?.name).toBe("Acknowledged synthetic name");
		expect(cached(fixture.client)[0]?.lastTestResult).toBeNull();
		const newer = {
			...fixture.acknowledged,
			lastTestedAt: "2026-02-02T00:00:00.000Z",
			lastTestResult: "success",
		};
		await fixture.releaseRead(1, [newer, other]);
		await waitFor(() => expect(cached(fixture.client)[0]).toEqual(newer));
		expect(fixture.writes).toHaveLength(1);
		expect(fixture.posts).toBe(0);
	});

	it("failed settings write preserves confirmed cached data and the unsaved editor", async () => {
		const fixture = mount({ read: "failed", saveFailure: true });
		await save();
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/i));
		expect(cached(fixture.client)).toEqual([original, other]);
		expect(screen.getByLabelText("Name")).toHaveValue("Acknowledged synthetic name");
		expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
		expect(fixture.failedReads).toBe(0);
		expect(fixture.writes).toHaveLength(1);
		expect(fixture.posts).toBe(0);
	});

	it.each(["missing list", "missing target", "different response id"] as const)(
		"does not invent a partial list or alter another channel: %s",
		async (scenario) => {
			const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
			clients.push(client);
			const previous =
				scenario === "missing list"
					? undefined
					: scenario === "missing target"
						? [other]
						: [original, other];
			if (previous) client.setQueryData(notificationKeys.channels, previous);
			const reply = {
				...original,
				id: scenario === "different response id" ? other.id : original.id,
				name: "Acknowledged synthetic name",
				lastTestedAt: null,
				lastTestResult: null,
			};
			vi.stubGlobal("fetch", async (path: string, request: RequestInit) => {
				expect(path).toBe("/api/notifications/channels/first-channel");
				expect(request.method).toBe("PUT");
				return json(reply);
			});
			const { result } = renderHook(() => useUpdateChannel(), {
				wrapper: ({ children }) => (
					<QueryClientProvider client={client}>{children}</QueryClientProvider>
				),
			});
			await act(async () => {
				const update = result.current.mutateAsync({
					id: original.id,
					data: { name: "Acknowledged synthetic name" },
				});
				if (scenario === "different response id") {
					await expect(update).rejects.toThrow(/outcome.*not.*verified/i);
				} else {
					await update;
				}
			});
			expect(client.getQueryData(notificationKeys.channels)).toEqual(previous);
		},
	);
});
