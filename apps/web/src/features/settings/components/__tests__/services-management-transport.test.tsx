import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useServicesQuery } from "../../../../hooks/api/useServicesQuery";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useServiceFormState } from "../../hooks/use-service-form-state";
import { useServicesManagement } from "../../hooks/use-services-management";
import { ServiceForm } from "../service-form";
import { ServicesTab } from "../services-tab";

const oauth = vi.hoisted(() => ({
	status: "done" as const,
	tokenRef: "synthetic-token-reference",
	error: null,
	servers: [
		{
			name: "Synthetic Plex",
			clientIdentifier: "synthetic-server",
			version: "1.0",
			connections: [
				{ uri: "http://plex.synthetic.invalid", local: true, relay: false, reachable: true },
			],
		},
	],
	startOAuth: vi.fn(),
	cancel: vi.fn(),
}));
// Only the external consent popup is replaced; autofill and transport remain real.
vi.mock("../../../../hooks/api/usePlexOAuth", () => ({ usePlexOAuth: () => oauth }));

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
			join(process.env.V4_EVIDENCE_ROOT, "services-management-requests.json"),
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
const service = (
	id: string,
	label: string,
	kind: ServiceInstanceSummary["service"],
): ServiceInstanceSummary => ({
	id,
	label,
	service: kind,
	baseUrl: "http://synthetic.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "verified",
		kind: "synthetic",
		fingerprint: "synthetic",
		verifiedAt: "2026-10-25T12:00:00Z",
		lastCheckedAt: "2026-10-25T12:00:00Z",
	},
	createdAt: "2026-10-25T12:00:00Z",
	updatedAt: "2026-10-25T12:00:00Z",
	tags: [],
});

let services: ServiceInstanceSummary[];
let refused: boolean;
let gate: ReturnType<typeof hold> | null;
beforeEach(() => {
	services = [service("source-a", "Synthetic A", "radarr")];
	refused = false;
	gate = null;
	respond = async ({ url, method, body }) => {
		if (method === "GET" && url === "/api/services") return json({ services });
		if (
			method === "POST" &&
			(url === "/api/services/test-connection" || url === "/api/services/source-b/test")
		)
			return json({
				success: false,
				message: "Synthetic connection failed",
				error: "Synthetic unreachable",
				details: "Synthetic timeout",
				version: null,
			});
		if (gate) await gate.promise;
		if (refused) return json({ error: "Synthetic save refused" }, 503);
		if (method === "POST" && url === "/api/services") {
			const p = body as Record<string, unknown>;
			services = [
				services[0]!,
				{ ...service("source-b", String(p.label), "radarr"), baseUrl: String(p.baseUrl) },
			];
			return json({ service: services[1] }, 201);
		}
		if (method === "PUT" && url === "/api/services/source-b") {
			services = [services[0]!, { ...services[1]!, ...(body as object) }];
			return json({ service: services[1] });
		}
		if (method === "DELETE" && url === "/api/services/source-b") {
			services = [services[0]!];
			return json(null, 204);
		}
		throw new Error(`Unexpected request ${method} ${url}`);
	};
});
// Binding only: maintained form/card UI + real state/management/query hooks; no SettingsClient/Tags surface.
function Services() {
	const q = useServicesQuery();
	const f = useServiceFormState();
	const m = useServicesManagement();
	const list = q.data ?? [];
	return (
		<>
			<ServicesTab
				services={list}
				isLoading={q.isLoading}
				onTestConnection={m.handleTestConnection}
				onEdit={f.handleEdit}
				onToggleDefault={m.toggleDefault}
				onToggleEnabled={m.toggleEnabled}
				onDelete={(s) => void m.handleDeleteService(s, f.selectedServiceForEdit, f.resetForm)}
				onInspectIdentity={m.inspectIdentity}
				testingConnection={m.testingConnection}
				testResult={m.testResult}
				mutationPending={m.updateServiceMutation.isPending || m.deleteServiceMutation.isPending}
			/>
			<ServiceForm
				formState={f.formState}
				onFormStateChange={f.setFormState}
				onSubmit={(e) => {
					e.preventDefault();
					void m.handleSubmit(f.formState, f.selectedServiceForEdit, f.resetForm);
				}}
				onCancel={() => f.resetForm(f.formState.service)}
				onTestConnection={(draft) =>
					void m.handleTestFormConnection(draft ?? f.formState, f.selectedServiceForEdit)
				}
				selectedService={f.selectedServiceForEdit}
				services={list}
				availableTags={[]}
				isCreating={m.createServiceMutation.isPending}
				isUpdating={m.updateServiceMutation.isPending}
				isTesting={m.testingFormConnection}
				testResult={m.formTestResult}
				identityFlow={m.identityFlow}
				onConfirmIdentity={m.confirmIdentity}
				onDismissIdentityFlow={m.dismissIdentityFlow}
				onInspectIdentity={() => {
					if (f.selectedServiceForEdit) void m.inspectIdentity(f.selectedServiceForEdit);
				}}
			/>
		</>
	);
}
function card(name: string) {
	return within(screen.getByText(name).closest("div.group")!);
}

