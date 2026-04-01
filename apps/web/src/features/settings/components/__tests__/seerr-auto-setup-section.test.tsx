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
vi.mock("../../../../lib/api-client/seerr");
vi.mock("../../../../lib/theme-gradients", () => ({
	SERVICE_GRADIENTS: {
		seerr: {
			from: "#6366f1",
			to: "#8b5cf6",
			glow: "rgba(99,102,241,0.3)",
		},
	},
}));

// Import after mock declarations
import { usePlexOAuth } from "../../../../hooks/api/usePlexOAuth";
import { fetchSeerrApiKey } from "../../../../lib/api-client/seerr";
import { SeerrAutoSetupSection } from "../seerr-auto-setup-section";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPlexOAuth(overrides: Partial<ReturnType<typeof usePlexOAuth>> = {}) {
	return {
		status: "idle" as const,
		servers: [],
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

function renderSection(
	seerrUrl = "http://seerr:5055",
	onApiKeyFetched = vi.fn(),
	mode: "add" | "edit" = "add",
	onTestConnection = vi.fn(),
) {
	return render(
		<SeerrAutoSetupSection
			seerrUrl={seerrUrl}
			onApiKeyFetched={onApiKeyFetched as (apiKey: string) => void}
			onTestConnection={onTestConnection as () => void}
			mode={mode}
		/>,
		{ wrapper: createWrapper() },
	);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(usePlexOAuth).mockReturnValue(mockPlexOAuth());
	vi.mocked(fetchSeerrApiKey).mockResolvedValue({ apiKey: "fetched-key", version: "2.0.0" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SeerrAutoSetupSection", () => {
	// ================================================================
	// Idle state
	// ================================================================

	it("renders 'Sign in to Seerr with Plex' button in add mode", () => {
		renderSection();

		expect(screen.getByText("Sign in to Seerr with Plex")).toBeInTheDocument();
	});

	it("renders 'Re-authenticate Seerr with Plex' in edit mode", () => {
		renderSection(undefined, undefined, "edit");

		expect(screen.getByText("Re-authenticate Seerr with Plex")).toBeInTheDocument();
	});

	it("disables button when seerrUrl is empty", () => {
		renderSection("");

		const button = screen.getByRole("button", { name: /Sign in to Seerr with Plex/i });
		expect(button).toBeDisabled();
	});

	it("shows 'Enter the Seerr Base URL above first' when URL empty", () => {
		renderSection("");

		expect(screen.getByText(/Enter the Seerr Base URL above first/i)).toBeInTheDocument();
	});

	it("shows 'or enter manually' divider", () => {
		renderSection();

		expect(screen.getByText("or enter manually")).toBeInTheDocument();
	});

	// ================================================================
	// Plex OAuth flow → fetch key
	// ================================================================

	it("calls fetchSeerrApiKey when tokenRef is available and button clicked", async () => {
		// Start with tokenRef already available (user previously authed with Plex)
		vi.mocked(usePlexOAuth).mockReturnValue(mockPlexOAuth({ tokenRef: "existing-ref" }));

		const onApiKeyFetched = vi.fn();
		renderSection(undefined, onApiKeyFetched);

		fireEvent.click(screen.getByText("Sign in to Seerr with Plex"));

		await waitFor(() => {
			expect(fetchSeerrApiKey).toHaveBeenCalledWith("http://seerr:5055", "existing-ref");
		});
	});

	// ================================================================
	// Success state
	// ================================================================

	it("shows success message after API key fetched", async () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockPlexOAuth({ tokenRef: "plex-ref-123" }));
		vi.mocked(fetchSeerrApiKey).mockResolvedValue({ apiKey: "seerr-key", version: "2.0.0" });

		const onApiKeyFetched = vi.fn();
		renderSection(undefined, onApiKeyFetched);

		fireEvent.click(screen.getByText("Sign in to Seerr with Plex"));

		await waitFor(() => {
			expect(screen.getByText("API key retrieved successfully.")).toBeInTheDocument();
		});
		expect(onApiKeyFetched).toHaveBeenCalledWith("seerr-key");
	});

	// ================================================================
	// Error state
	// ================================================================

	it("shows error message on fetch failure", async () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockPlexOAuth({ tokenRef: "plex-ref-123" }));
		vi.mocked(fetchSeerrApiKey).mockRejectedValue(
			new Error("Your Plex account does not have admin access"),
		);

		renderSection();

		fireEvent.click(screen.getByText("Sign in to Seerr with Plex"));

		await waitFor(() => {
			expect(screen.getByText("Your Plex account does not have admin access")).toBeInTheDocument();
		});
	});

	// ================================================================
	// Loading states
	// ================================================================

	it("shows loading state during plex-auth", () => {
		vi.mocked(usePlexOAuth).mockReturnValue(mockPlexOAuth({ status: "polling" }));

		// To get into plex-auth state, we need to click the button without a tokenRef
		renderSection();
		fireEvent.click(screen.getByText("Sign in to Seerr with Plex"));

		expect(screen.getByText(/Waiting for Plex authorization/i)).toBeInTheDocument();
		expect(screen.getByText("Cancel")).toBeInTheDocument();
	});

	it("shows 'Fetching Seerr API key...' during fetching state", async () => {
		// Use a never-resolving promise to keep the component in fetching state
		let resolvePromise!: (value: { apiKey: string; version: string }) => void;
		vi.mocked(fetchSeerrApiKey).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePromise = resolve;
				}),
		);

		vi.mocked(usePlexOAuth).mockReturnValue(mockPlexOAuth({ tokenRef: "plex-ref-123" }));

		renderSection();
		fireEvent.click(screen.getByText("Sign in to Seerr with Plex"));

		await waitFor(() => {
			expect(screen.getByText("Fetching Seerr API key...")).toBeInTheDocument();
		});

		// Clean up: resolve the pending promise
		resolvePromise({ apiKey: "key", version: "1.0" });
	});

	// ================================================================
	// Edit mode specifics
	// ================================================================

	it("shows 'or edit manually' divider in edit mode", () => {
		renderSection(undefined, undefined, "edit");

		expect(screen.getByText("or edit manually")).toBeInTheDocument();
	});
});
