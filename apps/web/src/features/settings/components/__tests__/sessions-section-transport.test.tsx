import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { SessionInfo } from "../../../../lib/api-client/auth";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SessionsSection } from "../sessions-section";

type Request = { url: string; method: string; body: unknown };
const json = (body: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
let requests: Request[];
let alerts: string[];
let clients: QueryClient[];
let gates: Array<{ promise: Promise<void>; release: () => void }>;
let active: Set<Promise<Response>>;
let respond: (request: Request) => Promise<Response>;
const receipts: unknown[] = [];
const writes = () => requests.filter((request) => request.method !== "GET");
function hold() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const gate = { promise, release };
	gates.push(gate);
	return gate;
}
beforeEach(() => {
	localStorage.clear();
	requests = [];
	alerts = [];
	clients = [];
	gates = [];
	active = new Set();
	respond = async (request) => {
		throw new Error(`Unexpected synthetic request ${request.method} ${request.url}`);
	};
	vi.stubGlobal(
		"alert",
		vi.fn((message: unknown) => {
			alerts.push(String(message));
		}),
	);
	vi.stubGlobal(
		"confirm",
		vi.fn(() => false),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, options?: RequestInit) => {
			const request = {
				url,
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(String(options.body)) : null,
			};
			requests.push(request);
			const task = respond(request);
			active.add(task);
			void task.then(
				() => active.delete(task),
				() => active.delete(task),
			);
			return task;
		}),
	);
});
async function settled() {
	await waitFor(() =>
		expect(
			clients
				.flatMap((client) => client.getMutationCache().getAll())
				.some((mutation) => mutation.state.status === "pending"),
		).toBe(false),
	);
}
afterEach(async () => {
	try {
		gates.forEach((gate) => {
			gate.release();
		});
		await act(async () => {
			await Promise.allSettled([...active]);
		});
		await settled();
		receipts.push({
			test: expect.getState().currentTestName,
			requests,
			alerts,
			heldWorkJoined: active.size === 0,
		});
	} finally {
		toast.dismiss();
		cleanup();
		clients.forEach((client) => {
			client.clear();
		});
		vi.unstubAllGlobals();
	}
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "sessions-requests.json"),
			JSON.stringify(receipts, null, 2),
		);
});
function show(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						{ui}
						<Toaster />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}

