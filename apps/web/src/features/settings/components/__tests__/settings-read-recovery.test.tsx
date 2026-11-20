import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "@/contexts/IncognitoContext";
import { ColorThemeProvider } from "@/providers/color-theme-provider";
import { systemKeys } from "@/lib/query-keys";
import { PasskeySection } from "../passkey-section";
import { SystemTab } from "../system-tab";

const clients: QueryClient[] = [];
const requests: string[] = [];
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credential = {
	id: "synthetic-key",
	friendlyName: "Synthetic Desk Key",
	backedUp: true,
	createdAt: "2026-10-20T12:00:00Z",
	lastUsedAt: null,
};
const listed = (credentials = [credential]) => json({ credentials });
beforeEach(() => {
	requests.length = 0;
});
afterEach(() => {
	for (const client of clients.splice(0)) client.clear();
});
function transport(handler: (path: string) => Response | Promise<Response>) {
	vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
		const url = new URL(input, "https://synthetic.invalid");
		const request = `${init.method ?? "GET"} ${url.pathname}`;
		requests.push(request);
		if (url.origin !== "https://synthetic.invalid" || (init.method ?? "GET") !== "GET")
			throw new Error("Unexpected settings mutation");
		return handler(url.pathname);
	});
}
function mount(node: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>{node}</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}

function deferredRead() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

function deletionReads(oldRead: Promise<Response>, latestRead: () => Response | Promise<Response>) {
	let reads = 0;
	vi.stubGlobal("confirm", () => true);
	vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
		const url = new URL(input, "https://synthetic.invalid");
		const method = init.method ?? "GET";
		requests.push(`${method} ${url.pathname}`);
		expect(url.origin).toBe("https://synthetic.invalid");
		expect(url.pathname).toBe("/auth/passkey/credentials");
		if (method === "DELETE") {
			expect(JSON.parse(String(init.body))).toEqual({ credentialId: "synthetic-key" });
			return json({ success: true });
		}
		expect(method).toBe("GET");
		reads += 1;
		return reads === 1 ? listed() : reads === 2 ? oldRead : latestRead();
	});
}

async function startOverlappingDeletion() {
	mount(<PasskeySection />);
	await screen.findByText("Synthetic Desk Key");
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	await waitFor(() =>
		expect(requests).toEqual([
			"GET /auth/passkey/credentials",
			"GET /auth/passkey/credentials",
			"DELETE /auth/passkey/credentials",
			"GET /auth/passkey/credentials",
		]),
	);
}

