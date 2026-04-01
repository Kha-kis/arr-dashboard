import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — API client
// ---------------------------------------------------------------------------

vi.mock("../../../lib/api-client/plex");
vi.mock("../../../lib/error-utils", () => ({
	getErrorMessage: (err: unknown, fallback: string) =>
		err instanceof Error ? err.message : fallback,
}));

import * as plexApi from "../../../lib/api-client/plex";
import { usePlexOAuth } from "../usePlexOAuth";

// ---------------------------------------------------------------------------
// Window / global stubs
// ---------------------------------------------------------------------------

const mockPopup = {
	closed: false,
	close: vi.fn(),
	location: { href: "" },
};

// localStorage mock
const store: Record<string, string> = {};
const mockLocalStorage = {
	getItem: vi.fn((key: string) => store[key] ?? null),
	setItem: vi.fn((key: string, val: string) => {
		store[key] = val;
	}),
	removeItem: vi.fn((key: string) => {
		delete store[key];
	}),
	clear: vi.fn(),
	length: 0,
	key: vi.fn(),
};

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();

	// Reset popup state
	mockPopup.closed = false;
	mockPopup.close.mockClear();
	mockPopup.location.href = "";

	// Stub window.open
	vi.stubGlobal(
		"open",
		vi.fn(() => mockPopup),
	);

	// Stub crypto.randomUUID
	vi.stubGlobal("crypto", {
		...globalThis.crypto,
		randomUUID: () => "test-uuid-1234",
	});

	// Stub localStorage
	vi.stubGlobal("localStorage", mockLocalStorage);
	for (const key of Object.keys(store)) {
		delete store[key];
	}
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usePlexOAuth", () => {
	it("starts in idle status with empty servers", () => {
		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		expect(result.current.status).toBe("idle");
		expect(result.current.servers).toEqual([]);
		expect(result.current.tokenRef).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("opens popup and transitions to pending on startOAuth", async () => {
		// createPlexPin will not resolve yet (pending promise)
		vi.mocked(plexApi.createPlexPin).mockReturnValue(new Promise(() => {}));

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		await act(async () => {
			result.current.startOAuth();
		});

		expect(globalThis.open).toHaveBeenCalledTimes(1);
		expect(result.current.status).toBe("pending");
	});

	it("transitions to polling after PIN is created", async () => {
		vi.mocked(plexApi.createPlexPin).mockResolvedValue({
			pinId: 42,
			pinCode: "ABCD",
		});
		vi.mocked(plexApi.pollPlexPin).mockResolvedValue({ tokenRef: null });

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		await act(async () => {
			result.current.startOAuth();
		});

		// Flush the async IIFE (createPlexPin resolves -> status set to polling)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});

		expect(result.current.status).toBe("polling");
		expect(mockPopup.location.href).toContain("https://app.plex.tv/auth");
		expect(mockPopup.location.href).toContain("clientID=");
		expect(mockPopup.location.href).toContain("code=ABCD");
	});

	it("transitions to done after token received and servers discovered", async () => {
		const discoveredServers = [
			{
				name: "My Server",
				clientIdentifier: "abc-123",

				version: "1.40.0",
				connections: [
					{ uri: "http://192.168.1.100:32400", local: true, relay: false, reachable: true },
				],
			},
		];

		vi.mocked(plexApi.createPlexPin).mockResolvedValue({
			pinId: 42,
			pinCode: "ABCD",
		});
		// First poll: no token. Second poll: token received.
		vi.mocked(plexApi.pollPlexPin)
			.mockResolvedValueOnce({ tokenRef: null })
			.mockResolvedValueOnce({ tokenRef: "plex-auth-token-999" });
		vi.mocked(plexApi.discoverPlexServers).mockResolvedValue({
			servers: discoveredServers,
		});

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		// Start OAuth
		await act(async () => {
			result.current.startOAuth();
		});

		// Let createPlexPin resolve -> sets up setInterval, status = "polling"
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(result.current.status).toBe("polling");

		// Advance 1s -> first poll fires (returns null token)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});

		// Advance 1s -> second poll fires (returns token) -> discovers servers
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});

		// Flush the discoverPlexServers promise chain
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});

		expect(result.current.status).toBe("done");
		expect(result.current.tokenRef).toBe("plex-auth-token-999");
		expect(result.current.servers).toEqual(discoveredServers);
		expect(plexApi.discoverPlexServers).toHaveBeenCalledWith(
			"plex-auth-token-999",
			expect.any(String),
		);
	});

	it("sets cancelled when popup closes during polling", async () => {
		vi.mocked(plexApi.createPlexPin).mockResolvedValue({
			pinId: 42,
			pinCode: "ABCD",
		});
		vi.mocked(plexApi.pollPlexPin).mockResolvedValue({ tokenRef: null });

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		await act(async () => {
			result.current.startOAuth();
		});

		// Let createPlexPin resolve
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(result.current.status).toBe("polling");

		// Simulate popup being closed by user
		mockPopup.closed = true;

		// Advance timer to trigger the next poll interval check
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});

		expect(result.current.status).toBe("cancelled");
	});

	it("sets error when popup is blocked (window.open returns null)", async () => {
		vi.stubGlobal(
			"open",
			vi.fn(() => null),
		);

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		await act(async () => {
			result.current.startOAuth();
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error).toContain("Popup was blocked");
	});

	it("ignores startOAuth if already in polling state", async () => {
		vi.mocked(plexApi.createPlexPin).mockResolvedValue({
			pinId: 42,
			pinCode: "ABCD",
		});
		vi.mocked(plexApi.pollPlexPin).mockResolvedValue({ tokenRef: null });

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		await act(async () => {
			result.current.startOAuth();
		});

		// Let createPlexPin resolve -> status = "polling"
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(result.current.status).toBe("polling");

		// Clear the mock call count
		vi.mocked(globalThis.open).mockClear();

		// Try starting again — should be a no-op
		await act(async () => {
			result.current.startOAuth();
		});

		expect(globalThis.open).not.toHaveBeenCalled();
	});

	it("sets error when createPlexPin fails", async () => {
		vi.mocked(plexApi.createPlexPin).mockRejectedValue(new Error("Network error"));

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		await act(async () => {
			result.current.startOAuth();
		});

		// Flush the rejected promise in the async IIFE
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error).toBe("Network error");
	});

	it("cancel cleans up and returns to idle", async () => {
		vi.mocked(plexApi.createPlexPin).mockResolvedValue({
			pinId: 42,
			pinCode: "ABCD",
		});
		vi.mocked(plexApi.pollPlexPin).mockResolvedValue({ tokenRef: null });

		const { result } = renderHook(() => usePlexOAuth(), {
			wrapper: createWrapper(),
		});

		await act(async () => {
			result.current.startOAuth();
		});

		// Let createPlexPin resolve
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(result.current.status).toBe("polling");

		// Cancel
		await act(async () => {
			result.current.cancel();
		});

		expect(result.current.status).toBe("idle");
		expect(result.current.error).toBeNull();
		expect(mockPopup.close).toHaveBeenCalled();
	});
});
