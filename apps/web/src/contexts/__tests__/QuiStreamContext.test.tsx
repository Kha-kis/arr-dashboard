import type { CurrentUser, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuiActivityClient } from "../../features/qui-activity/components/qui-activity-client";
import { authKeys } from "../../lib/query-keys";
import { ColorThemeProvider } from "../../providers/color-theme-provider";
import { IncognitoProvider } from "../IncognitoContext";
import { QuiStreamProvider, useQuiStreamStatus } from "../QuiStreamContext";

const navigation = vi.hoisted(() => ({ pathname: "/qui/activity" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

const user: CurrentUser = {
	id: "user-1",
	username: "Example operator",
	mustChangePassword: false,
	createdAt: "2026-11-08T00:00:00.000Z",
	hasPassword: true,
	hasTmdbApiKey: false,
};
const service: ServiceInstanceSummary = {
	id: "qui-1",
	service: "qui",
	label: "Example qUI",
	baseUrl: "http://qui.example",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-11-08T00:00:00.000Z",
	updatedAt: "2026-11-08T00:00:00.000Z",
	tags: [],
};
let client: QueryClient;
let authenticated: boolean;
let services: ServiceInstanceSummary[];
let requests: string[];
let unexpected: string[];
let sources: BoundaryEventSource[];

// Only the browser transport is synthetic: it does not clear listeners on close,
// so missing production removeEventListener calls remain observable.
class BoundaryEventSource extends EventTarget {
	static CLOSED = 2;
	readyState = 0;
	closed = false;
	listeners = new Set<EventListenerOrEventListenerObject>();
	constructor(url: string, init?: EventSourceInit) {
		super();
		if (url !== "/api/qui/events/stream" || init?.withCredentials !== true) {
			unexpected.push(`EventSource ${url}`);
		}
		sources.push(this);
	}
	override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
		super.addEventListener(type, listener);
		if (listener) this.listeners.add(listener);
	}
	override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
		super.removeEventListener(type, listener);
		if (listener) this.listeners.delete(listener);
	}
	close() {
		this.closed = true;
		this.readyState = 2;
	}
	emit(type: "open" | "error") {
		this.readyState = type === "open" ? 1 : 0;
		this.dispatchEvent(new Event(type));
	}
}

beforeEach(() => {
	localStorage.clear();
	navigation.pathname = "/qui/activity";
	authenticated = true;
	services = [service];
	requests = [];
	unexpected = [];
	sources = [];
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.stubGlobal("EventSource", BoundaryEventSource);
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		requests.push(path);
		if ((init?.method ?? "GET") !== "GET") {
			unexpected.push(`${init?.method} ${path}`);
			throw new Error("Unexpected mutation");
		}
		let body: unknown;
		if (path === "/auth/me") {
			return Response.json(authenticated ? { user } : { error: "Unauthorized" }, {
				status: authenticated ? 200 : 401,
			});
		}
		if (path === "/api/services") body = { services };
		else if (path === "/api/qui/activity?limit=50") body = { events: [], nextCursor: null };
		else if (path === "/api/qui/actions?limit=50") body = { entries: [], nextCursor: null };
		else if (path === "/api/qui/events?limit=50") body = { entries: [], nextCursor: null };
		else {
			unexpected.push(`GET ${path}`);
			throw new Error("Unexpected HTTP read");
		}
		return Response.json(body);
	});
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.unstubAllGlobals();
	expect(unexpected).toEqual([]);
});

function StatusReader({ name, onCommit }: { name: string; onCommit?: (status: string) => void }) {
	const { isActive, streamStatus } = useQuiStreamStatus();
	const status = `${isActive ? "active" : "inactive"}:${streamStatus}`;
	useLayoutEffect(() => {
		onCommit?.(status);
	}, [onCommit, status]);
	return <output data-testid={name}>{status}</output>;
}
function Tree({
	activity = true,
	onStatusCommit,
}: {
	activity?: boolean;
	onStatusCommit?: (status: string) => void;
}) {
	return (
		<ColorThemeProvider>
			<QueryClientProvider client={client}>
				<IncognitoProvider>
					<QuiStreamProvider>
						<StatusReader name="first" onCommit={onStatusCommit} />
						<StatusReader name="second" />
						{activity ? <QuiActivityClient /> : null}
					</QuiStreamProvider>
				</IncognitoProvider>
			</QueryClientProvider>
		</ColorThemeProvider>
	);
}
async function connectedSource() {
	await waitFor(() => expect(sources).toHaveLength(1));
	return sources[0]!;
}
function expectNoBadge() {
	expect(screen.queryByText("Connecting to live channel…")).not.toBeInTheDocument();
	expect(
		screen.queryByText("Live channel offline — using polling fallback"),
	).not.toBeInTheDocument();
}

