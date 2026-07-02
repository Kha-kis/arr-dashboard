import type {
	ServiceInstanceSummary,
	TracearrLiveSession,
	TracearrLiveSessionsResponse,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

const mockUseServicesQuery = vi.fn();
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => mockUseServicesQuery(),
}));

const mockUseTracearrLiveSessions = vi.fn();
const mockTerminateMutate = vi.fn();
vi.mock("../../../../hooks/api/useTracearr", () => ({
	useTracearrLiveSessions: () => mockUseTracearrLiveSessions(),
	useTerminateSession: () => ({ mutate: mockTerminateMutate, isPending: false }),
}));

import { LiveSessionsCard } from "../live-sessions-card";

function createWrapper() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}

function service(overrides: Partial<ServiceInstanceSummary> = {}): ServiceInstanceSummary {
	return {
		id: "trr-1",
		label: "Dev Tracearr",
		baseUrl: "http://tracearr.test",
		service: "tracearr",
		enabled: true,
		isDefault: false,
		tags: [],
		hasApiKey: true,
		...overrides,
	} as ServiceInstanceSummary;
}

function liveSession(overrides: Partial<TracearrLiveSession> = {}): TracearrLiveSession {
	return {
		id: "s1",
		instanceId: "trr-1",
		instanceLabel: "Dev Tracearr",
		serverName: "Johns Home Plex",
		mediaTitle: "Blade Runner 2049",
		username: "alice",
		player: "Living Room TV",
		state: "playing",
		mediaType: "movie",
		progressMs: 30_000,
		durationMs: 60_000,
		isTranscode: false,
		...overrides,
	};
}

function response(
	overrides: Partial<TracearrLiveSessionsResponse> = {},
): TracearrLiveSessionsResponse {
	const total = overrides.sessions?.length ?? 0;
	return {
		configured: true,
		instances: [{ id: "trr-1", label: "Dev Tracearr", reachable: true }],
		summary: {
			total,
			transcodes: 0,
			directStreams: total,
			directPlays: 0,
			totalBitrate: "—",
		},
		sessions: [],
		...overrides,
	};
}

beforeEach(() => {
	mockUseServicesQuery.mockReset();
	mockUseTracearrLiveSessions.mockReset();
	mockTerminateMutate.mockReset();
	mockUseTracearrLiveSessions.mockReturnValue({ isLoading: false });
	localStorage.removeItem(INCOGNITO_STORAGE_KEY);
});

describe("<LiveSessionsCard />", () => {
	it("renders nothing when no Tracearr instance is enabled (service gating)", () => {
		mockUseServicesQuery.mockReturnValue({ data: [] });
		const { container } = render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the only Tracearr instance is disabled", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service({ enabled: false })] });
		const { container } = render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(container).toBeEmptyDOMElement();
	});

	it("shows an honest unreachable state, not a fake zero", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: response({
				instances: [{ id: "trr-1", label: "Dev Tracearr", reachable: false }],
				summary: null,
			}),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(screen.getByTestId("live-sessions-unreachable")).toBeInTheDocument();
		expect(screen.queryByTestId("live-sessions-summary")).not.toBeInTheDocument();
	});

	it("renders the active-stream count with transcode/direct breakdown", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: response({
				summary: {
					total: 3,
					transcodes: 1,
					directStreams: 1,
					directPlays: 1,
					totalBitrate: "42.0 Mbps",
				},
			}),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		const card = screen.getByTestId("live-sessions-summary");
		expect(card).toHaveTextContent("3");
		expect(card).toHaveTextContent(/active streams/i);
		expect(card).toHaveTextContent(/Transcoding/i);
		expect(card).toHaveTextContent("42.0 Mbps");
	});

	it("renders per-session rows with title + user", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: response({ sessions: [liveSession()] }),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		const rows = screen.getByTestId("live-sessions-rows");
		expect(rows).toHaveTextContent("Blade Runner 2049");
		expect(rows).toHaveTextContent("alice");
		expect(rows).toHaveTextContent("Living Room TV");
	});

	it("caps the row list and discloses the overflow", () => {
		const many = Array.from({ length: 7 }, (_, i) =>
			liveSession({ id: `s${i}`, mediaTitle: `Movie ${i}` }),
		);
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({ data: response({ sessions: many }) });
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		// Only the first 5 rows render...
		expect(screen.getByTestId("live-sessions-rows").querySelectorAll("li")).toHaveLength(5);
		// ...and the remaining 2 are disclosed, not silently dropped.
		expect(screen.getByTestId("live-sessions-overflow")).toHaveTextContent("+2 more");
	});

	it("opens the terminate dialog when a row's Kill button is clicked", () => {
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: response({ sessions: [liveSession()] }),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Terminate session: Blade Runner 2049/i }));
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByText(/This stops an active stream/i)).toBeInTheDocument();
	});

	it("masks media title + username in incognito mode", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: response({ sessions: [liveSession()] }),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		// The provider applies incognito on mount; wait for the masked re-render.
		await waitFor(() => {
			expect(screen.queryByText("Blade Runner 2049")).not.toBeInTheDocument();
		});
		expect(screen.queryByText("alice")).not.toBeInTheDocument();
		// The row itself is still present (masked, not removed).
		expect(screen.getByTestId("live-sessions-rows")).toBeInTheDocument();
	});

	it("masks the server name in the terminate dialog under incognito", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		mockUseServicesQuery.mockReturnValue({ data: [service()] });
		mockUseTracearrLiveSessions.mockReturnValue({
			data: response({ sessions: [liveSession()] }),
		});
		render(<LiveSessionsCard />, { wrapper: createWrapper() });
		await waitFor(() => expect(screen.queryByText("Blade Runner 2049")).not.toBeInTheDocument());
		// Open the kill dialog (its Kill button aria-label uses the masked title).
		const killButton = await screen.findByRole("button", { name: /Terminate session:/i });
		fireEvent.click(killButton);
		// The dialog must not reveal the real server name.
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.queryByText(/Johns Home Plex/)).not.toBeInTheDocument();
	});
});