describe("passkey inventory overlapping read recovery", () => {
	// Break: pre-delete Refresh success restores deleted rows; its failure corrupts a newer verified read.
	it.each([200, 503])(
		"ignores an older HTTP %s refresh after acknowledged deletion and empty readback",
		async (status) => {
			const oldRead = deferredRead();
			deletionReads(oldRead.promise, () => listed([]));
			await startOverlappingDeletion();
			await screen.findByText("No passkeys registered yet");
			await act(async () =>
				oldRead.resolve(
					status === 200 ? listed() : json({ message: "Synthetic older read failed" }, status),
				),
			);
			expect(screen.queryByText("Synthetic Desk Key")).not.toBeInTheDocument();
			expect(screen.getByText("No passkeys registered yet")).toBeInTheDocument();
			expect(screen.getByText("0 passkeys registered")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(screen.getByText("Passkey deleted successfully!")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
		},
	);
	// Break: an older error/finally unlocks Refresh while the newer post-delete read is pending.
	it("keeps the latest read pending when an older refresh fails", async () => {
		const oldRead = deferredRead();
		const latestRead = deferredRead();
		deletionReads(oldRead.promise, () => latestRead.promise);
		await startOverlappingDeletion();
		await act(async () => oldRead.resolve(json({ message: "Synthetic older read failed" }, 503)));
		expect(screen.getByRole("button", { name: "Refreshing..." })).toBeDisabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await act(async () => latestRead.resolve(listed([])));
		expect(await screen.findByText("No passkeys registered yet")).toBeInTheDocument();
	});
	// Break: an old successful Refresh clears the newer readback failure and claims current inventory.
	it("preserves the newer read error when an older refresh succeeds", async () => {
		const oldRead = deferredRead();
		deletionReads(oldRead.promise, () => json({ message: "Synthetic latest read failed" }, 503));
		await startOverlappingDeletion();
		await screen.findByText("Synthetic latest read failed");
		await act(async () => oldRead.resolve(listed()));
		expect(screen.getByRole("alert")).toHaveTextContent("Synthetic latest read failed");
		expect(screen.getByText(/last known/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
		expect(screen.getByText("Passkey deleted successfully!")).toBeInTheDocument();
	});
});

describe("passkey inventory read recovery", () => {
	// Break: a failed cold read claims no credentials and offers no local read retry.
	it("distinguishes an unavailable read from verified empty and retries locally", async () => {
		let unavailable = true;
		transport((path) => {
			if (path !== "/auth/passkey/credentials") throw new Error("Unexpected read");
			return unavailable ? json({ message: "Synthetic inventory unavailable" }, 503) : listed([]);
		});
		mount(<PasskeySection />);
		await screen.findByText("Synthetic inventory unavailable");
		expect(screen.queryByText("No passkeys registered yet")).not.toBeInTheDocument();
		expect(screen.queryByText("0 passkeys registered")).not.toBeInTheDocument();
		unavailable = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("No passkeys registered yet")).toBeInTheDocument();
		expect(screen.getByText("0 passkeys registered")).toBeInTheDocument();
		expect(screen.queryByText("Synthetic inventory unavailable")).not.toBeInTheDocument();
		expect(requests).toEqual(["GET /auth/passkey/credentials", "GET /auth/passkey/credentials"]);
	});
	// Break: failed refresh discards rows or silently claims a current inventory.
	it("retains known rows with a last-known notice on failed refresh, then recovers", async () => {
		let unavailable = false;
		transport(() =>
			unavailable ? json({ message: "Synthetic refreshed inventory unavailable" }, 503) : listed(),
		);
		mount(<PasskeySection />);
		await screen.findByText("Synthetic Desk Key");
		unavailable = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("Synthetic refreshed inventory unavailable");
		expect(screen.getByText("Synthetic Desk Key")).toBeInTheDocument();
		expect(screen.getByText(/last known/i)).toBeInTheDocument();
		unavailable = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(screen.queryByText(/last known/i)).not.toBeInTheDocument());
		expect(screen.getByText("Synthetic Desk Key")).toBeInTheDocument();
		expect(requests).toHaveLength(3);
	});
	// Break: repeated refresh remains clickable while a read is pending.
	it("holds refresh while pending without hiding the last successful rows", async () => {
		let resolve!: (response: Response) => void;
		const pending = new Promise<Response>((yes) => {
			resolve = yes;
		});
		let reads = 0;
		transport(() => (++reads === 1 ? listed() : pending));
		mount(<PasskeySection />);
		await screen.findByText("Synthetic Desk Key");
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(screen.getByRole("button", { name: /refreshing/i })).toBeDisabled();
		expect(screen.getByText("Synthetic Desk Key")).toBeInTheDocument();
		await act(async () => resolve(listed([])));
		expect(await screen.findByText("No passkeys registered yet")).toBeInTheDocument();
		expect(requests).toHaveLength(2);
	});
});

describe("log inventory read recovery", () => {
	// Break: retained rows hide failed-read state or Refresh cannot recover.
	it("shows a failed refresh alongside cached rows and clears it after recovery", async () => {
		let unavailable = false;
		transport((path) => {
			if (path === "/api/system/logs")
				return unavailable
					? json({ message: "Synthetic unavailable" }, 503)
					: json({
							success: true,
							data: {
								directory: "/synthetic/logs",
								files: [{ name: "synthetic.log", size: 1234, modified: "2026-10-30T12:00:00Z" }],
							},
						});
			if (path === "/api/system/settings")
				return json({
					success: true,
					data: {
						apiPort: 3001,
						webPort: 3000,
						listenAddress: "0.0.0.0",
						appName: "Synthetic",
						externalUrl: null,
						trustProxy: false,
						secureCookies: null,
						effectiveApiPort: 3001,
						effectiveWebPort: 3000,
						effectiveListenAddress: "0.0.0.0",
						effectiveTrustProxy: false,
						effectiveSecureCookies: false,
						requiresRestart: false,
						updatedAt: "2026-10-30T12:00:00Z",
					},
				});
			if (
				[
					"/api/system/info",
					"/api/system/validation-health",
					"/api/system/security-posture",
				].includes(path)
			)
				return json({ message: "Synthetic unavailable diagnostics" }, 503);
			throw new Error("Unexpected read target");
		});
		const { client } = mount(<SystemTab />);
		await screen.findByText("synthetic.log");
		unavailable = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(client.getQueryState(systemKeys.logs)?.status).toBe("error"));
		expect(screen.getByText("Failed to load log files")).toBeInTheDocument();
		expect(screen.getByText("synthetic.log")).toBeInTheDocument();
		expect(screen.getByText(/last known/i)).toBeInTheDocument();
		unavailable = false;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(screen.queryByText("Failed to load log files")).not.toBeInTheDocument(),
		);
		expect(screen.getByText("synthetic.log")).toBeInTheDocument();
		expect(requests.filter((request) => request === "GET /api/system/logs")).toHaveLength(3);
		expect(requests.some((request) => request.includes("/download/"))).toBe(false);
	});
});
