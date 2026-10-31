import type { CurrentUser } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "../../../components/auth/auth-gate";
import { IncognitoProvider } from "../../../contexts/IncognitoContext";
import { clearRestoreHandoff, useRestoreBackup } from "../../../hooks/api/useBackup";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
	reportProtectedUnauthorized,
} from "../../../lib/auth-session-signal";
import { ColorThemeProvider } from "../../../providers/color-theme-provider";
import { authKeys } from "../../../lib/query-keys";
import { LoginForm } from "./login-form";

const navigation = vi.hoisted(() => ({
	pathname: "/login",
	search: new URLSearchParams("redirectTo=%2Fsettings%3Ftab%3Dbackup"),
	onNavigate: (_path: string) => {},
	router: { push: (_path: string) => {}, replace: (_path: string) => {} },
}));
vi.mock("next/navigation", () => ({
	usePathname: () => navigation.pathname,
	useSearchParams: () => navigation.search,
	useRouter: () => navigation.router,
}));
// A real authenticator is outside a jsdom component test; HTTP verification stays real.
vi.mock("@simplewebauthn/browser", () => ({
	startAuthentication: async () => ({
		id: "synthetic-credential",
		rawId: "c3ludGhldGljLWNyZWRlbnRpYWw",
		type: "public-key",
		response: {
			clientDataJSON: "e30",
			authenticatorData: "c3ludGhldGlj",
			signature: "c3ludGhldGlj",
			userHandle: "c3ludGhldGljLXVzZXI",
		},
		clientExtensionResults: {},
		authenticatorAttachment: "platform",
	}),
}));

const restoreId = "767478b4-9726-485c-bc91-c379fb118d12";
const user: CurrentUser = {
	id: "synthetic-recovered-account",
	username: "synthetic",
	mustChangePassword: false,
	createdAt: "2026-10-09T00:00:00.000Z",
	hasTmdbApiKey: false,
	hasPassword: true,
};
const clients: QueryClient[] = [];
const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function RestoreTrigger() {
	const restore = useRestoreBackup();
	return (
		<button
			type="button"
			disabled={restore.isPending || restore.isBlocked}
			onClick={() =>
				void restore
					.mutateAsync({ kind: "stored", request: { id: "a".repeat(24) } })
					.catch(() => {})
			}
		>
			Publish fixture
		</button>
	);
}

