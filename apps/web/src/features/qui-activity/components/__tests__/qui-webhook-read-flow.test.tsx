import type { QuiEventLogEntry, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { getLinuxInstanceName } from "../../../../lib/incognito";
import { quiKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QuiWebhookConfigPanel } from "../webhook-config-panel";

const CONFIG = "/api/qui/webhook-config";
const EVENTS = "/api/qui/events?limit=5";
const SERVICES = "/api/services";
const ROTATE = CONFIG + "/rotate";
const CALLBACK = "https://callback.synthetic.invalid/webhook?existing=synthetic%20value";
const SECRET = "synthetic secret+/&?=☃";
const FULL_URL = CALLBACK + "&secret=" + encodeURIComponent(SECRET);
const TIME = "2026-01-01T00:00:00.000Z";
const service: ServiceInstanceSummary = {
	id: "synthetic-qui",
	service: "qui",
	label: "Synthetic Private Receiver",
	baseUrl: "https://qui.synthetic.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	tags: [],
	createdAt: TIME,
	updatedAt: TIME,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
};
const event: QuiEventLogEntry = {
	id: "synthetic-event",
	serviceInstanceId: service.id,
	serviceInstanceLabel: service.label,
	eventType: "synthetic-known-event",
	torrentHash: null,
	payload: null,
	receivedAt: TIME,
	timestamp: TIME,
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unavailable = () => json({ message: "Synthetic read unavailable" }, 503);
const clients: QueryClient[] = [];
const violations: string[] = [];
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
	toast.dismiss();
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	else Reflect.deleteProperty(navigator, "clipboard");
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});
function transport(options: { allowRotate?: boolean } = {}) {
	const calls: string[] = [];
	const responses = new Map<string, () => Response>([
		[CONFIG, () => json({ hasSecret: true, webhookUrl: CALLBACK })],
		[SERVICES, () => json({ services: [service] })],
		[EVENTS, () => json({ entries: [event], nextCursor: null })],
	]);
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		const url = new URL(String(input), "https://synthetic.invalid");
		const path = url.pathname + url.search;
		const method = init?.method;
		const rotate = options.allowRotate && method === "POST" && path === ROTATE;
		if (
			url.origin !== "https://synthetic.invalid" ||
			!((method === "GET" && responses.has(path)) || (rotate && init?.body === "{}"))
		) {
			violations.push((method ?? "unknown") + " " + path);
			throw Error("Unexpected synthetic request");
		}
		calls.push(method + " " + path);
		if (rotate) return json({ hasSecret: true, webhookUrl: CALLBACK, secret: SECRET });
		return responses.get(path)!();
	});
	return { calls, responses };
}
function mount() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryDelay: 0, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<QuiWebhookConfigPanel />
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}
const notice = (category: RegExp) =>
	screen.queryAllByRole("alert").find((element) => category.test(element.textContent ?? ""));
function retryRead(category: RegExp) {
	const alert = notice(category);
	expect(alert, "A failed read needs explicit local recovery").toBeDefined();
	fireEvent.click(within(alert!).getByRole("button", { name: /retry|refresh/i }));
}
const expectOnlyReads = (calls: string[]) =>
	expect(calls.every((call) => call.startsWith("GET "))).toBe(true);

