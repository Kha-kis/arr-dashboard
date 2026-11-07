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
	const m = useServicesManagement({
		formState: f.formState,
		selectedServiceId: f.selectedServiceForEdit?.id,
	});
	const list = q.data ?? [];
	return (
		<>
			<ServicesTab
				services={list}
				isLoading={q.isLoading}
				onTestConnection={m.handleTestConnection}
				onEdit={(instance) => {
					m.dismissIdentityFlow();
					f.handleEdit(instance);
				}}
				onToggleDefault={m.toggleDefault}
				onToggleEnabled={m.toggleEnabled}
				onDelete={(s) => void m.handleDeleteService(s, f.selectedServiceForEdit, f.resetForm)}
				onInspectIdentity={(instance) => {
					f.handleEdit(instance);
					void m.inspectIdentity(instance);
				}}
				testingConnection={m.testingConnection}
				testResult={m.testResult}
				mutationPending={m.updateServiceMutation.isPending || m.deleteServiceMutation.isPending}
			/>
			<ServiceForm
				formState={f.formState}
				onFormStateChange={f.setFormState}
				onSubmit={(e) => {
					e.preventDefault();
					m.resetFormTestResult();
					void m.handleSubmit(f.formState, f.selectedServiceForEdit, f.resetForm);
				}}
				onCancel={() => {
					m.dismissIdentityFlow();
					f.resetForm(f.formState.service);
				}}
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

describe("identity cancellation and current candidate feedback", () => {
	const inspected = (fingerprint = "111111111111", digest = "a".repeat(64)) => ({
		candidate: {
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			fingerprint,
			confirmationDigest: digest,
		},
		connectionGeneration: 4,
		identityGeneration: 2,
	});
	const inspect = () =>
		fireEvent.click(card("Synthetic A").getByRole("button", { name: /Verify identity/ }));
	const confirm = () => screen.getByRole("button", { name: "Confirm verification" });
	const inspectUrl = "/api/services/source-a/identity/inspect";
	const verifyUrl = "/api/services/source-a/identity/verify";
	beforeEach(() => {
		services = [
			{
				...service("source-a", "Synthetic A", "jellyfin"),
				identity: {
					status: "unverified",
					kind: null,
					fingerprint: null,
					verifiedAt: null,
					lastCheckedAt: null,
				},
			},
		];
		respond = async ({ url, method }) => {
			if (method === "GET" && url === "/api/services") return json({ services });
			if (method === "POST" && url === inspectUrl) return json(inspected());
			throw new Error(`Unexpected identity request ${method} ${url}`);
		};
	});
	async function opened() {
		show(<Services />);
		await screen.findByText("Synthetic A");
		inspect();
		await screen.findByText(/Candidate: jellyfin-server-id/);
	}
	async function release(response: ReturnType<typeof hold>) {
		await act(async () => {
			response.release();
			await Promise.allSettled([...active]);
		});
	}

	it("Keep editing dismisses the candidate, preserves the draft and never confirms implicitly", async () => {
		await opened();
		fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "Still editing" } });
		fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
		expect(screen.queryByText(/Candidate:/)).not.toBeInTheDocument();
		expect(screen.getByLabelText(/Label/)).toHaveValue("Still editing");
		expect(writes()).toEqual([{ url: inspectUrl, method: "POST", body: {} }]);
	});

	it("Cancel discards a completed identity candidate even when the same instance is edited again", async () => {
		await opened();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(card("Synthetic A").getByRole("button", { name: "Edit" }));
		expect(screen.queryByText(/Candidate:/)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Confirm verification" })).not.toBeInTheDocument();
		expect(writes()).toEqual([{ url: inspectUrl, method: "POST", body: {} }]);
	});

	it("Cancel invalidates an inspection response that arrives after the form was reset", async () => {
		const response = hold();
		const normal = respond;
		respond = async (request) => {
			if (request.url === inspectUrl) await response.promise;
			return normal(request);
		};
		show(<Services />);
		await screen.findByText("Synthetic A");
		inspect();
		await waitFor(() => expect(writes()).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await release(response);
		fireEvent.click(card("Synthetic A").getByRole("button", { name: "Edit" }));
		expect(screen.queryByText(/Candidate:/)).not.toBeInTheDocument();
		expect(writes()).toEqual([{ url: inspectUrl, method: "POST", body: {} }]);
	});

	it("an older inspection cannot replace the newest explicitly inspected candidate", async () => {
		const response = hold();
		const normal = respond;
		let inspections = 0;
		respond = async (request) => {
			if (request.url !== inspectUrl) return normal(request);
			if (++inspections === 1) {
				await response.promise;
				return json(inspected());
			}
			return json(inspected("222222222222", "b".repeat(64)));
		};
		show(<Services />);
		await screen.findByText("Synthetic A");
		inspect();
		await waitFor(() => expect(inspections).toBe(1));
		inspect();
		await screen.findByText(/Candidate:.*222222222222/);
		await release(response);
		expect(screen.getByText(/Candidate:.*222222222222/)).toBeInTheDocument();
		expect(writes()).toEqual([1, 2].map(() => ({ url: inspectUrl, method: "POST", body: {} })));
	});

	it("a cancelled inspection failure cannot publish an obsolete error", async () => {
		const response = hold();
		const normal = respond;
		respond = async (request) => {
			if (request.url !== inspectUrl) return normal(request);
			await response.promise;
			return json({ error: "Synthetic old inspection refused" }, 503);
		};
		show(<Services />);
		await screen.findByText("Synthetic A");
		inspect();
		await waitFor(() => expect(writes()).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await release(response);
		expect(screen.queryByText("Synthetic old inspection refused")).not.toBeInTheDocument();
		expect(
			toast
				.getHistory()
				.some((entry) => "title" in entry && entry.title === "Synthetic old inspection refused"),
		).toBe(false);
		expect(writes()).toHaveLength(1);
	});

	it("an obsolete confirmation conflict cannot change a newly inspected candidate", async () => {
		const response = hold();
		const normal = respond;
		let inspections = 0;
		respond = async (request) => {
			if (request.url === inspectUrl) {
				inspections++;
				return json(inspections === 1 ? inspected() : inspected("222222222222", "b".repeat(64)));
			}
			if (request.url === verifyUrl) {
				await response.promise;
				return json(
					{
						error: "Synthetic old confirmation conflict",
						details: { code: "IDENTITY_GENERATION_STALE", ...inspected() },
					},
					409,
				);
			}
			return normal(request);
		};
		await opened();
		fireEvent.click(confirm());
		await waitFor(() => expect(writes()).toHaveLength(2));
		fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
		inspect();
		await screen.findByText(/Candidate:.*222222222222/);
		await release(response);
		expect(screen.getByText(/Candidate:.*222222222222/)).toBeInTheDocument();
		expect(confirm()).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Inspect again" })).not.toBeInTheDocument();
		expect(writes()).toEqual([
			{ url: inspectUrl, method: "POST", body: {} },
			{
				url: verifyUrl,
				method: "POST",
				body: {
					confirmationDigest: "a".repeat(64),
					expectedConnectionGeneration: 4,
					expectedIdentityGeneration: 2,
				},
			},
			{ url: inspectUrl, method: "POST", body: {} },
		]);
	});

	it("a current confirmation refusal keeps the candidate for explicit exact retry and acknowledged readback", async () => {
		const normal = respond;
		let attempts = 0;
		respond = async (request) => {
			if (request.url !== verifyUrl) return normal(request);
			if (++attempts === 1) return json({ error: "Synthetic current confirmation refused" }, 503);
			services = [
				{
					...services[0]!,
					identity: {
						status: "verified",
						kind: "jellyfin-server-id",
						fingerprint: "111111111111",
						verifiedAt: "2026-10-25T12:00:00Z",
						lastCheckedAt: "2026-10-25T12:00:00Z",
					},
				},
			];
			return json({ service: services[0] });
		};
		await opened();
		fireEvent.click(confirm());
		await screen.findByText("Synthetic current confirmation refused");
		expect(confirm()).toBeEnabled();
		expect(screen.getByText(/Candidate:.*111111111111/)).toBeInTheDocument();
		fireEvent.click(confirm());
		await waitFor(() => expect(screen.queryByText(/Candidate:/)).not.toBeInTheDocument());
		expect(card("Synthetic A").getByText(/Verified jellyfin-server-id/)).toBeInTheDocument();
		expect(writes()).toEqual([
			{ url: inspectUrl, method: "POST", body: {} },
			...[1, 2].map(() => ({
				url: verifyUrl,
				method: "POST",
				body: {
					confirmationDigest: "a".repeat(64),
					expectedConnectionGeneration: 4,
					expectedIdentityGeneration: 2,
				},
			})),
		]);
	});

	it("a superseded Save conflict cannot resurrect a replacement candidate on re-edit", async () => {
		services.push(service("source-b", "Synthetic B", "jellyfin"));
		const response = hold();
		const normal = respond;
		respond = async (request) => {
			if (request.url !== "/api/services/source-a" || request.method !== "PUT")
				return normal(request);
			await response.promise;
			return json(
				{
					error: "Synthetic old Save conflict",
					details: {
						code: "IDENTITY_REPLACEMENT_REQUIRED",
						...inspected(),
					},
				},
				409,
			);
		};
		show(<Services />);
		await screen.findByText("Synthetic B");
		fireEvent.click(card("Synthetic A").getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		fireEvent.click(card("Synthetic B").getByRole("button", { name: "Edit" }));
		await release(response);
		fireEvent.click(card("Synthetic A").getByRole("button", { name: "Edit" }));
		expect(screen.queryByText(/Candidate:/)).not.toBeInTheDocument();
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({ url: "/api/services/source-a", method: "PUT" });
	});

	it("a new inspection blocks old confirmation through refusal until an explicit successful reinspection", async () => {
		const response = hold();
		const normal = respond;
		let inspections = 0;
		respond = async (request) => {
			if (request.url !== inspectUrl) return normal(request);
			if (++inspections === 2) {
				await response.promise;
				return json({ error: "Synthetic current inspection refused" }, 503);
			}
			return json(inspections === 1 ? inspected() : inspected("222222222222", "b".repeat(64)));
		};
		await opened();
		inspect();
		await waitFor(() => expect(inspections).toBe(2));
		expect(confirm()).toBeDisabled();
		await release(response);
		await screen.findByText("Synthetic current inspection refused");
		expect(confirm()).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Inspect again" }));
		await screen.findByText(/Candidate:.*222222222222/);
		expect(confirm()).toBeEnabled();
		expect(writes()).toEqual([1, 2, 3].map(() => ({ url: inspectUrl, method: "POST", body: {} })));
	});
});

describe("remaining Services form controls", () => {
	async function draft() {
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "radarr" }));
		fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "Synthetic B" } });
		fireEvent.change(screen.getByLabelText(/^Base URL/), {
			target: { value: "http://synthetic.invalid" },
		});
		fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "synthetic-key" } });
	}
	function acceptCreate() {
		const normal = respond;
		respond = async (request) => {
			if (request.url !== "/api/services" || request.method !== "POST") return normal(request);
			const p = request.body as { label: string; tags: string[]; httpAuth?: unknown };
			const created = {
				...service("source-b", p.label, "radarr"),
				hasHttpAuth: Boolean(p.httpAuth),
				tags: p.tags.map((name, index) => ({ id: `synthetic-tag-${index}`, name })),
			};
			services = [services[0]!, created];
			return json({ service: created }, 201);
		};
	}

	it("exposes the named Service group and its actual selected choice", async () => {
		show(<Services />);
		await screen.findByText("Synthetic A");
		const choices = within(screen.getByRole("group", { name: "Service" }));
		expect(choices.getByRole("button", { name: "sonarr", pressed: true })).toBeInTheDocument();
		fireEvent.click(choices.getByRole("button", { name: "radarr", pressed: false }));
		expect(choices.getByRole("button", { name: "radarr", pressed: true })).toBeInTheDocument();
		expect(choices.getByRole("button", { name: "sonarr", pressed: false })).toBeInTheDocument();
		expect(writes()).toHaveLength(0);
	});

	it("labels Tags and normalizes nonempty comma-separated tags in the explicit create payload/readback", async () => {
		acceptCreate();
		await draft();
		fireEvent.change(screen.getByLabelText("Tags"), { target: { value: " alpha, , beta " } });
		fireEvent.click(screen.getByRole("button", { name: "Add service" }));
		await screen.findByText("Synthetic B");
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({
			url: "/api/services",
			method: "POST",
			body: { label: "Synthetic B", tags: ["alpha", "beta"] },
		});
		expect(card("Synthetic B").getByText("alpha")).toBeInTheDocument();
		expect(card("Synthetic B").getByText("beta")).toBeInTheDocument();
	});

	it.each(["username", "password"])(
		"rejects a lone Basic-auth %s before Test and Save, then sends the completed pair explicitly",
		async (only) => {
			acceptCreate();
			await draft();
			fireEvent.click(screen.getByRole("checkbox", { name: /Reverse proxy HTTP Basic Auth/ }));
			fireEvent.change(
				screen.getByLabelText(only === "username" ? "HTTP username" : "HTTP password"),
				{
					target: { value: only === "username" ? " proxy-user " : "synthetic-http-secret" },
				},
			);
			fireEvent.click(screen.getByRole("button", { name: /^Test connection/ }));
			await screen.findByText("Enter both HTTP Basic Auth fields to test unsaved credentials");
			expect(writes()).toHaveLength(0);
			fireEvent.click(screen.getByRole("button", { name: "Add service" }));
			await screen.findByText("Enter both an HTTP Basic Auth username and password");
			expect(writes()).toHaveLength(0);
			fireEvent.change(
				screen.getByLabelText(only === "username" ? "HTTP password" : "HTTP username"),
				{
					target: { value: only === "username" ? "synthetic-http-secret" : " proxy-user " },
				},
			);
			fireEvent.click(screen.getByRole("button", { name: /^Test connection/ }));
			await screen.findByText("Synthetic unreachable");
			expect(writes()).toHaveLength(1);
			expect(writes()[0]).toEqual({
				url: "/api/services/test-connection",
				method: "POST",
				body: {
					service: "radarr",
					baseUrl: "http://synthetic.invalid",
					apiKey: "synthetic-key",
					httpAuth: { username: "proxy-user", password: "synthetic-http-secret" },
				},
			});
			fireEvent.click(screen.getByRole("button", { name: "Add service" }));
			await screen.findByText("Synthetic B");
			expect(writes()).toHaveLength(2);
			expect(writes()[1]).toMatchObject({
				url: "/api/services",
				method: "POST",
				body: { httpAuth: { username: "proxy-user", password: "synthetic-http-secret" } },
			});
		},
	);

	it("changes only the selected default after refusal and an explicit pending retry", async () => {
		services[0] = { ...services[0]!, isDefault: true };
		services.push(service("source-b", "Synthetic B", "radarr"));
		services.push({ ...service("source-c", "Synthetic C", "sonarr"), isDefault: true });
		const response = hold();
		let attempts = 0;
		respond = async (request) => {
			if (request.method === "GET" && request.url === "/api/services") return json({ services });
			if (request.method === "PUT" && request.url === "/api/services/source-b") {
				if (++attempts === 1) return json({ error: "Synthetic default refused" }, 503);
				await response.promise;
				services = [
					{ ...services[0]!, isDefault: false },
					{ ...services[1]!, isDefault: true },
					services[2]!,
				];
				return json({ service: services[1] });
			}
			throw new Error(`Unexpected default request ${request.method} ${request.url}`);
		};
		show(<Services />);
		await screen.findByText("Synthetic B");
		fireEvent.click(card("Synthetic B").getByRole("button", { name: "Set default" }));
		await screen.findByText("Synthetic default refused");
		expect(card("Synthetic A").getByText("Default")).toBeInTheDocument();
		expect(card("Synthetic C").getByText("Default")).toBeInTheDocument();
		const retry = card("Synthetic B").getByRole("button", { name: "Set default" });
		fireEvent.click(retry);
		await waitFor(() => expect(attempts).toBe(2));
		expect(retry).toBeDisabled();
		fireEvent.click(retry);
		expect(attempts).toBe(2);
		await act(async () => {
			response.release();
			await Promise.allSettled([...active]);
		});
		await waitFor(() => expect(card("Synthetic B").getByText("Default")).toBeInTheDocument());
		expect(card("Synthetic A").queryByText("Default")).not.toBeInTheDocument();
		expect(card("Synthetic C").getByText("Default")).toBeInTheDocument();
		expect(writes()).toEqual(
			[0, 1].map(() => ({
				url: "/api/services/source-b",
				method: "PUT",
				body: { service: "radarr", isDefault: true },
			})),
		);
	});
});