describe("composed OAuth autofill and explicit persistence", () => {
	function oauthTransport() {
		respond = async ({ url, method, body }) => {
			if (method === "GET" && url === "/api/services") return json({ services });
			if (url === "/api/plex/oauth/token") return json({ authToken: "synthetic-plex-key" });
			if (url === "/api/seerr/oauth/fetch-key") {
				if (gate) await gate.promise;
				return json({ apiKey: "synthetic-seerr-key" });
			}
			if (url === "/api/services/test-connection")
				return json({ success: true, message: "Synthetic connection verified", version: "1.0" });
			if (method === "POST" && url === "/api/services") {
				const p = body as Record<string, unknown>;
				const created = {
					...service("source-b", String(p.label), p.service as ServiceInstanceSummary["service"]),
					baseUrl: String(p.baseUrl),
				};
				services = [...services, created];
				return json({ service: created }, 201);
			}
			throw new Error(`Unexpected OAuth request ${method} ${url}`);
		};
	}
	const connectionTests = () => writes().filter((r) => r.url.endsWith("/test-connection"));
	const persisted = () => writes().filter((r) => r.url === "/api/services");

	it("tests the selected Plex draft with its retrieved token and saves only explicitly", async () => {
		oauthTransport();
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "plex" }));
		fireEvent.click(screen.getByRole("button", { name: /http:\/\/plex.synthetic.invalid/ }));
		await waitFor(() =>
			expect(screen.getByLabelText(/^API Key/)).toHaveValue("synthetic-plex-key"),
		);
		await waitFor(() => expect(connectionTests()).toHaveLength(1));
		expect(connectionTests()[0]?.body).toEqual({
			service: "plex",
			baseUrl: "http://plex.synthetic.invalid",
			apiKey: "synthetic-plex-key",
		});
		await screen.findByText("Synthetic connection verified");
		expect(screen.getByLabelText(/Label/)).toHaveValue("Synthetic Plex");
		expect(persisted()).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Add service" }));
		await waitFor(() => expect(persisted()).toHaveLength(1));
		expect(persisted()[0]?.body).toMatchObject({
			label: "Synthetic Plex",
			service: "plex",
			baseUrl: "http://plex.synthetic.invalid",
			apiKey: "synthetic-plex-key",
		});
	});

	it("tests the Seerr parent draft with its fetched key and saves only explicitly", async () => {
		oauthTransport();
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "seerr" }));
		fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "Synthetic Seerr" } });
		fireEvent.change(screen.getByLabelText(/^Base URL/), {
			target: { value: "http://seerr.synthetic.invalid" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign in to Seerr with Plex" }));
		await waitFor(() =>
			expect(screen.getByLabelText(/^API Key/)).toHaveValue("synthetic-seerr-key"),
		);
		await waitFor(() => expect(connectionTests()).toHaveLength(1));
		expect(connectionTests()[0]?.body).toEqual({
			service: "seerr",
			baseUrl: "http://seerr.synthetic.invalid",
			apiKey: "synthetic-seerr-key",
		});
		await screen.findByText("Synthetic connection verified");
		expect(persisted()).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Add service" }));
		await waitFor(() => expect(persisted()).toHaveLength(1));
		expect(persisted()[0]?.body).toMatchObject({
			label: "Synthetic Seerr",
			service: "seerr",
			baseUrl: "http://seerr.synthetic.invalid",
			apiKey: "synthetic-seerr-key",
		});
	});

	it.each(["cancel", "url-change", "service-change"])(
		"ignores late Seerr key after %s",
		async (change) => {
			oauthTransport();
			gate = hold();
			show(<Services />);
			await screen.findByText("Synthetic A");
			fireEvent.click(screen.getByRole("button", { name: "seerr" }));
			fireEvent.change(screen.getByLabelText(/^Base URL/), {
				target: { value: "http://seerr.synthetic.invalid" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Sign in to Seerr with Plex" }));
			await waitFor(() =>
				expect(writes().filter((r) => r.url === "/api/seerr/oauth/fetch-key")).toHaveLength(1),
			);
			if (change === "cancel")
				fireEvent.click(
					within(screen.getByText("Fetching Seerr API key...").parentElement!).getByRole("button", {
						name: "Cancel",
					}),
				);
			if (change === "url-change")
				fireEvent.change(screen.getByLabelText(/^Base URL/), {
					target: { value: "http://other.synthetic.invalid" },
				});
			if (change === "service-change")
				fireEvent.click(screen.getByRole("button", { name: "radarr" }));
			await act(async () => {
				gate!.release();
				await Promise.allSettled([...active]);
			});
			expect(screen.getByLabelText(/^API Key/)).toHaveValue("");
			expect(connectionTests()).toHaveLength(0);
			expect(persisted()).toHaveLength(0);
		},
	);

	it("does not let a cancelled Seerr attempt overwrite or complete its explicit retry", async () => {
		oauthTransport();
		const normal = respond;
		const old = hold();
		const current = hold();
		let fetches = 0;
		respond = async (request) => {
			if (request.url !== "/api/seerr/oauth/fetch-key") return normal(request);
			const first = ++fetches === 1;
			await (first ? old : current).promise;
			return json({ apiKey: first ? "obsolete-key" : "current-key" });
		};
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "seerr" }));
		fireEvent.change(screen.getByLabelText(/^Base URL/), {
			target: { value: "http://seerr.synthetic.invalid" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign in to Seerr with Plex" }));
		await waitFor(() => expect(fetches).toBe(1));
		fireEvent.click(
			within(screen.getByText("Fetching Seerr API key...").parentElement!).getByRole("button", {
				name: "Cancel",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Sign in to Seerr with Plex" }));
		await waitFor(() => expect(fetches).toBe(2));
		await act(async () => {
			old.release();
			await old.promise;
		});
		expect(screen.getByLabelText(/^API Key/)).toHaveValue("");
		expect(screen.getByText("Fetching Seerr API key...")).toBeInTheDocument();
		expect(connectionTests()).toHaveLength(0);
		await act(async () => {
			current.release();
			await current.promise;
		});
		await screen.findByText("Synthetic connection verified");
		expect(screen.getByLabelText(/^API Key/)).toHaveValue("current-key");
		expect(connectionTests()).toHaveLength(1);
		expect(connectionTests()[0]?.body).toMatchObject({ apiKey: "current-key" });
		expect(persisted()).toHaveLength(0);
	});

	it.each(["draft-edit", "service-change"])("ignores late Plex token after %s", async (change) => {
		oauthTransport();
		const normal = respond;
		const token = hold();
		respond = async (request) => {
			if (request.url === "/api/plex/oauth/token") await token.promise;
			return normal(request);
		};
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "plex" }));
		fireEvent.click(screen.getByRole("button", { name: /http:\/\/plex.synthetic.invalid/ }));
		await waitFor(() =>
			expect(writes().filter((r) => r.url === "/api/plex/oauth/token")).toHaveLength(1),
		);
		if (change === "draft-edit")
			fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "My current edit" } });
		else fireEvent.click(screen.getByRole("button", { name: "radarr" }));
		await act(async () => {
			token.release();
			await Promise.allSettled([...active]);
		});
		expect(screen.getByLabelText(/^API Key/)).toHaveValue("");
		if (change === "draft-edit")
			expect(screen.getByLabelText(/Label/)).toHaveValue("My current edit");
		expect(connectionTests()).toHaveLength(0);
		expect(persisted()).toHaveLength(0);
	});

	it("fences an obsolete Plex rescan response and retains the current single-consumer gate", async () => {
		oauthTransport();
		const normal = respond;
		const old = hold();
		const current = hold();
		let fetches = 0;
		respond = async (request) => {
			if (request.url !== "/api/plex/oauth/token") return normal(request);
			const first = ++fetches === 1;
			await (first ? old : current).promise;
			return json({ authToken: first ? "obsolete-token" : "current-token" });
		};
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "plex" }));
		fireEvent.click(screen.getByRole("button", { name: /http:\/\/plex.synthetic.invalid/ }));
		await waitFor(() => expect(fetches).toBe(1));
		fireEvent.click(screen.getByRole("button", { name: "Re-scan" }));
		fireEvent.click(screen.getByRole("button", { name: /http:\/\/plex.synthetic.invalid/ }));
		await waitFor(() => expect(fetches).toBe(2));
		await act(async () => {
			old.release();
			await old.promise;
		});
		expect(screen.getByLabelText(/^API Key/)).toHaveValue("");
		const connection = screen.getByRole("button", { name: /http:\/\/plex.synthetic.invalid/ });
		expect(connection).toBeDisabled();
		fireEvent.click(connection);
		expect(fetches).toBe(2);
		await act(async () => {
			current.release();
			await current.promise;
		});
		await screen.findByText("Synthetic connection verified");
		expect(connectionTests()).toHaveLength(1);
		expect(connectionTests()[0]?.body).toMatchObject({ apiKey: "current-token" });
		expect(persisted()).toHaveLength(0);
	});

	it("keeps fetch and connection-test failures honest until explicit retries without saving", async () => {
		oauthTransport();
		const normal = respond;
		let fetches = 0;
		let tests = 0;
		respond = async (request) => {
			if (request.url === "/api/seerr/oauth/fetch-key" && ++fetches === 1)
				return json({ error: "Synthetic key unavailable" }, 503);
			if (request.url === "/api/services/test-connection" && ++tests === 1)
				return json({ error: "Synthetic test unavailable" }, 503);
			return normal(request);
		};
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "seerr" }));
		fireEvent.change(screen.getByLabelText(/^Base URL/), {
			target: { value: "http://seerr.synthetic.invalid" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign in to Seerr with Plex" }));
		await screen.findByText("Synthetic key unavailable");
		expect(connectionTests()).toHaveLength(0);
		expect(screen.getByLabelText(/^API Key/)).toHaveValue("");
		fireEvent.click(screen.getByRole("button", { name: "Sign in to Seerr with Plex" }));
		await screen.findByText("Synthetic test unavailable");
		expect(fetches).toBe(2);
		expect(connectionTests()).toHaveLength(1);
		expect(persisted()).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: /Test connection/i }));
		await screen.findByText("Synthetic connection verified");
		expect(connectionTests()).toHaveLength(2);
		expect(persisted()).toHaveLength(0);
	});

	it.each(["plex", "seerr"] as const)(
		"ignores failed credential completion after editing the %s draft",
		async (kind) => {
			oauthTransport();
			const normal = respond;
			const response = hold();
			const endpoint = kind === "plex" ? "/api/plex/oauth/token" : "/api/seerr/oauth/fetch-key";
			respond = async (request) => {
				if (request.url !== endpoint) return normal(request);
				await response.promise;
				return json({ error: "Synthetic obsolete credential failure" }, 503);
			};
			show(<Services />);
			await screen.findByText("Synthetic A");
			fireEvent.click(screen.getByRole("button", { name: kind }));
			if (kind === "plex")
				fireEvent.click(screen.getByRole("button", { name: /http:\/\/plex.synthetic.invalid/ }));
			else {
				fireEvent.change(screen.getByLabelText(/^Base URL/), {
					target: { value: "http://seerr.synthetic.invalid" },
				});
				fireEvent.click(screen.getByRole("button", { name: "Sign in to Seerr with Plex" }));
			}
			await waitFor(() => expect(writes().filter((r) => r.url === endpoint)).toHaveLength(1));
			fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "My current edit" } });
			const popupStarts = oauth.startOAuth.mock.calls.length;
			await act(async () => {
				response.release();
				await Promise.allSettled([...active]);
			});
			expect(screen.getByLabelText(/Label/)).toHaveValue("My current edit");
			expect(screen.getByLabelText(/^API Key/)).toHaveValue("");
			expect(screen.queryByText("Synthetic obsolete credential failure")).not.toBeInTheDocument();
			expect(oauth.startOAuth.mock.calls).toHaveLength(popupStarts);
			expect(connectionTests()).toHaveLength(0);
			expect(persisted()).toHaveLength(0);
		},
	);

	it.each(["plex", "seerr"] as const)(
		"tests a reauthenticated %s edit and persists its new secret only on Save",
		async (kind) => {
			services.push(service("source-b", "Synthetic existing", kind));
			oauthTransport();
			const normal = respond;
			respond = async (request) => {
				if (request.method === "PUT" && request.url === "/api/services/source-b") {
					const p = request.body as Record<string, unknown>;
					services[1] = { ...services[1]!, label: String(p.label), baseUrl: String(p.baseUrl) };
					return json({ service: services[1] });
				}
				return normal(request);
			};
			show(<Services />);
			await screen.findByText("Synthetic existing");
			fireEvent.click(card("Synthetic existing").getByRole("button", { name: "Edit" }));
			expect(screen.getByPlaceholderText("Leave blank to keep current key")).toHaveValue("");
			if (kind === "plex")
				fireEvent.click(screen.getByRole("button", { name: /http:\/\/plex.synthetic.invalid/ }));
			else fireEvent.click(screen.getByRole("button", { name: "Re-authenticate Seerr with Plex" }));
			await screen.findByText("Synthetic connection verified");
			expect(connectionTests()).toHaveLength(1);
			expect(connectionTests()[0]?.body).toEqual({
				service: kind,
				baseUrl: kind === "plex" ? "http://plex.synthetic.invalid" : "http://synthetic.invalid",
				apiKey: kind === "plex" ? "synthetic-plex-key" : "synthetic-seerr-key",
			});
			expect(writes().filter((r) => r.method === "PUT")).toHaveLength(0);
			fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
			await waitFor(() => expect(writes().filter((r) => r.method === "PUT")).toHaveLength(1));
			expect(writes().find((r) => r.method === "PUT")).toMatchObject({
				url: "/api/services/source-b",
				body: { apiKey: kind === "plex" ? "synthetic-plex-key" : "synthetic-seerr-key" },
			});
		},
	);
});

