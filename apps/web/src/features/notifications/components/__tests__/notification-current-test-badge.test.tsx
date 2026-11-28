import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationsTab } from "../notifications-tab";

vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const original: NotificationChannelResponse = {
	id: "first-channel",
	name: "First synthetic channel",
	type: "DISCORD",
	enabled: true,
	lastTestedAt: "2026-01-01T00:00:00.000Z",
	lastTestResult: "success",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	subscriptions: [],
};
const other = {
	...original,
	id: "second-channel",
	name: "Second synthetic channel",
	lastTestedAt: null,
	lastTestResult: null,
};
const types = [
	{
		type: "DISCORD",
		label: "Discord",
		icon: "Hash",
		formFields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
	},
];
let client: QueryClient | undefined;

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function row(channel = original) {
	const element = screen.getByText(channel.name).closest(".rounded-xl");
	if (!element) throw new Error("Synthetic channel row missing");
	return within(element as HTMLElement);
}

function mount(
	options: {
		failure?: boolean;
		deferred?: boolean;
		deferredSave?: boolean;
		deferredSecondTest?: boolean;
		saveFailure?: boolean;
		equivalent?: boolean;
	} = {},
) {
	let current = { ...original };
	let currentOther: NotificationChannelResponse = { ...other };
	let posts = 0;
	let reads = 0;
	const writes: Record<string, unknown>[] = [];
	let completeTest: ((response: Response) => void) | undefined;
	let completeSave: ((response: Response) => void) | undefined;
	vi.stubGlobal("fetch", async (path: string, request: RequestInit = {}) => {
		if (path.endsWith("/test")) {
			expect(request.method).toBe("POST");
			posts++;
			const second = path.endsWith("/second-channel/test");
			if ((options.deferred && posts === 1) || (second && options.deferredSecondTest))
				return new Promise<Response>((resolve) => {
					completeTest = resolve;
				});
			if (second) {
				currentOther = {
					...currentOther,
					lastTestedAt: "2026-02-01T00:00:00.000Z",
					lastTestResult: "success",
				};
				return json({ success: true, statusRecorded: true });
			}
			if (options.failure) {
				current = { ...current, lastTestResult: "failed" };
				return json(
					{ success: false, statusRecorded: true, failureCategory: "authentication" },
					400,
				);
			}
			current = { ...current, lastTestedAt: "2026-02-01T00:00:00.000Z", lastTestResult: "success" };
			return json({ success: true, statusRecorded: true });
		}
		if (path.endsWith("/config")) {
			return json({
				...(path.endsWith("/second-channel/config") ? currentOther : current),
				configRevision: "a".repeat(64),
				config: { webhookUrl: "••••••••" },
			});
		}
		if (request.method === "PUT") {
			expect(path).toBe("/api/notifications/channels/first-channel");
			writes.push(JSON.parse(String(request.body)));
			if (options.deferredSave)
				return new Promise<Response>((resolve) => {
					completeSave = resolve;
				});
			if (options.saveFailure) return json({ message: "synthetic-private-save-error" }, 400);
			if (!options.equivalent) current = { ...current, lastTestedAt: null, lastTestResult: null };
			return json(current);
		}
		if (path.endsWith("/subscriptions"))
			return json({ events: [], channels: [current, currentOther], subscriptions: [] });
		expect(path).toBe("/api/notifications/channels");
		reads++;
		return json([current, currentOther]);
	});
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	client.setQueryData(notificationKeys.channels, [current, other]);
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
		get posts() {
			return posts;
		},
		get reads() {
			return reads;
		},
		writes,
		async finishTest() {
			if (!completeTest) throw new Error("Synthetic Test not admitted");
			await act(async () => {
				completeTest!(json({ success: true, statusRecorded: false }));
			});
		},
		async finishSave() {
			if (!completeSave) throw new Error("Synthetic save not admitted");
			await act(async () => {
				if (!options.saveFailure && !options.equivalent)
					current = { ...current, lastTestedAt: null, lastTestResult: null };
				completeSave!(
					options.saveFailure
						? json({ message: "synthetic-private-save-error" }, 400)
						: json(current),
				);
			});
		},
	};
}

async function editAndSave(changeConfig = true) {
	fireEvent.click(row().getByTitle("Edit channel"));
	const url = await screen.findByLabelText("Webhook URL");
	if (changeConfig)
		fireEvent.change(url, { target: { value: "https://synthetic.invalid/replacement" } });
	fireEvent.click(screen.getByRole("button", { name: "Update" }));
}