function mount(
	options: {
		recovery?: boolean;
		unconfirmed?: boolean;
		rejectLogin?: boolean;
		statusError?: 401 | 503;
		newUnauthorizedDuringStatus?: boolean;
	} = {},
) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	const events: { kind: "client" | "document"; path: string }[] = [];
	const requests = { restores: 0, logins: 0, status: 0 };
	let signedIn = options.recovery === true;
	const initialPath = options.recovery ? "/settings" : "/login";
	navigation.pathname = initialPath;
	if (options.recovery) {
		client.setQueryData(authKeys.setupRequired, { required: false, passwordPolicy: "strict" });
		client.setQueryData(authKeys.currentUser, user);
	}
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		if (path === "/auth/setup-required")
			return response({ required: false, passwordPolicy: "strict" });
		if (path === "/auth/oidc/providers") return response({ provider: null });
		if (path === "/auth/me") return signedIn ? response({ user }) : response({}, 401);
		if (path === "/api/backup/restore-from-file") {
			expect(init?.method).toBe("POST");
			requests.restores++;
			signedIn = false;
			if (options.unconfirmed) throw new Error("synthetic response loss");
			return response({
				restoreId,
				outcome: "committed",
				success: true,
				reason: null,
				restartRequired: true,
				restart: "automatic-requested",
			});
		}
		if (path === "/auth/passkey/login/options")
			return response({
				options: {
					challenge: "c3ludGhldGlj",
					rpId: "localhost",
					allowCredentials: [],
					userVerification: "preferred",
					timeout: 60000,
				},
				sessionId: "synthetic-session",
			});
		if (path === "/auth/login" || path === "/auth/passkey/login/verify") {
			expect(init?.method).toBe("POST");
			requests.logins++;
			if (options.rejectLogin) return response({ message: "Synthetic sign-in rejected" }, 400);
			signedIn = true;
			return response({ user });
		}
		if (path === "/api/backup/restore/status") {
			expect(init?.method ?? "GET").toBe("GET");
			requests.status++;
			if (options.statusError)
				return response({ error: "Synthetic status unavailable" }, options.statusError);
			if (options.newUnauthorizedDuringStatus) {
				// An earlier recovery observer clears the old signal while another
				// protected read fails before this in-flight status read completes.
				acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
				reportProtectedUnauthorized();
			}
			return signedIn
				? response({ latestCommitted: { restoreId, committedAt: "2026-10-09T00:00:00.000Z" } })
				: response({}, 401);
		}
		throw new Error("Unexpected synthetic route");
	});
	navigation.router.push = navigation.router.replace = (path) => {
		events.push({ kind: "client", path });
		navigation.onNavigate(path);
	};
	// Document navigation is not implemented by jsdom. Model its relevant effect:
	// a new document loses tab/module memory. All other window behavior stays native.
	const original = window;
	let href = "/login";
	const location = {
		get href() {
			return href;
		},
		set href(path: string) {
			href = path;
			events.push({ kind: "document", path });
			clearRestoreHandoff();
			navigation.onNavigate(path);
		},
	};
	vi.stubGlobal(
		"window",
		new Proxy(original, {
			get(target, property) {
				if (property === "location") return location;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	);
	function Surface() {
		const [path, setPath] = useState(initialPath);
		navigation.onNavigate = (next) => {
			navigation.pathname = next.split("?")[0]!;
			setPath(next);
		};
		return (
			<>
				<RestoreTrigger />
				<AuthGate>
					{path.startsWith("/login") ? <LoginForm /> : <p>Protected recovered account</p>}
				</AuthGate>
			</>
		);
	}
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<Surface />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { events, requests };
}

async function publishAndOpenLogin(message: RegExp) {
	fireEvent.click(screen.getByRole("button", { name: "Publish fixture" }));
	await screen.findByText(message);
	await waitFor(() =>
		expect(screen.queryByText(/Finishing the Restore response/)).not.toBeInTheDocument(),
	);
	// Controlled Next navigation boundary: enter Login only after the Restore
	// response settles, matching the real browser flow rather than a mounted login.
	await act(async () => navigation.onNavigate("/login?redirectTo=%2Fsettings%3Ftab%3Dbackup"));
}

async function signIn(method: "password" | "passkey") {
	if (method === "password") {
		fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "synthetic" } });
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "Synthetic-login-fixture!" },
		});
	}
	fireEvent.click(await screen.findByRole("button", { name: `Sign in with ${method}` }));
}

async function settleRecoverySignIn(method: "password" | "passkey") {
	const submit = await screen.findByRole("button", { name: `Sign in with ${method}` });
	await waitFor(() => expect(submit).toBeEnabled());
	await screen.findByText(/Sign-in completed/);
}

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	clearRestoreHandoff();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	vi.unstubAllGlobals();
	navigation.pathname = "/login";
	navigation.onNavigate = () => {};
});

