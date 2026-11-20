import type { OIDCProvider } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { oidcKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { OIDCProviderSection } from "../oidc-provider-section";

type Request = { url: string; method: string; body: unknown };
const json = (body: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
const saved: OIDCProvider = {
	id: 1,
	displayName: "Synthetic OIDC",
	clientId: "synthetic-client",
	issuer: "https://oidc.synthetic.invalid",
	redirectUri: "https://dashboard.synthetic.invalid/auth/oidc/callback",
	scopes: "openid,email,profile",
	enabled: true,
	createdAt: "2026-10-25T12:00:00Z",
	updatedAt: "2026-10-25T12:00:00Z",
};
let provider: OIDCProvider | null;
let linked: boolean;
let requests: Request[];
let navigations: string[];
let client: QueryClient;
let active: Set<Promise<Response>>;
let gates: Array<{ promise: Promise<void>; release: () => void }>;
let respond: (request: Request) => Promise<Response>;
const writes = () => requests.filter((r) => r.method !== "GET");
const endpoint = "/api/oidc-providers";
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
	provider = { ...saved };
	linked = true;
	requests = [];
	navigations = [];
	gates = [];
	active = new Set();
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	respond = async (request) => {
		if (request.method === "GET" && request.url === endpoint) return json({ provider, linked });
		throw new Error(`Unexpected OIDC request ${request.method} ${request.url}`);
	};
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
	// Record only the browser navigation boundary. Real DOM/hooks/client stay intact;
	// this is not proof of an external document load or an authenticated callback.
	const realWindow = window;
	const location = {
		get origin() {
			return realWindow.location.origin;
		},
		get href() {
			return realWindow.location.href;
		},
		set href(value: string) {
			navigations.push(String(value));
		},
	};
	vi.stubGlobal(
		"window",
		new Proxy(realWindow, {
			get(target, key) {
				if (key === "location") return location;
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	);
});
afterEach(async () => {
	try {
		await act(async () => {
			gates.forEach((g) => {
				g.release();
			});
			await Promise.allSettled([...active]);
		});
		await waitFor(() => expect(client.isMutating()).toBe(0));
	} finally {
		cleanup();
		client.clear();
		vi.unstubAllGlobals();
	}
});
function show() {
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<OIDCProviderSection currentUser={{ hasPassword: true }} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
async function ready() {
	show();
	await screen.findByRole("heading", { name: "Synthetic OIDC" });
}
async function release(gate: ReturnType<typeof hold>) {
	await act(async () => {
		gate.release();
		await Promise.allSettled([...active]);
	});
}
function fillCreate() {
	fireEvent.change(screen.getByPlaceholderText("e.g., Authentik SSO"), {
		target: { value: "Synthetic created" },
	});
	fireEvent.change(screen.getByPlaceholderText("https://auth.example.com"), {
		target: { value: "https://issuer.synthetic.invalid" },
	});
	fireEvent.change(screen.getByPlaceholderText("OAuth client ID"), {
		target: { value: "new-client" },
	});
	fireEvent.change(screen.getByPlaceholderText("OAuth client secret"), {
		target: { value: "synthetic-client-secret" },
	});
}

describe("composed OIDC provider actions", () => {
	it.each([false, true])(
		"does not publish a failed OIDC read as absent/current configuration (cached=%s)",
		async (cached) => {
			let fail = !cached;
			const normal = respond;
			respond = async (request) =>
				request.method === "GET" && request.url === endpoint && fail
					? json({ error: "Synthetic configuration unavailable" }, 503)
					: normal(request);
			show();
			if (cached) {
				await screen.findByRole("heading", { name: "Synthetic OIDC" });
				fail = true;
				await act(async () => {
					await client.invalidateQueries({ queryKey: oidcKeys.provider });
				});
			}
			await waitFor(() => expect(client.isFetching()).toBe(0));
			expect(screen.queryByText("No OIDC provider configured")).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Configure OIDC" })).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
			const retry = screen.getByRole("button", { name: "Retry OIDC configuration" });
			fail = false;
			fireEvent.click(retry);
			await screen.findByRole("heading", { name: "Synthetic OIDC" });
			expect(writes()).toHaveLength(0);
			expect(requests.filter((r) => r.url === endpoint)).toHaveLength(cached ? 3 : 2);
		},
	);

	it.each(["create", "edit"])(
		"associates actual %s configuration controls with their labels",
		async (mode) => {
			if (mode === "create") provider = null;
			show();
			fireEvent.click(
				await screen.findByRole("button", { name: mode === "create" ? "Configure OIDC" : "Edit" }),
			);
			for (const label of [
				"Display Name",
				"Issuer URL",
				"Client ID",
				"Client Secret",
				"Redirect URI",
				mode === "create" ? "Scopes (comma-separated)" : "Scopes",
			]) {
				expect(screen.getByLabelText(label).tagName).toBe("INPUT");
			}
			expect(screen.getByLabelText("Client Secret")).toHaveAttribute("type", "password");
			expect(writes()).toHaveLength(0);
		},
	);

	it("creates a disabled provider then acknowledges explicit enable and disable changes without starting login", async () => {
		provider = null;
		const normal = respond;
		respond = async (request) => {
			if (request.url === endpoint && request.method === "POST") {
				provider = {
					...saved,
					displayName: "Synthetic created",
					clientId: "new-client",
					issuer: "https://issuer.synthetic.invalid",
					enabled: false,
				};
				return json(provider, 201);
			}
			if (request.url === endpoint && request.method === "PUT") {
				provider = { ...provider!, enabled: (request.body as { enabled: boolean }).enabled };
				return json(provider);
			}
			return normal(request);
		};
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Configure OIDC" }));
		fillCreate();
		fireEvent.click(screen.getByRole("switch", { name: "Enable provider" }));
		fireEvent.click(screen.getByRole("button", { name: "Create Provider" }));
		await screen.findByRole("heading", { name: "Synthetic created" });
		expect(screen.getByText("Disabled")).toBeInTheDocument();
		expect(writes()[0]).toEqual({
			url: endpoint,
			method: "POST",
			body: {
				displayName: "Synthetic created",
				issuer: "https://issuer.synthetic.invalid",
				clientId: "new-client",
				clientSecret: "synthetic-client-secret",
				scopes: "openid,email,profile",
				enabled: false,
			},
		});
		for (const enabled of [true, false]) {
			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			fireEvent.click(screen.getByRole("switch", { name: "Enable provider" }));
			fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
			await screen.findByRole("button", { name: "Edit" });
			expect(Boolean(screen.queryByText("Disabled"))).toBe(!enabled);
		}
		expect(writes().slice(1)).toEqual(
			[true, false].map((enabled) => ({
				url: endpoint,
				method: "PUT",
				body: {
					displayName: "Synthetic created",
					issuer: "https://issuer.synthetic.invalid",
					clientId: "new-client",
					redirectUri: "https://dashboard.synthetic.invalid/auth/oidc/callback",
					scopes: "openid,email,profile",
					enabled,
				},
			})),
		);
		expect(navigations).toEqual([]);
	});

	it("preserves an explicitly refused create draft, then links only after one acknowledged pending retry", async () => {
		provider = null;
		const response = hold();
		let attempts = 0;
		const normal = respond;
		respond = async (request) => {
			if (request.url === endpoint && request.method === "POST") {
				if (++attempts === 1) return json({ error: "Synthetic create refused" }, 503);
				await response.promise;
				provider = { ...saved, displayName: "Synthetic created" };
				return json(provider, 201);
			}
			if (request.url === "/auth/oidc/login")
				return json({ authorizationUrl: "https://oidc.synthetic.invalid/authorize" });
			return normal(request);
		};
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Configure OIDC" }));
		fillCreate();
		fireEvent.click(screen.getByRole("button", { name: "Create & Link Account" }));
		await screen.findByText("Synthetic create refused");
		expect(screen.getByPlaceholderText("OAuth client secret")).toHaveValue(
			"synthetic-client-secret",
		);
		expect(navigations).toEqual([]);
		const retry = screen.getByRole("button", { name: "Create & Link Account" });
		fireEvent.click(retry);
		await waitFor(() => expect(retry).toBeDisabled());
		fireEvent.click(retry);
		expect(writes()).toHaveLength(2);
		expect(navigations).toEqual([]);
		await release(response);
		await waitFor(() => expect(navigations).toEqual(["https://oidc.synthetic.invalid/authorize"]));
		expect(writes()).toHaveLength(3);
		expect(writes()[0]).toEqual(writes()[1]);
		expect(writes()[2]).toEqual({
			url: "/auth/oidc/login",
			method: "POST",
			body: { intent: "link" },
		});
	});

	it("preserves refused edit data and blank-secret omission through exact pending retry and readback", async () => {
		const response = hold();
		const normal = respond;
		let attempts = 0;
		respond = async (request) => {
			if (request.url !== endpoint || request.method !== "PUT") return normal(request);
			if (++attempts === 1) return json({ error: "Synthetic update refused" }, 503);
			await response.promise;
			provider = { ...saved, displayName: "Changed OIDC" };
			return json(provider);
		};
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.change(screen.getByDisplayValue("Synthetic OIDC"), {
			target: { value: "Changed OIDC" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await screen.findByText("Synthetic update refused");
		expect(screen.getByDisplayValue("Changed OIDC")).toBeInTheDocument();
		const retry = screen.getByRole("button", { name: "Save Changes" });
		fireEvent.click(retry);
		await waitFor(() => expect(retry).toBeDisabled());
		fireEvent.click(retry);
		await release(response);
		await screen.findByRole("heading", { name: "Changed OIDC" });
		expect(writes()).toEqual(
			[1, 2].map(() => ({
				url: endpoint,
				method: "PUT",
				body: {
					displayName: "Changed OIDC",
					clientId: "synthetic-client",
					issuer: "https://oidc.synthetic.invalid",
					redirectUri: "https://dashboard.synthetic.invalid/auth/oidc/callback",
					scopes: "openid,email,profile",
					enabled: true,
				},
			})),
		);
		expect(navigations).toEqual([]);
	});

	it.each(["Link Account", "Test Account", "Relink Account"])(
		"dispatches %s intent and redirects only after explicit successful retry",
		async (name) => {
			linked = name !== "Link Account";
			const response = hold();
			let attempts = 0;
			const normal = respond;
			respond = async (request) => {
				if (request.url !== "/auth/oidc/login") return normal(request);
				if (++attempts === 1) return json({ error: "Synthetic authorization refused" }, 503);
				await response.promise;
				return json({ authorizationUrl: "https://oidc.synthetic.invalid/authorize" });
			};
			await ready();
			fireEvent.click(screen.getByRole("button", { name }));
			await screen.findByText("Synthetic authorization refused");
			expect(navigations).toEqual([]);
			const retry = screen.getByRole("button", { name });
			fireEvent.click(retry);
			await waitFor(() => expect(retry).toBeDisabled());
			fireEvent.click(retry);
			expect(writes()).toHaveLength(2);
			expect(navigations).toEqual([]);
			await release(response);
			await waitFor(() =>
				expect(navigations).toEqual(["https://oidc.synthetic.invalid/authorize"]),
			);
			expect(writes()).toEqual(
				[1, 2].map(() => ({
					url: "/auth/oidc/login",
					method: "POST",
					body: { intent: name === "Test Account" ? "test" : "link" },
				})),
			);
		},
	);

	it("cancels deletion without writes, retains refused fallback inputs, and requests login only after acknowledged DELETE", async () => {
		const response = hold();
		let attempts = 0;
		const normal = respond;
		respond = async (request) => {
			if (request.url !== endpoint || request.method !== "DELETE") return normal(request);
			if (++attempts === 1) return json({ error: "Synthetic deletion refused" }, 503);
			await response.promise;
			provider = null;
			linked = false;
			return json(null, 204);
		};
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		let dialog = within(screen.getByRole("dialog"));
		fireEvent.change(dialog.getByLabelText("Current password"), {
			target: { value: "SyntheticOld1!" },
		});
		fireEvent.change(dialog.getByLabelText("Fallback password"), {
			target: { value: "SyntheticNew2!" },
		});
		fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
		expect(writes()).toHaveLength(0);
		expect(navigations).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		dialog = within(screen.getByRole("dialog"));
		expect(dialog.getByLabelText("Current password")).toHaveValue("");
		expect(dialog.getByLabelText("Fallback password")).toHaveValue("");
		fireEvent.change(dialog.getByLabelText("Current password"), {
			target: { value: "SyntheticOld1!" },
		});
		fireEvent.change(dialog.getByLabelText("Fallback password"), {
			target: { value: "SyntheticNew2!" },
		});
		fireEvent.change(dialog.getByLabelText("Confirm fallback password"), {
			target: { value: "SyntheticNew2!" },
		});
		fireEvent.click(dialog.getByRole("button", { name: /delete and sign out/i }));
		await screen.findByText("Synthetic deletion refused");
		expect(navigations).toEqual([]);
		expect(dialog.getByLabelText("Fallback password")).toHaveValue("SyntheticNew2!");
		const retry = dialog.getByRole("button", { name: /delete and sign out/i });
		fireEvent.click(retry);
		await waitFor(() => expect(retry).toBeDisabled());
		fireEvent.click(retry);
		await release(response);
		await waitFor(() => expect(navigations).toEqual(["/login"]));
		expect(writes()).toEqual(
			[1, 2].map(() => ({
				url: endpoint,
				method: "DELETE",
				body: {
					currentPassword: "SyntheticOld1!",
					replacementPassword: "SyntheticNew2!",
				},
			})),
		);
	});
});
