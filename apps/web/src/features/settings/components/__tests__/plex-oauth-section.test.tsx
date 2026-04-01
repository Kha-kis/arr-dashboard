import type { PlexDiscoveredServer } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// jsdom polyfills
// ---------------------------------------------------------------------------

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../../../hooks/api/usePlexOAuth");
vi.mock("../../../../lib/incognito");
vi.mock("../../../../lib/api-client/plex");
vi.mock("../../../../lib/theme-gradients", () => ({
	SERVICE_GRADIENTS: {
		plex: {
			from: "#e5a00d",
			to: "#f0c040",
			glow: "rgba(229,160,13,0.3)",
			fromLight: "#e5a00d10",
			fromMedium: "#e5a00d20",
			fromMuted: "#e5a00d30",
		},
	},
	SEMANTIC_COLORS: {
		success: { text: "#4ade80" },
		warning: { text: "#fbbf24" },
	},
}));

// Import after mock declarations
import { usePlexOAuth } from "../../../../hooks/api/usePlexOAuth";
import { getLinuxInstanceName, getLinuxUrl, useIncognitoMode } from "../../../../lib/incognito";
import { retrievePlexToken } from "../../../../lib/api-client/plex";
import { PlexOAuthSection } from "../plex-oauth-section";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockOAuthResult(overrides: Partial<ReturnType<typeof usePlexOAuth>> = {}) {
	return {
		status: "idle" as const,
		servers: [] as PlexDiscoveredServer[],
		tokenRef: null as string | null,
		error: null as string | null,
		startOAuth: vi.fn(),
		cancel: vi.fn(),
		...overrides,
	};
}

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

function renderSection(onServerSelected = vi.fn(), mode: "add" | "edit" = "add", onTestConnection = vi.fn()) {
	return render(<PlexOAuthSection onServerSelected={onServerSelected} onTestConnection={onTestConnection} mode={mode} />, {
		wrapper: createWrapper(),
	});
}

