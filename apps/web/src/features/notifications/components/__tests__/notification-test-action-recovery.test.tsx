import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationsTab } from "../notifications-tab";

vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const first: NotificationChannelResponse = {
	id: "first-channel",
	name: "First synthetic channel",
	type: "DISCORD",
	enabled: true,
	lastTestedAt: null,
	lastTestResult: null,
	createdAt: "2026-10-06T00:00:00Z",
	updatedAt: "2026-10-06T00:00:00Z",
	subscriptions: [],
};
const second = { ...first, id: "second-channel", name: "Second synthetic channel" };
let client: QueryClient | undefined;

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function row(name: string) {
	const element = screen.getByText(name).closest(".rounded-xl");
	if (!element) throw new Error("Channel row missing");
	return within(element as HTMLElement);
}

function mountChannels() {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	client.setQueryData(notificationKeys.channels, [first, second]);
	client.setQueryData(notificationKeys.channelTypes, []);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationsTab />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	client?.clear();
	vi.unstubAllGlobals();
});

describe("actual notification Test action failure and retry", () => {
	it.each([
		["authentication", /authentication.*credentials/i],
		["rate-limited", /rate limited.*wait/i],
		["provider-unavailable", /provider is unavailable/i],
		["timeout", /timed out.*network/i],
		["transport", /network delivery failed.*tls/i],
		["rejected", /provider rejected.*recipient/i],
		["subscription-expired", /subscription expired.*enable/i],
		["configuration", /configuration could not be read/i],
		["unsupported", /delivery is unsupported/i],
		["retry-exhausted", /not confirmed after retries/i],
		["shutdown", /not confirmed before shutdown/i],
	] as const)(
		"shows actionable %s guidance without raw text or an automatic second Test",
		async (failureCategory, guidance) => {
			let posts = 0;
			vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
				if (path.endsWith("/test")) {
					expect(options.method).toBe("POST");
					posts++;
					return json(
						{
							success: false,
							failureCategory,
							statusRecorded: true,
							message: "synthetic-private-test-error",
						},
						400,
					);
				}
				return json([first, second]);
			});
			mountChannels();
			fireEvent.click(row(first.name).getByTitle("Send test notification"));
			await waitFor(() => expect(row(first.name).getByRole("alert")).toHaveTextContent(guidance));
			expect(screen.queryByText("synthetic-private-test-error")).not.toBeInTheDocument();
			expect(row(second.name).queryByRole("alert")).not.toBeInTheDocument();
			expect(posts).toBe(1);
		},
	);

	it("keeps a passed Test positive when its status could not be saved without suggesting a duplicate send", async () => {
		let posts = 0;
		vi.stubGlobal("fetch", async (path: string) => {
			if (path.endsWith("/test")) {
				posts++;
				return json({ success: true, statusRecorded: false });
			}
			return json([first, second]);
		});
		mountChannels();
		fireEvent.click(row(first.name).getByTitle("Send test notification"));
		await waitFor(() =>
			expect(row(first.name).getByRole("status")).toHaveTextContent(
				/test passed.*status.*not.*saved/i,
			),
		);
		expect(row(first.name).getByRole("status")).toHaveTextContent(/do not.*repeat|do not.*resend/i);
		expect(row(first.name).queryByRole("alert")).not.toBeInTheDocument();
		expect(row(first.name).queryByText("Sent!")).not.toBeInTheDocument();
		expect(posts).toBe(1);
	});

	it("warns separately when a categorized failed Test was not recorded", async () => {
		vi.stubGlobal("fetch", async (path: string) =>
			path.endsWith("/test")
				? json(
						{
							success: false,
							statusRecorded: false,
							failureCategory: "rate-limited",
							message: "synthetic-private-test-error",
						},
						400,
					)
				: json([first, second]),
		);
		mountChannels();
		fireEvent.click(row(first.name).getByTitle("Send test notification"));
		await waitFor(() =>
			expect(row(first.name).getByRole("alert")).toHaveTextContent(
				/rate limited.*status.*not.*saved/i,
			),
		);
		expect(screen.queryByText("synthetic-private-test-error")).not.toBeInTheDocument();
	});

	it.each(["invented", "__proto__", { message: "synthetic-private-test-error" }])(
		"unknown failure category remains generic and private: %j",
		async (failureCategory) => {
			vi.stubGlobal("fetch", async (path: string) =>
				path.endsWith("/test")
					? json({ failureCategory, message: "synthetic-private-test-error" }, 400)
					: json([first, second]),
			);
			mountChannels();
			fireEvent.click(row(first.name).getByTitle("Send test notification"));
			await waitFor(() =>
				expect(row(first.name).getByRole("alert")).toHaveTextContent(/not complete|not confirmed/i),
			);
			expect(screen.queryByText("synthetic-private-test-error")).not.toBeInTheDocument();
		},
	);

	it.each([
		{ success: "false", error: "synthetic-private-test-error" },
		{ success: false, error: "synthetic-private-test-error" },
		null,
	])(
		"a malformed or negative successful HTTP response never invents a passed Test: %j",
		async (result) => {
			vi.stubGlobal("fetch", async (path: string) =>
				path.endsWith("/test") ? json(result) : json([first, second]),
			);
			mountChannels();
			fireEvent.click(row(first.name).getByTitle("Send test notification"));
			await waitFor(() =>
				expect(row(first.name).getByRole("alert")).toHaveTextContent(/not complete|not confirmed/i),
			);
			expect(screen.queryByText("synthetic-private-test-error")).not.toBeInTheDocument();
			expect(row(first.name).queryByText("Sent!")).not.toBeInTheDocument();
		},
	);
	it("shows known configuration failure for only the attempted channel, refreshes saved failure status and recovers on explicit retry", async () => {
		let fail = true;
		let posts = 0;
		let reads = 0;
		vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
			if (path === "/api/notifications/channels/first-channel/test") {
				expect(options.method).toBe("POST");
				posts++;
				return fail
					? json(
							{
								success: false,
								failureCategory: "configuration",
								statusRecorded: true,
								error: "Test failed",
								message: "synthetic-private-secret",
							},
							400,
						)
					: json({ success: true });
			}
			expect(path).toBe("/api/notifications/channels");
			reads++;
			return json([
				{
					...first,
					lastTestedAt: "2026-10-06T00:00:01Z",
					lastTestResult: fail ? "failed" : "success",
				},
				second,
			]);
		});
		client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
		});
		client.setQueryData(notificationKeys.channels, [first, second]);
		client.setQueryData(notificationKeys.channelTypes, []);
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<NotificationsTab />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
		fireEvent.click(row(first.name).getByTitle("Send test notification"));
		await waitFor(() =>
			expect(
				row(first.name).getByText(
					/configuration could not be read.*check and re-save channel settings/i,
				),
			).toBeInTheDocument(),
		);
		expect(screen.queryByText("synthetic-private-secret")).not.toBeInTheDocument();
		expect(row(first.name).queryByText("Sent!")).not.toBeInTheDocument();
		expect(
			row(second.name).queryByText(/configuration could not be read/i),
		).not.toBeInTheDocument();
		await waitFor(() => expect(reads).toBe(1));
		await waitFor(() =>
			expect(
				client?.getQueryData<NotificationChannelResponse[]>(notificationKeys.channels)?.[0]
					?.lastTestResult,
			).toBe("failed"),
		);
		expect(posts).toBe(1);
		fail = false;
		fireEvent.click(row(first.name).getByTitle("Send test notification"));
		await waitFor(() =>
			expect(row(first.name).getByRole("status")).toHaveTextContent(/test passed/i),
		);
		expect(row(first.name).queryByText(/configuration could not be read/i)).not.toBeInTheDocument();
		await waitFor(() =>
			expect(
				client?.getQueryData<NotificationChannelResponse[]>(notificationKeys.channels)?.[0]
					?.lastTestResult,
			).toBe("success"),
		);
		expect(posts).toBe(2);
		expect(reads).toBe(2);
		expect(row(second.name).queryByRole("status")).not.toBeInTheDocument();
	});
});
