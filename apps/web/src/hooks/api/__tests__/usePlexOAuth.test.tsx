import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
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

function createPopup() {
	const popup = {
		closed: false,
		close: vi.fn(() => {
			popup.closed = true;
		}),
		location: { href: "" },
	};
	return popup;
}
const mockPopup = createPopup();

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

const currentServers = [
	{ name: "Current synthetic server", clientIdentifier: "current-server", connections: [] },
];

async function tick() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_000);
	});
}

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
	vi.mocked(plexApi.createPlexPin).mockReset().mockResolvedValue({ pinId: 42, pinCode: "CURRENT" });
	vi.mocked(plexApi.pollPlexPin).mockReset().mockResolvedValue({ tokenRef: null });
	vi.mocked(plexApi.discoverPlexServers).mockReset().mockResolvedValue({ servers: currentServers });

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
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
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

	it.each(["success", "error"])(
		"ignores an old PIN %s after cancel and restart",
		async (outcome) => {
			const oldPin = deferred<Awaited<ReturnType<typeof plexApi.createPlexPin>>>();
			const newPin = deferred<Awaited<ReturnType<typeof plexApi.createPlexPin>>>();
			const oldPopup = createPopup(),
				newPopup = createPopup();
			vi.mocked(globalThis.open)
				.mockReturnValueOnce(oldPopup as unknown as Window)
				.mockReturnValueOnce(newPopup as unknown as Window);
			vi.mocked(plexApi.createPlexPin)
				.mockReturnValueOnce(oldPin.promise)
				.mockReturnValueOnce(newPin.promise);
			const { result } = renderHook(() => usePlexOAuth(), { wrapper: createWrapper() });
			await act(async () => {
				result.current.startOAuth();
			});
			await act(async () => {
				result.current.cancel();
			});
			await act(async () => {
				result.current.startOAuth();
			});
			expect(oldPopup.closed).toBe(true);
			await act(async () => {
				if (outcome === "success") oldPin.resolve({ pinId: 1, pinCode: "OLD" });
				else oldPin.reject(new Error("Old PIN failed"));
			});
			expect(result.current).toMatchObject({
				status: "pending",
				error: null,
				tokenRef: null,
				servers: [],
			});
			expect(newPopup.closed).toBe(false);
			expect(oldPopup.location.href).toBe("");
			await tick();
			expect(plexApi.pollPlexPin).not.toHaveBeenCalled();
			await act(async () => {
				newPin.resolve({ pinId: 2, pinCode: "CURRENT" });
			});
			expect(newPopup.location.href).toContain("code=CURRENT");
			vi.mocked(plexApi.pollPlexPin).mockResolvedValue({ tokenRef: "current-ref" });
			await tick();
			expect(plexApi.pollPlexPin).toHaveBeenCalledWith(2, "test-uuid-1234");
			expect(result.current).toMatchObject({
				status: "done",
				error: null,
				tokenRef: "current-ref",
				servers: currentServers,
			});
		},
	);

	it.each(["token", "closed-without-token", "error"])(
		"ignores an old poll %s without releasing the new poll gate",
		async (outcome) => {
			const oldPoll = deferred<Awaited<ReturnType<typeof plexApi.pollPlexPin>>>();
			const newPoll = deferred<Awaited<ReturnType<typeof plexApi.pollPlexPin>>>();
			const oldPopup = createPopup(),
				newPopup = createPopup();
			vi.mocked(globalThis.open)
				.mockReturnValueOnce(oldPopup as unknown as Window)
				.mockReturnValueOnce(newPopup as unknown as Window);
			vi.mocked(plexApi.createPlexPin)
				.mockResolvedValueOnce({ pinId: 1, pinCode: "OLD" })
				.mockResolvedValueOnce({ pinId: 2, pinCode: "CURRENT" });
			vi.mocked(plexApi.pollPlexPin)
				.mockReturnValueOnce(oldPoll.promise)
				.mockReturnValueOnce(newPoll.promise);
			const { result } = renderHook(() => usePlexOAuth(), { wrapper: createWrapper() });
			await act(async () => {
				result.current.startOAuth();
			});
			await tick();
			await act(async () => {
				result.current.cancel();
			});
			await act(async () => {
				result.current.startOAuth();
			});
			await tick();
			expect(plexApi.pollPlexPin).toHaveBeenCalledTimes(2);
			await act(async () => {
				if (outcome === "error") oldPoll.reject(new Error("Old poll failed"));
				else oldPoll.resolve({ tokenRef: outcome === "token" ? "obsolete-ref" : null });
			});
			expect(result.current).toMatchObject({
				status: "polling",
				error: null,
				tokenRef: null,
				servers: [],
			});
			expect(newPopup.closed).toBe(false);
			expect(plexApi.discoverPlexServers).not.toHaveBeenCalled();
			await tick();
			expect(plexApi.pollPlexPin).toHaveBeenCalledTimes(2);
			await act(async () => {
				newPoll.resolve({ tokenRef: "current-ref" });
			});
			expect(result.current).toMatchObject({
				status: "done",
				error: null,
				tokenRef: "current-ref",
				servers: currentServers,
			});
		},
	);

	it.each(["success", "error"])(
		"ignores old discovery %s after cancel and restart",
		async (outcome) => {
			const oldDiscovery = deferred<Awaited<ReturnType<typeof plexApi.discoverPlexServers>>>();
			const oldPopup = createPopup(),
				newPopup = createPopup();
			vi.mocked(globalThis.open)
				.mockReturnValueOnce(oldPopup as unknown as Window)
				.mockReturnValueOnce(newPopup as unknown as Window);
			vi.mocked(plexApi.pollPlexPin)
				.mockResolvedValueOnce({ tokenRef: "obsolete-ref" })
				.mockResolvedValueOnce({ tokenRef: "current-ref" });
			vi.mocked(plexApi.discoverPlexServers).mockReturnValueOnce(oldDiscovery.promise);
			const { result } = renderHook(() => usePlexOAuth(), { wrapper: createWrapper() });
			await act(async () => {
				result.current.startOAuth();
			});
			await tick();
			expect(result.current.status).toBe("discovering");
			await act(async () => {
				result.current.cancel();
			});
			await act(async () => {
				result.current.startOAuth();
			});
			await act(async () => {
				if (outcome === "success") oldDiscovery.resolve({ servers: [] });
				else oldDiscovery.reject(new Error("Old discovery failed"));
			});
			expect(result.current).toMatchObject({
				status: "polling",
				error: null,
				tokenRef: null,
				servers: [],
			});
			expect(newPopup.closed).toBe(false);
			await tick();
			expect(result.current).toMatchObject({
				status: "done",
				error: null,
				tokenRef: "current-ref",
				servers: currentServers,
			});
		},
	);

	it.each(["pin", "poll", "discovery"])(
		"does not resume a pending %s after unmount",
		async (stage) => {
			const pin = deferred<Awaited<ReturnType<typeof plexApi.createPlexPin>>>();
			const poll = deferred<Awaited<ReturnType<typeof plexApi.pollPlexPin>>>();
			const discovery = deferred<Awaited<ReturnType<typeof plexApi.discoverPlexServers>>>();
			if (stage === "pin") vi.mocked(plexApi.createPlexPin).mockReturnValueOnce(pin.promise);
			if (stage === "poll") vi.mocked(plexApi.pollPlexPin).mockReturnValueOnce(poll.promise);
			if (stage === "discovery") {
				vi.mocked(plexApi.pollPlexPin).mockResolvedValueOnce({ tokenRef: "obsolete-ref" });
				vi.mocked(plexApi.discoverPlexServers).mockReturnValueOnce(discovery.promise);
			}
			const { result, unmount } = renderHook(() => usePlexOAuth(), { wrapper: createWrapper() });
			await act(async () => {
				result.current.startOAuth();
			});
			if (stage !== "pin") await tick();
			const before = {
				location: mockPopup.location.href,
				polls: vi.mocked(plexApi.pollPlexPin).mock.calls.length,
				discoveries: vi.mocked(plexApi.discoverPlexServers).mock.calls.length,
			};
			unmount();
			await act(async () => {
				if (stage === "pin") pin.resolve({ pinId: 1, pinCode: "OLD" });
				if (stage === "poll") poll.resolve({ tokenRef: "obsolete-ref" });
				if (stage === "discovery") discovery.resolve({ servers: [] });
			});
			await tick();
			expect(mockPopup.closed).toBe(true);
			expect(mockPopup.location.href).toBe(before.location);
			expect(plexApi.pollPlexPin).toHaveBeenCalledTimes(before.polls);
			expect(plexApi.discoverPlexServers).toHaveBeenCalledTimes(before.discoveries);
		},
	);

	it("retries a transient poll failure and completes the current attempt", async () => {
		vi.mocked(plexApi.pollPlexPin)
			.mockRejectedValueOnce(new Error("Temporary poll failure"))
			.mockResolvedValueOnce({ tokenRef: "current-ref" });
		const { result } = renderHook(() => usePlexOAuth(), { wrapper: createWrapper() });
		await act(async () => {
			result.current.startOAuth();
		});
		await tick();
		expect(result.current).toMatchObject({ status: "polling", error: null });
		await tick();
		expect(result.current).toMatchObject({
			status: "done",
			tokenRef: "current-ref",
			servers: currentServers,
		});
	});

	it("retains the two-minute polling deadline and closes the current popup", async () => {
		const { result } = renderHook(() => usePlexOAuth(), { wrapper: createWrapper() });
		await act(async () => {
			result.current.startOAuth();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(120_000);
		});
		expect(result.current.status).toBe("polling");
		await tick();
		expect(result.current.status).toBe("error");
		expect(result.current.error).toContain("timed out");
		expect(mockPopup.closed).toBe(true);
	});

	it("reports discovery failure for the current attempt", async () => {
		vi.mocked(plexApi.pollPlexPin).mockResolvedValueOnce({ tokenRef: "current-ref" });
		vi.mocked(plexApi.discoverPlexServers).mockRejectedValueOnce(
			new Error("Current discovery failed"),
		);
		const { result } = renderHook(() => usePlexOAuth(), { wrapper: createWrapper() });
		await act(async () => {
			result.current.startOAuth();
		});
		await tick();
		expect(result.current).toMatchObject({
			status: "error",
			error: "Current discovery failed",
			tokenRef: "current-ref",
			servers: [],
		});
	});
});