describe("successful sign-in during Restore recovery", () => {
	it.each(["password", "passkey"] as const)(
		"retains the attempt after %s sign-in and resumes only after explicit status",
		async (method) => {
			const { events, requests } = mount({ recovery: true });
			await publishAndOpenLogin(/Restore committed/);
			await signIn(method);
			await settleRecoverySignIn(method);
			expect(events).toEqual([]);
			expect(screen.getByRole("region", { name: "Restore recovery" })).toBeInTheDocument();
			expect(screen.queryByText("Protected recovered account")).not.toBeInTheDocument();
			expect(requests.status).toBe(0);
			fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
			await screen.findByText(/Matching committed restore confirmed/);
			fireEvent.click(screen.getByRole("button", { name: "Clear recovery notice" }));
			await screen.findByText("Protected recovered account");
			expect(events).toEqual([{ kind: "document", path: "/settings" }]);
			expect(requests).toEqual({ restores: 1, logins: 1, status: 1 });
		},
	);
	it.each(["password", "passkey"] as const)(
		"preserves an unconfirmed handoff through %s sign-in without replay",
		async (method) => {
			const { events, requests } = mount({ recovery: true, unconfirmed: true });
			await publishAndOpenLogin(/outcome could not be confirmed/);
			await signIn(method);
			await settleRecoverySignIn(method);
			expect(events).toEqual([]);
			expect(screen.getByText(/outcome could not be confirmed/)).toBeInTheDocument();
			expect(screen.queryByText("Protected recovered account")).not.toBeInTheDocument();
			expect(requests).toEqual({ restores: 1, logins: 1, status: 0 });
			fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
			await screen.findByText(/No matching commit confirmation/);
			expect(screen.queryByText(/Matching committed restore confirmed/)).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Clear recovery notice" }));
			await screen.findByText("Protected recovered account");
			expect(events).toEqual([{ kind: "document", path: "/settings" }]);
			expect(requests).toEqual({ restores: 1, logins: 1, status: 1 });
		},
	);
	it.each([401, 503] as const)(
		"retains quarantine after a %s recovered-status failure",
		async (statusError) => {
			const { requests } = mount({ recovery: true, statusError });
			await publishAndOpenLogin(/Restore committed/);
			await signIn("password");
			await screen.findByRole("button", { name: "Check recovered status" });
			const pendingRevision = getPendingUnauthorizedRevision();
			expect(pendingRevision).toBeGreaterThan(0);
			fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
			await screen.findByText(/Recovered status could not be verified/);
			expect(getPendingUnauthorizedRevision()).toBe(pendingRevision);
			expect(
				screen.queryByRole("button", { name: "Clear recovery notice" }),
			).not.toBeInTheDocument();
			expect(screen.queryByText("Protected recovered account")).not.toBeInTheDocument();
			expect(requests).toEqual({ restores: 1, logins: 1, status: 1 });
		},
	);
	it("does not acknowledge a newer protected failure during the recovered-status read", async () => {
		const { events, requests } = mount({ recovery: true, newUnauthorizedDuringStatus: true });
		await publishAndOpenLogin(/Restore committed/);
		await signIn("password");
		await screen.findByRole("button", { name: "Check recovered status" });
		const pendingRevision = getPendingUnauthorizedRevision();
		fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
		await screen.findByText(/Matching committed restore confirmed/);
		expect(getPendingUnauthorizedRevision()).toBeGreaterThan(pendingRevision);
		fireEvent.click(screen.getByRole("button", { name: "Clear recovery notice" }));
		await screen.findByText(/A newer protected request failed/);
		expect(screen.getByRole("region", { name: "Restore recovery" })).toBeInTheDocument();
		expect(events).toEqual([]);
		expect(getPendingUnauthorizedRevision()).toBeGreaterThan(pendingRevision);
		expect(screen.queryByText("Protected recovered account")).not.toBeInTheDocument();
		expect(requests).toEqual({ restores: 1, logins: 1, status: 1 });
	});
	it.each(["password", "passkey"] as const)(
		"blocks document reset when auth fails after status verification for %s",
		async (method) => {
			const { events, requests } = mount({ recovery: true });
			await publishAndOpenLogin(/Restore committed/);
			await signIn(method);
			await settleRecoverySignIn(method);
			fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
			await screen.findByText(/Matching committed restore confirmed/);
			expect(getPendingUnauthorizedRevision()).toBe(0);
			await act(async () => reportProtectedUnauthorized());
			const newerRevision = getPendingUnauthorizedRevision();
			fireEvent.click(screen.getByRole("button", { name: "Clear recovery notice" }));
			await screen.findByText(/A newer protected request failed/);
			expect(getPendingUnauthorizedRevision()).toBe(newerRevision);
			expect(events).toEqual([]);
			expect(screen.getByRole("region", { name: "Restore recovery" })).toBeInTheDocument();
			expect(screen.queryByText("Protected recovered account")).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Check recovered status" }));
			await screen.findByText(/Matching committed restore confirmed/);
			fireEvent.click(screen.getByRole("button", { name: "Clear recovery notice" }));
			await screen.findByText("Protected recovered account");
			expect(events).toEqual([{ kind: "document", path: "/settings" }]);
			expect(requests).toEqual({ restores: 1, logins: 1, status: 2 });
		},
	);
	it.each(["password", "passkey"] as const)(
		"keeps ordinary %s sign-in as document navigation",
		async (method) => {
			const { events, requests } = mount();
			await signIn(method);
			await waitFor(() =>
				expect(events).toEqual([{ kind: "document", path: "/settings?tab=backup" }]),
			);
			expect(requests.restores).toBe(0);
		},
	);
	it.each(["password", "passkey"] as const)(
		"does not navigate or dismiss recovery after failed %s sign-in",
		async (method) => {
			const { events, requests } = mount({ recovery: true, rejectLogin: true });
			await publishAndOpenLogin(/Restore committed/);
			await signIn(method);
			await screen.findByText("Synthetic sign-in rejected");
			expect(events).toEqual([]);
			expect(screen.getByRole("region", { name: "Restore recovery" })).toBeInTheDocument();
			expect(requests).toEqual({ restores: 1, logins: 1, status: 0 });
		},
	);
});