describe("qUI webhook read and local copy through real hooks and HTTP clients", () => {
	it("keeps cold config failure unknown, then recovers known config through a local GET retry", async () => {
		const { calls, responses } = transport();
		responses.set(CONFIG, unavailable);
		const client = mount();
		await screen.findByRole("radio");
		await waitFor(() => expect(client.getQueryState(quiKeys.webhookConfig)?.status).toBe("error"));
		expect.soft(screen.queryByText(/above to generate the value/i)).not.toBeInTheDocument();
		expect.soft(screen.queryByText(/no secret|secret does not exist/i)).not.toBeInTheDocument();
		expectOnlyReads(calls);
		await waitFor(() =>
			expect(notice(/config/i)).toHaveTextContent(/unavailable|failed|couldn.t/i),
		);
		expect(screen.getByTitle("Copy URL")).toBeDisabled();
		responses.set(CONFIG, () => json({ hasSecret: true, webhookUrl: CALLBACK }));
		retryRead(/config/i);
		await screen.findByDisplayValue(CALLBACK);
		expect(screen.getByLabelText(/Query-param secret/)).toHaveDisplayValue(/hidden/i);
		expect(notice(/config/i)).toBeUndefined();
		expect(calls.filter((call) => call === "GET " + CONFIG)).toHaveLength(2);
		expectOnlyReads(calls);
	});

	it("distinguishes cold services failure from verified empty, with only GET recovery", async () => {
		const { calls, responses } = transport();
		responses.set(SERVICES, unavailable);
		const client = mount();
		await waitFor(() => expect(client.getQueryState(["services"])?.status).toBe("error"));
		expect.soft(screen.queryByText(/No enabled qui instances configured/i)).not.toBeInTheDocument();
		expectOnlyReads(calls);
		await waitFor(() =>
			expect(notice(/services|instances/i)).toHaveTextContent(/unavailable|failed|couldn.t/i),
		);
		responses.set(SERVICES, () => json({ services: [] }));
		retryRead(/services|instances/i);
		await screen.findByText(/No enabled qui instances configured/i);
		expect(notice(/services|instances/i)).toBeUndefined();
		// The real services hook retains its existing three automatic GET retries.
		expect(calls.filter((call) => call === "GET " + SERVICES)).toHaveLength(5);
		expectOnlyReads(calls);
	});

	it("retains known callback and events on background failure and explicitly retries each GET", async () => {
		const { calls, responses } = transport();
		const client = mount();
		await screen.findByDisplayValue(CALLBACK);
		await screen.findByText(event.eventType);
		responses.set(CONFIG, unavailable);
		responses.set(EVENTS, unavailable);
		await act(async () => {
			await Promise.all([
				client.refetchQueries({ queryKey: quiKeys.webhookConfig }),
				client.refetchQueries({ queryKey: quiKeys.events }),
			]);
		});
		await screen.findByText(
			/(?:couldn.t|failed to) load recent events|recent events (?:are )?unavailable/i,
		);
		expect.soft(screen.queryByDisplayValue(CALLBACK)).toBeInTheDocument();
		expect.soft(screen.queryByText(event.eventType)).toBeInTheDocument();
		expect.soft(notice(/config/i)).toHaveTextContent(/last.known/i);
		expect.soft(notice(/events/i)).toHaveTextContent(/last.known/i);
		expect(screen.queryByText(/No webhook events received yet/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/proving the wire works end.to.end/i)).not.toBeInTheDocument();
		expectOnlyReads(calls);
		responses.set(CONFIG, () => json({ hasSecret: true, webhookUrl: CALLBACK + "&fresh=1" }));
		responses.set(EVENTS, () =>
			json({ entries: [{ ...event, eventType: "synthetic-fresh-event" }], nextCursor: null }),
		);
		retryRead(/config/i);
		retryRead(/events/i);
		await screen.findByDisplayValue(CALLBACK + "&fresh=1");
		await screen.findByText("synthetic-fresh-event");
		expect(screen.queryByText(event.eventType)).not.toBeInTheDocument();
		expect(notice(/config|events/i)).toBeUndefined();
		expect(calls.filter((call) => call === "GET " + CONFIG)).toHaveLength(3);
		expect(calls.filter((call) => call === "GET " + EVENTS)).toHaveLength(3);
		expectOnlyReads(calls);
	});

	it("copies exact local values, recovers denied copy without rotating again, and masks private labels", async () => {
		const { calls } = transport({ allowRotate: true });
		const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		// Browser I/O only: one accepted confirmation exposes synthetic rotation-time plaintext.
		vi.spyOn(window, "confirm").mockReturnValue(true);
		mount();
		await screen.findByDisplayValue(CALLBACK);
		fireEvent.click(screen.getByTitle("Copy URL"));
		await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(CALLBACK));
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await screen.findByDisplayValue(SECRET);
		expect(screen.getByLabelText(/Full URL/)).toHaveValue(FULL_URL);
		writeText.mockRejectedValueOnce(new Error("Synthetic clipboard denied"));
		fireEvent.click(screen.getByTitle("Copy secret"));
		await screen.findByText(/Couldn.t copy to clipboard/i);
		await screen.findByText("Synthetic clipboard denied");
		fireEvent.click(screen.getByTitle("Copy secret"));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
		fireEvent.click(screen.getByTitle("Copy URL + secret"));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(4));
		expect(writeText.mock.calls).toEqual([[CALLBACK], [SECRET], [SECRET], [FULL_URL]]);
		await act(async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		expect(screen.getByLabelText(/Query-param secret/)).toHaveValue("•".repeat(43));
		expect(screen.getByLabelText(/Full URL/)).toHaveValue(CALLBACK + "&secret=" + "•".repeat(43));
		const secretCopy = screen.getByTitle("Disable hide-sensitive-data to copy");
		const fullCopy = screen.getByTitle("Copy URL + secret");
		expect(secretCopy).toBeDisabled();
		expect(fullCopy).toBeDisabled();
		fireEvent.click(secretCopy);
		fireEvent.click(fullCopy);
		expect(writeText).toHaveBeenCalledTimes(4);
		expect.soft(screen.queryByText(service.label)).not.toBeInTheDocument();
		expect(screen.getAllByText(getLinuxInstanceName(service.label))).not.toHaveLength(0);
		expect(calls.filter((call) => call.startsWith("POST "))).toEqual(["POST " + ROTATE]);
	});
});
