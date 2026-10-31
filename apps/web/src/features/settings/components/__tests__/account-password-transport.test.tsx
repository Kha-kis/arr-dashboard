import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useCurrentUser } from "../../../../hooks/api/useAuth";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useAccountManagement } from "../../hooks/use-account-management";
import { AccountTab } from "../account-tab";
import { PasswordSection } from "../password-section";

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
			join(process.env.V4_EVIDENCE_ROOT, "account-password-requests.json"),
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

let user: CurrentUser;
let refused: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	user = {
		id: "owner",
		username: "Synthetic owner",
		createdAt: "2026-10-25T12:00:00Z",
		mustChangePassword: false,
		hasTmdbApiKey: false,
		hasPassword: true,
	};
	refused = false;
	gate = null;
	respond = async ({ url, method, body }) => {
		if (method === "GET" && url === "/auth/me") return json({ user });
		if (method === "GET" && url === "/auth/setup-required")
			return json({ required: false, passwordPolicy: "strict" });
		if (method === "GET" && url === "/api/oidc-providers") return json({ provider: null });
		if (method === "GET" && url === "/auth/passkey/credentials")
			return json({
				credentials: [
					{
						id: "synthetic-passkey",
						friendlyName: "Synthetic alternative",
						backedUp: true,
						createdAt: "2026-10-25T12:00:00Z",
						lastUsedAt: "2026-10-25T12:00:00Z",
					},
				],
			});
		if (gate) await gate.promise;
		if (refused) return json({ error: "Synthetic account refusal" }, 503);
		if (method === "PATCH" && url === "/auth/account") {
			const fields = body as Record<string, unknown>;
			user = {
				...user,
				...(typeof fields.username === "string" ? { username: fields.username } : {}),
				...(fields.tmdbApiKey ? { hasTmdbApiKey: true } : {}),
			};
			return json({ user });
		}
		if (method === "DELETE" && url === "/auth/password") {
			user = { ...user, hasPassword: false };
			return json({ success: true, message: "Synthetic password removed" });
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
function Account() {
	const q = useCurrentUser();
	const m = useAccountManagement(q.data);
	return (
		<AccountTab
			currentUser={q.data}
			accountForm={m.accountForm}
			onAccountFormChange={m.setAccountForm}
			onAccountUpdate={m.handleAccountUpdate}
			isUpdating={m.updateAccountMutation.isPending}
			updateResult={m.accountUpdateResult}
		/>
	);
}
function Password() {
	const q = useCurrentUser();
	return <PasswordSection currentUser={q.data} />;
}
describe("S2 maintained account/password transport", () => {
	it("sends changed fields only, preserves refused editable credential draft, then clears sensitive fields after explicit success/readback", async () => {
		show(<Account />);
		await screen.findByText("Synthetic owner");
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("No changes to save");
		expect(writes()).toEqual([]);
		fireEvent.change(screen.getByPlaceholderText("Synthetic owner"), {
			target: { value: "Synthetic renamed" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("Account updated successfully");
		await settled();
		expect(writes()).toEqual([
			{ url: "/auth/account", method: "PATCH", body: { username: "Synthetic renamed" } },
		]);
		await screen.findByText("Synthetic renamed");
		const token = screen.getByPlaceholderText("Enter your TMDB API Read Access Token");
		const trakt = screen.getByPlaceholderText("Enter your Trakt personal access token");
		fireEvent.change(token, { target: { value: " synthetic-token " } });
		fireEvent.change(trakt, { target: { value: " synthetic-trakt " } });
		refused = true;
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("Synthetic account refusal");
		await settled();
		expect(token).toHaveValue(" synthetic-token ");
		expect(trakt).toHaveValue(" synthetic-trakt ");
		expect(token).toBeEnabled();
		expect(writes()).toHaveLength(2);
		refused = false;
		gate = hold();
		const save = screen.getByRole("button", { name: "Save changes" });
		fireEvent.click(save);
		await waitFor(() => expect(writes()).toHaveLength(3));
		await waitFor(() => expect(save).toBeDisabled());
		fireEvent.click(save);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Account updated successfully");
		await settled();
		expect(writes()[2]).toEqual({
			url: "/auth/account",
			method: "PATCH",
			body: { tmdbApiKey: "synthetic-token", traktAccessToken: "synthetic-trakt" },
		});
		expect(token).toHaveValue("");
		expect(trakt).toHaveValue("");
		expect(
			requests.filter((r) => r.url === "/auth/me" && r.method === "GET").length,
		).toBeGreaterThan(2);
	});
	it("validates password locally without dispatch, retains refused inputs then explicitly changes password and clears them", async () => {
		show(<Password />);
		const current = await screen.findByPlaceholderText("Enter current password");
		const next = screen.getByPlaceholderText("At least 8 characters");
		const confirmNew = screen.getByPlaceholderText("Re-enter new password");
		fireEvent.change(current, { target: { value: "SyntheticOld1!" } });
		fireEvent.change(next, { target: { value: "SyntheticNew2!" } });
		fireEvent.change(confirmNew, { target: { value: "different" } });
		fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
		await screen.findByText("New passwords do not match");
		expect(writes()).toEqual([]);
		fireEvent.change(next, { target: { value: "short" } });
		fireEvent.change(confirmNew, { target: { value: "short" } });
		fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
		await waitFor(() => expect(writes()).toEqual([]));
		expect(next).toHaveValue("short");
		fireEvent.change(next, { target: { value: "SyntheticNew2!" } });
		fireEvent.change(confirmNew, { target: { value: "SyntheticNew2!" } });
		refused = true;
		fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
		await screen.findByText("Synthetic account refusal");
		await settled();
		expect(next).toHaveValue("SyntheticNew2!");
		refused = false;
		fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
		await screen.findByText("Password changed successfully");
		await settled();
		expect(writes()).toEqual([
			{
				url: "/auth/account",
				method: "PATCH",
				body: { newPassword: "SyntheticNew2!", currentPassword: "SyntheticOld1!" },
			},
			{
				url: "/auth/account",
				method: "PATCH",
				body: { newPassword: "SyntheticNew2!", currentPassword: "SyntheticOld1!" },
			},
		]);
		expect(current).toHaveValue("");
		expect(next).toHaveValue("");
		expect(confirmNew).toHaveValue("");
	});
	it("removes password only through explicit supported alternative-auth form and refetches current user", async () => {
		show(<Password />);
		fireEvent.click(await screen.findByRole("button", { name: "Remove Password" }));
		const field = screen.getByPlaceholderText("Enter your current password");
		fireEvent.change(field, { target: { value: "SyntheticOld1!" } });
		fireEvent.click(screen.getByRole("button", { name: "Confirm Removal" }));
		await settled();
		await screen.findByRole("button", { name: "Add Password" });
		expect(writes()).toEqual([
			{ url: "/auth/password", method: "DELETE", body: { currentPassword: "SyntheticOld1!" } },
		]);
		expect(requests.filter((r) => r.url === "/auth/me").length).toBeGreaterThan(1);
	});
});