afterEach(() => {
	cleanup();
	client?.clear();
	vi.unstubAllGlobals();
});

describe("current connection badge and transient Test evidence during real edit workflow", () => {
	it.each([
		["passed", false],
		["failed", true],
	] as const)(
		"a successful edit clears earlier %s Test feedback without another Test",
		async (_outcome, failure) => {
			const fixture = mount({ failure });
			fireEvent.click(row().getByTitle("Send test notification"));
			await waitFor(() =>
				expect(row().getByRole(failure ? "alert" : "status")).toHaveTextContent(
					failure ? /authentication/i : /test passed/i,
				),
			);
			await editAndSave();
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument(),
			);
			await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
			expect(row().queryByRole("status")).not.toBeInTheDocument();
			expect(row().queryByRole("alert")).not.toBeInTheDocument();
			expect(row().queryByText(/Last tested:/)).not.toBeInTheDocument();
			expect(fixture.posts).toBe(1);
			expect(fixture.writes).toEqual([
				{
					name: original.name,
					enabled: true,
					config: { webhookUrl: "https://synthetic.invalid/replacement" },
					expectedRevision: "a".repeat(64),
				},
			]);
		},
	);

	it("a late old Test completion after save cannot reappear as evidence for the edited connection", async () => {
		const fixture = mount({ deferred: true });
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(fixture.posts).toBe(1));
		await editAndSave();
		await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
		const readsBeforeCompletion = fixture.reads;
		await fixture.finishTest();
		await waitFor(() => expect(fixture.reads).toBeGreaterThan(readsBeforeCompletion));
		expect(row().queryByRole("status")).not.toBeInTheDocument();
		expect(row().queryByRole("alert")).not.toBeInTheDocument();
		expect(row().getByText("Configured")).toBeInTheDocument();
		expect(fixture.posts).toBe(1);
	});

	it("equivalent masked save keeps persisted healthy proof but clears the previous transient result", async () => {
		const fixture = mount({ equivalent: true });
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByRole("status")).toHaveTextContent(/test passed/i));
		await editAndSave(false);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument(),
		);
		expect(row().getByText("Healthy")).toBeInTheDocument();
		expect(row().getByText(/Last tested:/)).toBeInTheDocument();
		expect(row().queryByRole("status")).not.toBeInTheDocument();
		expect(fixture.writes[0]?.config).toEqual({ webhookUrl: "••••••••" });
		expect(fixture.posts).toBe(1);
	});

	it("an explicit Test after editing verifies the current settings without an automatic resend", async () => {
		const fixture = mount();
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByRole("status")).toHaveTextContent(/test passed/i));
		await editAndSave();
		await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
		expect(fixture.posts).toBe(1);
		expect(row().queryByRole("status")).not.toBeInTheDocument();
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByText("Healthy")).toBeInTheDocument());
		expect(row().getByRole("status")).toHaveTextContent(/test passed/i);
		expect(fixture.posts).toBe(2);
		expect(fixture.writes).toHaveLength(1);
	});

	it("failed save preserves existing Test evidence and the unsaved draft without testing again", async () => {
		const fixture = mount({ saveFailure: true });
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByRole("status")).toHaveTextContent(/test passed/i));
		await editAndSave();
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/i));
		expect(row().getByRole("status")).toHaveTextContent(/test passed/i);
		expect(row().getByText("Healthy")).toBeInTheDocument();
		expect(screen.getByLabelText("Webhook URL")).toHaveValue(
			"https://synthetic.invalid/replacement",
		);
		expect(screen.queryByText("synthetic-private-save-error")).not.toBeInTheDocument();
		expect(fixture.posts).toBe(1);
		expect(fixture.writes).toHaveLength(1);
	});

	it("canceling an edit does not discard an unchanged connection's Test evidence", async () => {
		const fixture = mount();
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByRole("status")).toHaveTextContent(/test passed/i));
		fireEvent.click(row().getByTitle("Edit channel"));
		await screen.findByLabelText("Webhook URL");
		fireEvent.click(screen.getByRole("button", { name: "Close channel form" }));
		expect(row().getByRole("status")).toHaveTextContent(/test passed/i);
		expect(row().getByText("Healthy")).toBeInTheDocument();
		expect(fixture.writes).toHaveLength(0);
		expect(fixture.posts).toBe(1);
	});

	it.each([
		["another editor", false],
		["another editor", true],
		["new channel", false],
		["new channel", true],
		["Events", false],
		["Events", true],
	] as const)(
		"acknowledged save clears old feedback after switching to %s (failed Test: %s)",
		async (selection, failure) => {
			const fixture = mount({ deferredSave: true, failure });
			fireEvent.click(row().getByTitle("Send test notification"));
			await waitFor(() =>
				expect(row().getByRole(failure ? "alert" : "status")).toHaveTextContent(
					failure ? /authentication/i : /test passed/i,
				),
			);
			await editAndSave();
			await waitFor(() => expect(fixture.writes).toHaveLength(1));
			if (selection === "another editor") {
				fireEvent.click(row(other).getByTitle("Edit channel"));
				await screen.findByDisplayValue(other.name);
			} else if (selection === "new channel") {
				fireEvent.click(screen.getByRole("button", { name: "Add Channel" }));
				await screen.findByRole("button", { name: "Create" });
			} else {
				fireEvent.click(screen.getByRole("button", { name: "Events" }));
			}
			await fixture.finishSave();
			if (selection === "Events") fireEvent.click(screen.getByRole("button", { name: "Channels" }));
			await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
			expect(row().queryByRole("status")).not.toBeInTheDocument();
			expect(row().queryByRole("alert")).not.toBeInTheDocument();
			if (selection === "another editor")
				expect(screen.getByLabelText("Name")).toHaveValue(other.name);
			if (selection === "new channel")
				expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
			expect(fixture.posts).toBe(1);
			expect(fixture.writes).toHaveLength(1);
		},
	);

	it("a pending old Test cannot republish feedback after save completes outside Channels", async () => {
		const fixture = mount({ deferred: true, deferredSave: true });
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(fixture.posts).toBe(1));
		await editAndSave();
		await waitFor(() => expect(fixture.writes).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Events" }));
		await fixture.finishSave();
		fireEvent.click(screen.getByRole("button", { name: "Channels" }));
		await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
		const readsBeforeCompletion = fixture.reads;
		await fixture.finishTest();
		await waitFor(() => expect(fixture.reads).toBeGreaterThan(readsBeforeCompletion));
		expect(row().queryByRole("status")).not.toBeInTheDocument();
		expect(row().queryByRole("alert")).not.toBeInTheDocument();
		expect(row().getByTitle("Send test notification")).not.toBeDisabled();
		expect(fixture.posts).toBe(1);
	});

	it.each([false, true])(
		"saving a previous editor keeps a newer other-channel Test (pending: %s)",
		async (deferredSecondTest) => {
			const fixture = mount({ deferredSave: true, deferredSecondTest });
			fireEvent.click(row().getByTitle("Send test notification"));
			await waitFor(() => expect(row().getByRole("status")).toHaveTextContent(/test passed/i));
			await editAndSave();
			await waitFor(() => expect(fixture.writes).toHaveLength(1));
			fireEvent.click(row(other).getByTitle("Edit channel"));
			await screen.findByDisplayValue(other.name);
			fireEvent.click(row(other).getByTitle("Send test notification"));
			await waitFor(() => expect(fixture.posts).toBe(2));
			if (!deferredSecondTest)
				await waitFor(() =>
					expect(row(other).getByRole("status")).toHaveTextContent(/test passed/i),
				);
			await fixture.finishSave();
			await waitFor(() => expect(row().getByText("Configured")).toBeInTheDocument());
			expect(screen.getByLabelText("Name")).toHaveValue(other.name);
			if (deferredSecondTest) await fixture.finishTest();
			await waitFor(() => expect(row(other).getByRole("status")).toHaveTextContent(/test passed/i));
			expect(row().queryByRole("status")).not.toBeInTheDocument();
			expect(fixture.posts).toBe(2);
			expect(fixture.writes).toHaveLength(1);
		},
	);

	it("a failed save after changing editor leaves old valid Test feedback intact", async () => {
		const fixture = mount({ deferredSave: true, saveFailure: true });
		fireEvent.click(row().getByTitle("Send test notification"));
		await waitFor(() => expect(row().getByRole("status")).toHaveTextContent(/test passed/i));
		await editAndSave();
		await waitFor(() => expect(fixture.writes).toHaveLength(1));
		fireEvent.click(row(other).getByTitle("Edit channel"));
		await screen.findByDisplayValue(other.name);
		await fixture.finishSave();
		expect(screen.getByLabelText("Name")).toHaveValue(other.name);
		expect(row().getByText("Healthy")).toBeInTheDocument();
		expect(row().getByRole("status")).toHaveTextContent(/test passed/i);
		expect(fixture.posts).toBe(1);
	});
});