describe("root qUI stream lifecycle and Activity status", () => {
	it("starts a cold authenticated connection as connecting, never offline before an error", async () => {
		const committed = vi.fn<(status: string) => void>();
		render(<Tree onStatusCommit={committed} />);
		await connectedSource();
		await waitFor(() => expect(screen.getByTestId("first")).toHaveTextContent("active:connecting"));
		// A passive effect can correct the DOM after an incorrect status has already committed.
		expect(committed.mock.calls).toEqual([["inactive:offline"], ["active:connecting"]]);
		expect(screen.getByText("Connecting to live channel…")).toBeInTheDocument();
		expect(screen.queryByText(/Live channel offline/)).not.toBeInTheDocument();
	});

	it("shares one source across consumers and Activity tabs, exposing loss and recovery", async () => {
		// Catches consumer-owned sockets, dropped status events, and false healthy/offline pills.
		const view = render(<Tree />);
		const source = await connectedSource();
		act(() => source.emit("open"));
		expect(screen.getByTestId("first")).toHaveTextContent("active:open");
		expect(screen.getByTestId("second")).toHaveTextContent("active:open");
		expectNoBadge();
		await screen.findByText("No qui activity yet");
		fireEvent.click(screen.getByRole("tab", { name: "My Actions" }));
		await screen.findByText("No torrent actions yet");
		fireEvent.click(screen.getByRole("tab", { name: "My Events" }));
		await screen.findByText("No webhook events yet");
		act(() => source.emit("error"));
		expect(screen.getByTestId("second")).toHaveTextContent("active:offline");
		expect(screen.getByText("Live channel offline — using polling fallback")).toBeInTheDocument();
		act(() => source.emit("open"));
		expect(screen.getByTestId("first")).toHaveTextContent("active:open");
		expectNoBadge();
		expect(sources).toHaveLength(1);
		view.unmount();
		expect(source.closed).toBe(true);
		expect(source.listeners.size).toBe(0);
	});

	it("opens no connection or provider HTTP reads on login and setup routes", async () => {
		// Public pages do not mount Activity; this isolates the root provider's own gate.
		navigation.pathname = "/login";
		const view = render(<Tree activity={false} />);
		await act(async () => {});
		expect(screen.getByTestId("first")).toHaveTextContent("inactive:offline");
		navigation.pathname = "/setup";
		view.rerender(<Tree activity={false} />);
		await act(async () => {});
		expect(screen.getByTestId("second")).toHaveTextContent("inactive:offline");
		expect(requests).toEqual([]);
		expect(sources).toHaveLength(0);
		expectNoBadge();
	});

	it("stays inactive after an unauthenticated HTTP response without fetching services", async () => {
		// Catches enabling on a resolved auth query instead of an authenticated user.
		authenticated = false;
		render(<Tree activity={false} />);
		await waitFor(() => expect(client.getQueryData(authKeys.currentUser)).toBeNull());
		expect(screen.getByTestId("first")).toHaveTextContent("inactive:offline");
		expect(requests).toEqual(["/auth/me"]);
		expect(sources).toHaveLength(0);
		expectNoBadge();
	});

	it("shows no offline badge or connection for absent, disabled, or non-qUI configuration", async () => {
		// Catches treating any configured service, or a disabled qUI service, as active.
		services = [];
		render(<Tree />);
		await screen.findByText("No qui instance configured");
		for (const configuration of [
			[],
			[{ ...service, enabled: false }],
			[{ ...service, service: "radarr" as const }],
		]) {
			services = configuration;
			await act(async () => {
				await client.refetchQueries({ queryKey: ["services"] });
			});
			expect(screen.getByText("No qui instance configured")).toBeInTheDocument();
			expect(screen.getByTestId("first")).toHaveTextContent("inactive:offline");
			expectNoBadge();
			expect(sources).toHaveLength(0);
		}
	});

	it("detaches a disabled source and starts its replacement as connecting before opening", async () => {
		// Catches stale source callbacks and status inherited across disable/re-enable.
		const committed = vi.fn<(status: string) => void>();
		const view = render(<Tree onStatusCommit={committed} />);
		const previous = await connectedSource();
		act(() => previous.emit("open"));
		services = [{ ...service, enabled: false }];
		await act(async () => {
			await client.refetchQueries({ queryKey: ["services"] });
		});
		await screen.findByText("No qui instance configured");
		expect(previous.closed).toBe(true);
		expect(previous.listeners.size).toBe(0);
		act(() => previous.emit("open"));
		expect(screen.getByTestId("first")).toHaveTextContent("inactive:offline");
		expectNoBadge();
		committed.mockClear();
		services = [service];
		await act(async () => {
			await client.refetchQueries({ queryKey: ["services"] });
		});
		await waitFor(() => expect(sources).toHaveLength(2));
		const replacement = sources[1]!;
		try {
			await waitFor(() =>
				expect(screen.getByTestId("first")).toHaveTextContent("active:connecting"),
			);
			expect(committed.mock.calls).toEqual([["active:connecting"]]);
			expect(screen.getByText("Connecting to live channel…")).toBeInTheDocument();
		} finally {
			view.unmount();
			expect(replacement.closed).toBe(true);
			expect(replacement.listeners.size).toBe(0);
		}
	});
});