const sampleServers: PlexDiscoveredServer[] = [
	{
		name: "My Plex Server",
		clientIdentifier: "abc-123",

		version: "1.40.2",
		connections: [
			{ uri: "http://192.168.1.100:32400", local: true, relay: false, reachable: true },
			{ uri: "https://relay.plex.direct:443", local: false, relay: true, reachable: true },
		],
	},
	{
		name: "Remote Server",
		clientIdentifier: "def-456",

		version: "1.39.0",
		connections: [
			{ uri: "https://remote.example.com:32400", local: false, relay: false, reachable: false },
		],
	},
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(useIncognitoMode).mockReturnValue([false, vi.fn()]);
	vi.mocked(getLinuxInstanceName).mockImplementation((name) => `linux-${name}`);
	vi.mocked(getLinuxUrl).mockImplementation((_url) => "http://10.0.0.1:8080");
	vi.mocked(usePlexOAuth).mockReturnValue(mockOAuthResult());
	vi.mocked(retrievePlexToken).mockResolvedValue({ authToken: "resolved-plex-token" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlexOAuthSection", () => {
	// ================================================================
	// Idle state
	// ================================================================

	it("renders 'Connect with Plex' button in idle state", () => {
		renderSection();

		expect(screen.getByText("Connect with Plex")).toBeInTheDocument();
	});

	it("shows 'or enter manually' divider in idle state", () => {
		renderSection();

		expect(screen.getByText("or enter manually")).toBeInTheDocument();
	});

	it("calls startOAuth when sign-in button is clicked", () => {
		const startOAuth = vi.fn();
		vi.mocked(usePlexOAuth).mockReturnValue(mockOAuthResult({ startOAuth }));

		renderSection();
		fireEvent.click(screen.getByText("Connect with Plex"));

		expect(startOAuth).toHaveBeenCalledTimes(1);
	});

	// ================================================================
	// Loading states
	// ================================================================

	it("shows 'Connecting to Plex...' during pending status", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockOAuthResult({ status: "pending" }));

		renderSection();

		expect(screen.getByText("Connecting to Plex...")).toBeInTheDocument();
		expect(screen.getByText("Cancel")).toBeInTheDocument();
	});

	it("shows 'Waiting for authorization...' during polling status", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockOAuthResult({ status: "polling" }));

		renderSection();

		expect(screen.getByText("Waiting for authorization...")).toBeInTheDocument();
	});

	it("shows 'Discovering servers...' during discovering status", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockOAuthResult({ status: "discovering" }));

		renderSection();

		expect(screen.getByText("Discovering servers...")).toBeInTheDocument();
	});

	it("calls cancel when Cancel button is clicked during loading", () => {
		const cancelFn = vi.fn();
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({ status: "polling", cancel: cancelFn }),
		);

		renderSection();
		fireEvent.click(screen.getByText("Cancel"));

		expect(cancelFn).toHaveBeenCalledTimes(1);
	});

	it("shows 'or enter manually' divider during loading states", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockOAuthResult({ status: "polling" }));

		renderSection();

		expect(screen.getByText("or enter manually")).toBeInTheDocument();
	});

	// ================================================================
	// Error state
	// ================================================================

	it("shows error message on error status", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "error",
				error:
					"Popup was blocked by your browser. Please allow popups for this site and try again.",
			}),
		);

		renderSection();

		expect(
			screen.getByText(
				"Popup was blocked by your browser. Please allow popups for this site and try again.",
			),
		).toBeInTheDocument();
		// Should still show sign-in button for retry
		expect(screen.getByText("Connect with Plex")).toBeInTheDocument();
	});

	// ================================================================
	// Cancelled state
	// ================================================================

	it("shows cancelled message after popup close", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockOAuthResult({ status: "cancelled" }));

		renderSection();

		expect(screen.getByText("Plex sign-in was cancelled.")).toBeInTheDocument();
		// Should still show sign-in button for retry
		expect(screen.getByText("Connect with Plex")).toBeInTheDocument();
	});

	// ================================================================
	// Done state — servers found
	// ================================================================

	it("renders server list with names and reachability badges", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		expect(screen.getByText("My Plex Server")).toBeInTheDocument();
		expect(screen.getByText("Remote Server")).toBeInTheDocument();
		expect(screen.getByText(/2 servers found/)).toBeInTheDocument();

		// All connections are shown
		expect(screen.getByText("http://192.168.1.100:32400")).toBeInTheDocument();
		expect(screen.getByText("https://relay.plex.direct:443")).toBeInTheDocument();
		expect(screen.getByText("https://remote.example.com:32400")).toBeInTheDocument();

		// Reachability badges
		expect(screen.getAllByText("reachable").length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText("unreachable").length).toBeGreaterThanOrEqual(1);
	});

	it("shows version number when available", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		expect(screen.getByText("v1.40.2")).toBeInTheDocument();
		expect(screen.getByText("v1.39.0")).toBeInTheDocument();
	});

	it("calls onServerSelected with resolved token when connection clicked", async () => {
		const onServerSelected = vi.fn();
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "token-ref-123",
			}),
		);

		renderSection(onServerSelected);
		fireEvent.click(screen.getByText("http://192.168.1.100:32400"));

		await waitFor(() => {
			expect(onServerSelected).toHaveBeenCalledWith(
				"My Plex Server",
				"http://192.168.1.100:32400",
				"resolved-plex-token",
			);
		});
	});

	it("does not call onServerSelected when tokenRef is null", () => {
		const onServerSelected = vi.fn();
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: null,
			}),
		);

		renderSection(onServerSelected);
		fireEvent.click(screen.getByText("http://192.168.1.100:32400"));

		expect(onServerSelected).not.toHaveBeenCalled();
	});

	it("shows '1 server found' for single server", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: [sampleServers[0]!],
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		expect(screen.getByText(/1 server found/)).toBeInTheDocument();
	});

	it("shows unreachable badge for unreachable connections", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: [sampleServers[1]!],
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		expect(screen.getByText("unreachable")).toBeInTheDocument();
	});

	// ================================================================
	// Done state — empty
	// ================================================================

	it("shows 'No Plex servers found' for empty result", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: [],
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		expect(
			screen.getByText("No Plex servers found on your account. You can add one manually below."),
		).toBeInTheDocument();
		expect(screen.getByText("Try again")).toBeInTheDocument();
	});

	it("shows 'or enter manually' divider when done with servers", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		expect(screen.getByText("or enter manually")).toBeInTheDocument();
	});

	// ================================================================
	// Incognito mode
	// ================================================================

	it("anonymizes server names and URLs in incognito mode", () => {
		vi.mocked(useIncognitoMode).mockReturnValue([true, vi.fn()]);
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		// Original names should NOT appear
		expect(screen.queryByText("My Plex Server")).not.toBeInTheDocument();
		expect(screen.queryByText("http://192.168.1.100:32400")).not.toBeInTheDocument();

		// Anonymized names should appear
		expect(getLinuxInstanceName).toHaveBeenCalledWith("My Plex Server");
		expect(getLinuxInstanceName).toHaveBeenCalledWith("Remote Server");
		expect(getLinuxUrl).toHaveBeenCalled();
	});

	it("hides version numbers in incognito mode", () => {
		vi.mocked(useIncognitoMode).mockReturnValue([true, vi.fn()]);
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-123",
			}),
		);

		renderSection();

		expect(screen.queryByText("v1.40.2")).not.toBeInTheDocument();
		expect(screen.queryByText("v1.39.0")).not.toBeInTheDocument();
	});

	// ================================================================
	// Edit mode
	// ================================================================

	it("shows 'Reconnect with Plex' button in edit mode", () => {
		renderSection(vi.fn(), "edit");

		expect(screen.getByText("Reconnect with Plex")).toBeInTheDocument();
	});

	it("shows 'or edit manually' divider in edit mode", () => {
		renderSection(vi.fn(), "edit");

		expect(screen.getByText("or edit manually")).toBeInTheDocument();
	});

	it("shows save reminder after selecting a connection in edit mode", async () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-123",
			}),
		);

		renderSection(vi.fn(), "edit");
		fireEvent.click(screen.getByText("http://192.168.1.100:32400"));

		await waitFor(() => {
			expect(screen.getByText(/Updated — click Save changes to apply/)).toBeInTheDocument();
		});
	});

	it("does not show save reminder in add mode after selection", async () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-123",
			}),
		);

		renderSection(vi.fn(), "add");
		fireEvent.click(screen.getByText("http://192.168.1.100:32400"));

		// Wait for the async token consumption to settle
		await waitFor(() => {
			expect(retrievePlexToken).toHaveBeenCalled();
		});
		expect(screen.queryByText(/Updated — click Save changes to apply/)).not.toBeInTheDocument();
	});

	it("updates form values when connection selected in edit mode", async () => {
		const onServerSelected = vi.fn();
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: sampleServers,
				tokenRef: "plex-token-edit",
			}),
		);

		renderSection(onServerSelected, "edit");
		fireEvent.click(screen.getByText("http://192.168.1.100:32400"));

		await waitFor(() => {
			expect(onServerSelected).toHaveBeenCalledWith(
				"My Plex Server",
				"http://192.168.1.100:32400",
				"resolved-plex-token",
			);
		});
	});

	it("shows edit-appropriate empty state text", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(
			mockOAuthResult({
				status: "done",
				servers: [],
				tokenRef: "plex-token-123",
			}),
		);

		renderSection(vi.fn(), "edit");

		expect(screen.getByText(/You can edit manually below/)).toBeInTheDocument();
	});
});