const session = (id: string, isCurrent: boolean): SessionInfo => ({
	id,
	isCurrent,
	createdAt: "2026-10-25T12:00:00Z",
	expiresAt: "2030-10-25T12:00:00Z",
	lastAccessedAt: "2026-10-25T12:00:00Z",
	isExpired: false,
	userAgent: "Synthetic browser",
	ipAddress: "192.0.2.1",
	browser: isCurrent ? "Synthetic current" : "Synthetic other",
	os: "Synthetic OS",
	device: "desktop",
});
let rows: SessionInfo[];
let readFailure: boolean;
let revokeFailure: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	rows = [session("current", true), session("other", false)];
	readFailure = false;
	revokeFailure = false;
	gate = null;
	respond = async ({ url, method }) => {
		if (method === "GET" && url === "/auth/sessions")
			return json(
				readFailure
					? { error: "Synthetic sessions unavailable" }
					: { sessions: rows, totalSessions: rows.length },
				readFailure ? 503 : 200,
			);
		if (method === "DELETE" && url === "/auth/sessions/other") {
			if (gate) await gate.promise;
			if (revokeFailure) return json({ error: "Synthetic revoke refused" }, 503);
			rows = [session("current", true)];
			return json({ success: true, message: "Synthetic revoked" });
		}
		throw new Error(`Unexpected synthetic request ${method} ${url}`);
	};
});
describe("S3 maintained Sessions transport", () => {
	it("protects current session, keeps refused revoke honest, Refresh reads only and explicit revoke removes exact other ID", async () => {
		show(<SessionsSection />);
		await screen.findByText("Synthetic current on Synthetic OS");
		expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
		const run = screen.getByRole("button", { name: "Revoke" });
		gate = hold();
		revokeFailure = true;
		fireEvent.click(run);
		await waitFor(() => expect(writes()).toHaveLength(1));
		await waitFor(() => expect(run).toBeDisabled());
		fireEvent.click(run);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Synthetic revoke refused");
		expect(screen.getByText("Synthetic other on Synthetic OS")).toBeInTheDocument();
		expect(writes()).toEqual([{ url: "/auth/sessions/other", method: "DELETE", body: null }]);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(screen.queryByText("Synthetic revoke refused")).not.toBeInTheDocument(),
		);
		expect(writes()).toHaveLength(1);
		revokeFailure = false;
		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
		await waitFor(() =>
			expect(screen.queryByText("Synthetic other on Synthetic OS")).not.toBeInTheDocument(),
		);
		expect(screen.getByText("Synthetic current on Synthetic OS")).toBeInTheDocument();
		expect(writes()).toEqual([
			{ url: "/auth/sessions/other", method: "DELETE", body: null },
			{ url: "/auth/sessions/other", method: "DELETE", body: null },
		]);
		expect(
			requests.filter((r) => r.url === "/auth/sessions" && r.method === "GET").length,
		).toBeGreaterThan(2);
	});
	it("keeps failed reads unavailable rather than empty and actual Refresh recovers with GET only", async () => {
		readFailure = true;
		show(<SessionsSection />);
		await screen.findByText("Synthetic sessions unavailable");
		expect.soft(screen.queryByText("No active sessions found")).not.toBeInTheDocument();
		expect.soft(screen.queryByText("0")).not.toBeInTheDocument();
		readFailure = false;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("Synthetic current on Synthetic OS");
		expect(screen.queryByText("Synthetic sessions unavailable")).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
	});
	it("renders a real successful empty response as empty, without treating it as unavailable", async () => {
		rows = [];
		show(<SessionsSection />);
		await screen.findByText("No active sessions found");
		expect(screen.getByText("0")).toBeInTheDocument();
		expect(screen.queryByText("Unable to retrieve session information")).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
	});
	it("keeps last known sessions with stale disclosure after a failed refresh until GET-only recovery", async () => {
		show(<SessionsSection />);
		await screen.findByText("Synthetic current on Synthetic OS");
		readFailure = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("Synthetic sessions unavailable");
		expect.soft(screen.queryByText(/last known.*may be outdated/i)).toBeInTheDocument();
		expect(screen.getByText("Synthetic other on Synthetic OS")).toBeInTheDocument();
		readFailure = false;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(screen.queryByText("Synthetic sessions unavailable")).not.toBeInTheDocument(),
		);
		expect(screen.queryByText(/last known.*may be outdated/i)).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
	});
	it("does not let an older held Refresh restore a session after the newer post-revoke read", async () => {
		show(<SessionsSection />);
		await screen.findByText("Synthetic current on Synthetic OS");
		const older = hold();
		const prior = respond;
		let reads = 0;
		respond = async (request) => {
			if (request.method === "GET" && request.url === "/auth/sessions" && ++reads === 1) {
				const snapshot = [...rows];
				await older.promise;
				return json({ sessions: snapshot, totalSessions: 2 });
			}
			return prior(request);
		};
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByRole("button", { name: "Refreshing..." });
		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
		await waitFor(() =>
			expect(screen.queryByText("Synthetic other on Synthetic OS")).not.toBeInTheDocument(),
		);
		await act(async () => {
			older.release();
			await Promise.allSettled([...active]);
		});
		expect(screen.queryByText("Synthetic other on Synthetic OS")).not.toBeInTheDocument();
		expect(screen.getByText("1")).toBeInTheDocument();
		expect(writes()).toEqual([{ url: "/auth/sessions/other", method: "DELETE", body: null }]);
	});
	it("ignores an older failed Refresh error and finally while a newer post-revoke GET is pending", async () => {
		show(<SessionsSection />);
		await screen.findByText("Synthetic current on Synthetic OS");
		const older = hold(),
			newer = hold();
		const prior = respond;
		let reads = 0;
		respond = async (request) => {
			if (request.method === "GET" && request.url === "/auth/sessions") {
				reads += 1;
				if (reads === 1) {
					await older.promise;
					return json({ error: "Synthetic old read failed" }, 503);
				}
				if (reads === 2) await newer.promise;
			}
			return prior(request);
		};
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByRole("button", { name: "Refreshing..." });
		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
		await waitFor(() => expect(reads).toBe(2));
		await act(async () => {
			older.release();
			await older.promise;
		});
		await waitFor(() => expect(active.size).toBe(1));
		expect.soft(screen.queryByText("Synthetic old read failed")).not.toBeInTheDocument();
		expect.soft(screen.queryByRole("button", { name: "Refreshing..." })).toBeDisabled();
		await act(async () => {
			newer.release();
			await Promise.allSettled([...active]);
		});
		await waitFor(() =>
			expect(screen.queryByText("Synthetic other on Synthetic OS")).not.toBeInTheDocument(),
		);
		expect(screen.queryByText("Synthetic old read failed")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
	});
});
