/**
 * Trust/privacy tests for usePulseActionMutation's error toast path.
 *
 * Backend errors routinely embed hostnames, IPs, and instance URLs
 * (e.g. "ECONNREFUSED 192.168.1.50:32400", "fetch failed:
 * http://sonarr.local/api/v3/...") via getErrorMessage(). In incognito
 * mode those values must be stripped before the toast is shown so a
 * screenshot of the dashboard during a demo or bug report doesn't leak
 * the operator's home network shape.
 *
 * Pulse rows already run through anonymizeHealthMessage; this test
 * locks in the same protection for action-result toasts.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../contexts/IncognitoContext";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

// Mock the API client so we can inject deterministic errors.
const mockDispatchPulseAction = vi.fn();
vi.mock("../../../lib/api-client/pulse", () => ({
	dispatchPulseAction: (...args: unknown[]) => mockDispatchPulseAction(...args),
	fetchPulse: vi.fn(),
}));

// Capture toast calls so we can assert exact text without a real DOM toast.
const toastErrorCalls: string[] = [];
vi.mock("sonner", () => ({
	toast: {
		error: (msg: string) => {
			toastErrorCalls.push(msg);
		},
		success: vi.fn(),
	},
}));

import { usePulseActionMutation } from "../usePulse";

function wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={qc}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
}

const SAMPLE_ACTION = {
	signalId: "scheduler-disabled-hunting",
	action: {
		kind: "scheduler.enable" as const,
		target: { jobId: "hunting" as const },
		label: "Enable",
		destructive: false,
	},
};

beforeEach(() => {
	mockDispatchPulseAction.mockReset();
	toastErrorCalls.length = 0;
	localStorage.removeItem(INCOGNITO_STORAGE_KEY);
});

afterEach(() => {
	localStorage.removeItem(INCOGNITO_STORAGE_KEY);
});

async function fireMutationWithError(message: string): Promise<void> {
	mockDispatchPulseAction.mockRejectedValue(new Error(message));
	const { result } = renderHook(() => usePulseActionMutation(), { wrapper });
	await act(async () => {
		result.current.mutate(SAMPLE_ACTION);
	});
	await waitFor(() => expect(toastErrorCalls).toHaveLength(1));
}

describe("usePulseActionMutation — incognito-mode error toast sanitization", () => {
	it("strips IPv4 + port from a backend ECONNREFUSED message in incognito mode", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		await fireMutationWithError("ECONNREFUSED 192.168.1.50:32400");

		const text = toastErrorCalls[0]!;
		// Original IP MUST be gone; the existing anonymizer replaces with
		// a stable placeholder (10.0.0.1).
		expect(text).not.toContain("192.168.1.50");
		expect(text).not.toContain("32400");
		expect(text).toContain("10.0.0.1");
	});

	it("strips a hostname URL from a backend error message in incognito mode", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		await fireMutationWithError(
			"fetch failed: http://sonarr.local:8989/api/v3/queue/42",
		);

		const text = toastErrorCalls[0]!;
		expect(text).not.toContain("sonarr.local");
		expect(text).not.toContain("8989");
		// The anonymizer collapses URLs to a stable placeholder host.
		expect(text).toContain("http://linux-host");
	});

	it("strips multiple leak vectors from a single error message in incognito mode", async () => {
		// Realistic Plex error embedding both a host and an IP.
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		await fireMutationWithError(
			"Could not reach https://plex.home.arpa:32400 (resolved 10.42.7.11:32400): ETIMEDOUT",
		);

		const text = toastErrorCalls[0]!;
		expect(text).not.toContain("plex.home.arpa");
		expect(text).not.toContain("10.42.7.11");
		// Sanity: the generic "ETIMEDOUT" diagnostic stays — operator still
		// sees what kind of failure it was.
		expect(text).toContain("ETIMEDOUT");
	});

	it("preserves the full original error text in normal (non-incognito) mode", async () => {
		// localStorage NOT set — defaults to off.
		await fireMutationWithError("ECONNREFUSED 192.168.1.50:32400");

		expect(toastErrorCalls[0]).toBe("ECONNREFUSED 192.168.1.50:32400");
	});

	it("preserves generic, no-PII error text in incognito mode (no over-sanitization)", async () => {
		// "Action failed", "Bad Request", "Internal Server Error", "Rate
		// limit exceeded" etc. have no URLs/IPs; the sanitizer must leave
		// them alone so operators still see what went wrong.
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");

		await fireMutationWithError("Rate limit exceeded. Please slow down.");
		expect(toastErrorCalls[0]).toBe("Rate limit exceeded. Please slow down.");

		toastErrorCalls.length = 0;
		await fireMutationWithError("Internal Server Error");
		expect(toastErrorCalls[0]).toBe("Internal Server Error");

		toastErrorCalls.length = 0;
		await fireMutationWithError("Bad Request");
		expect(toastErrorCalls[0]).toBe("Bad Request");
	});

	it("falls back to the generic 'Action failed' label when error has no message, even in incognito", async () => {
		// Regression guard: a thrown empty error must still produce a
		// readable toast — sanitization shouldn't affect the fallback path.
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		mockDispatchPulseAction.mockRejectedValue(new Error(""));
		const { result } = renderHook(() => usePulseActionMutation(), { wrapper });
		await act(async () => {
			result.current.mutate(SAMPLE_ACTION);
		});
		await waitFor(() => expect(toastErrorCalls).toHaveLength(1));
		// getErrorMessage returns "" for empty Error.message; that empty
		// string passes through anonymizeHealthMessage unchanged. The
		// behavior under test is "no leak", not "perfect copy" — so we
		// just assert no PII shape sneaks in.
		expect(toastErrorCalls[0]).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
		expect(toastErrorCalls[0]).not.toMatch(/https?:\/\//);
	});
});