describe("S1 maintained Services management transport", () => {
	it("tests unsaved normalized connection, creates B once, preserves blank stored secret on refused/edit save and reads current list", async () => {
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "radarr" }));
		fireEvent.change(screen.getByLabelText(/Label/), { target: { value: " Synthetic B " } });
		fireEvent.change(screen.getByLabelText(/^Base URL/), {
			target: { value: "http://synthetic.invalid" },
		});
		fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: " synthetic-key " } });
		fireEvent.click(screen.getByRole("button", { name: /Test connection/i }));
		await screen.findByText("Synthetic unreachable");
		expect(writes()[0]).toEqual({
			url: "/api/services/test-connection",
			method: "POST",
			body: { baseUrl: "http://synthetic.invalid", apiKey: "synthetic-key", service: "radarr" },
		});
		gate = hold();
		const add = screen.getByRole("button", { name: "Add service" });
		fireEvent.click(add);
		await waitFor(() => expect(writes()).toHaveLength(2));
		await waitFor(() => expect(add).toBeDisabled());
		fireEvent.click(add);
		await act(async () => {
			gate!.release();
		});
		gate = null;
		await screen.findByText("Synthetic B");
		await settled();
		expect(writes()[1]).toEqual({
			url: "/api/services",
			method: "POST",
			body: {
				label: "Synthetic B",
				baseUrl: "http://synthetic.invalid",
				externalUrl: null,
				apiKey: "synthetic-key",
				service: "radarr",
				enabled: true,
				isDefault: false,
				tags: [],
				storageGroupId: null,
			},
		});
		fireEvent.click(card("Synthetic B").getByRole("button", { name: "Edit" }));
		expect(screen.getByPlaceholderText("Leave blank to keep current key")).toHaveValue("");
		fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "Synthetic renamed" } });
		refused = true;
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("Synthetic save refused");
		await settled();
		expect(screen.getByLabelText(/Label/)).toHaveValue("Synthetic renamed");
		refused = false;
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await screen.findByText("Synthetic renamed");
		await settled();
		expect(writes()[3]).toEqual({
			url: "/api/services/source-b",
			method: "PUT",
			body: {
				label: "Synthetic renamed",
				baseUrl: "http://synthetic.invalid",
				externalUrl: null,
				service: "radarr",
				enabled: true,
				isDefault: false,
				tags: [],
				storageGroupId: null,
			},
		});
		expect(
			requests.filter((r) => r.url === "/api/services" && r.method === "GET").length,
		).toBeGreaterThan(2);
	});
	it("tests, toggles and two-step deletes exact existing B while A remains", async () => {
		services.push(service("source-b", "Synthetic B", "radarr"));
		show(<Services />);
		await screen.findByText("Synthetic B");
		fireEvent.click(card("Synthetic B").getByRole("button", { name: "Test" }));
		await screen.findByText("Synthetic unreachable: Synthetic timeout");
		await settled();
		expect(writes()[0]).toEqual({ url: "/api/services/source-b/test", method: "POST", body: {} });
		fireEvent.click(card("Synthetic B").getByRole("button", { name: "Disable" }));
		await waitFor(() =>
			expect(card("Synthetic B").getByRole("button", { name: "Enable" })).toBeInTheDocument(),
		);
		expect(writes()[1]).toEqual({
			url: "/api/services/source-b",
			method: "PUT",
			body: { enabled: false },
		});
		fireEvent.click(card("Synthetic B").getByTitle("Delete service"));
		expect(writes()).toHaveLength(2);
		fireEvent.click(card("Synthetic B").getByTitle("Click again to confirm deletion"));
		await waitFor(() => expect(screen.queryByText("Synthetic B")).not.toBeInTheDocument());
		expect(screen.getByText("Synthetic A")).toBeInTheDocument();
		expect(writes()[2]).toEqual({ url: "/api/services/source-b", method: "DELETE", body: null });
	});
});
