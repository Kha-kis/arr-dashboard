import type { SubscriptionGrid as Grid } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SubscriptionGrid } from "../subscription-grid";

// Independent synthetic names intentionally collide under the existing mask.
const initial: Grid = {
	channels: [
		{ id: "first", name: "Private synthetic alpha", type: "DISCORD" },
		{ id: "second", name: "Private synthetic beta", type: "DISCORD" },
	],
	events: ["HUNT_COMPLETED"],
	subscriptions: [{ channelId: "first", eventType: "HUNT_COMPLETED" }],
};
const committed: Grid = {
	channels: [
		{ id: "first", name: "Private synthetic alpha", type: "DISCORD" },
		{ id: "second", name: "Private synthetic beta", type: "DISCORD" },
	],
	events: ["HUNT_COMPLETED"],
	subscriptions: [
		{ channelId: "first", eventType: "HUNT_COMPLETED" },
		{ channelId: "second", eventType: "HUNT_COMPLETED" },
	],
};
const clients: QueryClient[] = [];
const scopes: string[][] = [];

function PrivacyToggle() {
	const [incognito, setIncognito] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setIncognito(!incognito)}>
			{incognito ? "Show names" : "Hide names"}
		</button>
	);
}

function fixture(incognito = false, failRead = false) {
	localStorage.setItem("arr-dashboard-incognito-mode", String(incognito));
	const writes: unknown[] = [];
	const outOfScope: string[] = [];
	scopes.push(outOfScope);
	let reads = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, request: RequestInit = {}) => {
		const method = request.method ?? "GET";
		if (input !== "/api/notifications/subscriptions" || !["GET", "PUT"].includes(method)) {
			outOfScope.push(`${method} ${String(input)}`);
			throw new Error("Out-of-scope synthetic transport");
		}
		if (method === "PUT") {
			writes.push(JSON.parse(String(request.body)));
			return Response.json({ success: true, grid: committed, omittedCount: 0 });
		}
		reads++;
		return failRead
			? Response.json({ message: "Private synthetic read failure" }, { status: 503 })
			: Response.json(committed);
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(notificationKeys.subscriptions, initial);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<PrivacyToggle />
					<SubscriptionGrid />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { client, writes, readCount: () => reads };
}

function headers() {
	return screen.getAllByRole("columnheader").map((header) => header.textContent);
}

function huntCells() {
	return within(screen.getByRole("row", { name: /Hunt Completed/ })).getAllByRole("button");
}

function assertPrivateNamesAbsent() {
	for (const channel of initial.channels) {
		expect(screen.queryByText(channel.name)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: new RegExp(channel.name) }),
		).not.toBeInTheDocument();
	}
}

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	for (const scope of scopes.splice(0)) expect(scope).toEqual([]);
});

describe("subscription grid privacy through actual provider, client, hook and cache", () => {
	it("keeps distinct real names and accessible actions in ordinary mode", () => {
		const value = fixture();
		expect(headers()).toEqual(["Event", "Private synthetic alpha", "Private synthetic beta"]);
		expect(huntCells()[0]).toHaveAccessibleName(
			"Unsubscribe Private synthetic alpha from Hunt Completed",
		);
		expect(huntCells()[1]).toHaveAccessibleName(
			"Subscribe Private synthetic beta from Hunt Completed",
		);
		expect(value.writes).toEqual([]);
		expect(value.readCount()).toBe(0);
	});
	it("masks both persisted-incognito column headers without transforming cached identity", () => {
		const value = fixture(true);
		expect(headers()).toEqual(["Event", "Instance", "Instance"]);
		for (const channel of initial.channels)
			expect(screen.queryByText(channel.name)).not.toBeInTheDocument();
		expect(value.client.getQueryData(notificationKeys.subscriptions)).toEqual(initial);
		expect(value.writes).toEqual([]);
	});
	it("masks persisted-incognito accessible labels as well as visible text", () => {
		fixture(true);
		expect(huntCells()[0]).toHaveAccessibleName("Unsubscribe Instance from Hunt Completed");
		expect(huntCells()[1]).toHaveAccessibleName("Subscribe Instance from Hunt Completed");
		assertPrivateNamesAbsent();
	});
	it("updates both display surfaces on privacy toggles without losing an unsaved draft", () => {
		const value = fixture();
		fireEvent.click(huntCells()[1]!);
		fireEvent.click(screen.getByRole("button", { name: "Hide names" }));
		expect(headers()).toEqual(["Event", "Instance", "Instance"]);
		for (const cell of huntCells())
			expect(cell).toHaveAccessibleName("Unsubscribe Instance from Hunt Completed");
		assertPrivateNamesAbsent();
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
		expect(value.client.getQueryData(notificationKeys.subscriptions)).toEqual(initial);
		fireEvent.click(screen.getByRole("button", { name: "Show names" }));
		expect(headers()).toEqual(["Event", "Private synthetic alpha", "Private synthetic beta"]);
		expect(huntCells()[1]).toHaveAccessibleName(
			"Unsubscribe Private synthetic beta from Hunt Completed",
		);
		expect(value.writes).toEqual([]);
	});
	it("saves only the selected channel ID when two masked names collide", async () => {
		const value = fixture(true);
		fireEvent.click(huntCells()[1]!);
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() =>
			expect(value.client.getMutationCache().getAll()[0]?.state.status).toBe("success"),
		);
		expect(value.writes).toEqual([
			{ subscriptions: [{ channelId: "second", eventType: "HUNT_COMPLETED", enabled: true }] },
		]);
		expect(value.client.getQueryData(notificationKeys.subscriptions)).toEqual(committed);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument(),
		);
		expect(headers()).toEqual(["Event", "Instance", "Instance"]);
		for (const cell of huntCells())
			expect(cell).toHaveAccessibleName("Unsubscribe Instance from Hunt Completed");
		assertPrivateNamesAbsent();
	});
	it("keeps confirmed last-known names private when the background read fails", async () => {
		const value = fixture(true, true);
		fireEvent.click(huntCells()[1]!);
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(/last-known.*refresh failed/i),
		);
		expect(value.client.getQueryData(notificationKeys.subscriptions)).toEqual(committed);
		expect(headers()).toEqual(["Event", "Instance", "Instance"]);
		assertPrivateNamesAbsent();
		expect(screen.queryByText("Private synthetic read failure")).not.toBeInTheDocument();
		expect(value.writes).toHaveLength(1);
		expect(value.readCount()).toBe(1);
	});
});