describe("connection Test feedback belongs to the tested target", () => {
	const testButton = () => screen.getByRole("button", { name: /^Test(ing)? connection/ });
	async function manualDraft() {
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(screen.getByRole("button", { name: "radarr" }));
		fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "Synthetic draft" } });
		fireEvent.change(screen.getByLabelText(/^Base URL/), {
			target: { value: "http://first.synthetic.invalid" },
		});
		fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "first-key" } });
	}
	function transport(test: (request: Request) => Promise<Response>) {
		respond = async (request) => {
			if (request.method === "GET" && request.url === "/api/services") return json({ services });
			if (request.url.endsWith("/test") || request.url === "/api/services/test-connection")
				return test(request);
			if (request.method === "POST" && request.url === "/api/services")
				return json({ error: "Synthetic save refused" }, 503);
			throw new Error(`Unexpected scoped Test request ${request.method} ${request.url}`);
		};
	}
	const tests = () =>
		writes().filter((r) => r.url.endsWith("/test") || r.url.endsWith("/test-connection"));

	it.each(["success", "failure"])(
		"ignores an obsolete Test %s after URL change",
		async (outcome) => {
			const response = hold();
			transport(async () => {
				await response.promise;
				return outcome === "success"
					? json({ success: true, message: "Obsolete connection success", version: "1" })
					: json({ error: "Obsolete connection failure" }, 503);
			});
			await manualDraft();
			fireEvent.click(testButton());
			await waitFor(() => expect(tests()).toHaveLength(1));
			fireEvent.change(screen.getByLabelText(/^Base URL/), {
				target: { value: "http://second.synthetic.invalid" },
			});
			await act(async () => {
				response.release();
				await Promise.allSettled([...active]);
			});
			expect(screen.queryByText(/Obsolete connection/)).not.toBeInTheDocument();
			expect(testButton()).toBeEnabled();
			expect(tests()).toHaveLength(1);
		},
	);

	it("hides an already completed result when the API key changes", async () => {
		transport(async () =>
			json({ success: true, message: "Previously verified draft", version: "1" }),
		);
		await manualDraft();
		fireEvent.click(testButton());
		await screen.findByText("Previously verified draft");
		fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "second-key" } });
		expect(screen.queryByText("Previously verified draft")).not.toBeInTheDocument();
		expect(tests()).toHaveLength(1);
	});

	it("retains valid connection evidence through a friendly-label edit without retesting", async () => {
		transport(async () =>
			json({ success: true, message: "Current verified connection", version: "1" }),
		);
		await manualDraft();
		fireEvent.click(testButton());
		await screen.findByText("Current verified connection");
		fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "My friendly label" } });
		expect(screen.getByText("Current verified connection")).toBeInTheDocument();
		expect(tests()).toHaveLength(1);
	});

	it("allows testing a new draft while the old request remains pending and fences its finally", async () => {
		const old = hold();
		const current = hold();
		let calls = 0;
		transport(async () => {
			const first = ++calls === 1;
			await (first ? old : current).promise;
			return json({
				success: true,
				message: first ? "Obsolete connection success" : "Current connection success",
				version: "1",
			});
		});
		await manualDraft();
		fireEvent.click(testButton());
		await waitFor(() => expect(calls).toBe(1));
		expect(testButton()).toBeDisabled();
		fireEvent.change(screen.getByLabelText(/^API Key/), { target: { value: "second-key" } });
		expect(testButton()).toBeEnabled();
		fireEvent.click(testButton());
		await waitFor(() => expect(calls).toBe(2));
		await act(async () => {
			old.release();
			await old.promise;
		});
		expect(testButton()).toBeDisabled();
		expect(screen.queryByText("Obsolete connection success")).not.toBeInTheDocument();
		await act(async () => {
			current.release();
			await Promise.allSettled([...active]);
		});
		await screen.findByText("Current connection success");
		expect(testButton()).toBeEnabled();
		expect(tests()[1]?.body).toMatchObject({ apiKey: "second-key" });
	});

	it("does not confuse two saved instances with identical URLs and blank key drafts", async () => {
		services.push(service("source-b", "Synthetic B", "radarr"));
		const old = hold();
		transport(async (request) => {
			if (request.url === "/api/services/source-a/test") {
				await old.promise;
				return json({ success: true, message: "Obsolete instance success", version: "1" });
			}
			return json({ success: true, message: "Current instance success", version: "1" });
		});
		show(<Services />);
		await screen.findByText("Synthetic A");
		fireEvent.click(card("Synthetic A").getByRole("button", { name: "Edit" }));
		fireEvent.click(testButton());
		await waitFor(() => expect(tests()).toHaveLength(1));
		fireEvent.click(card("Synthetic B").getByRole("button", { name: "Edit" }));
		expect(testButton()).toBeEnabled();
		fireEvent.click(testButton());
		await screen.findByText("Current instance success");
		await act(async () => {
			old.release();
			await Promise.allSettled([...active]);
		});
		expect(screen.queryByText("Obsolete instance success")).not.toBeInTheDocument();
		expect(screen.getByText("Current instance success")).toBeInTheDocument();
		expect(tests().map((r) => r.url)).toEqual([
			"/api/services/source-a/test",
			"/api/services/source-b/test",
		]);
	});

	it("does not resurrect a cleared in-flight result after an explicitly refused Save", async () => {
		const response = hold();
		transport(async () => {
			await response.promise;
			return json({ success: true, message: "Cleared connection success", version: "1" });
		});
		await manualDraft();
		fireEvent.click(testButton());
		await waitFor(() => expect(tests()).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Add service" }));
		await screen.findByText("Synthetic save refused");
		await act(async () => {
			response.release();
			await Promise.allSettled([...active]);
		});
		expect(screen.queryByText("Cleared connection success")).not.toBeInTheDocument();
		expect(screen.getByLabelText(/^API Key/)).toHaveValue("first-key");
		expect(tests()).toHaveLength(1);
		expect(writes().filter((r) => r.url === "/api/services")).toHaveLength(1);
	});
});

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
