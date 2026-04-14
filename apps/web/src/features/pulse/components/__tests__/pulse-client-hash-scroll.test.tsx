/**
 * Regression test for the hash-scroll + highlight effect in <PulseClient />.
 *
 * Trust-check finding #8: the Needs Attention panel on the dashboard
 * deep-links to /pulse via `actionUrl: "/pulse#<item.id>"`. When the
 * operator clicks through, PulseClient must scroll the matching row into
 * view and paint a short-lived outline highlight so they land exactly
 * where they clicked — not at the top of an unfiltered feed.
 *
 * jsdom doesn't implement layout, so we can't observe actual scroll
 * behavior; we spy on `Element.prototype.scrollIntoView` and assert it's
 * called against the correct element. For the highlight we assert the
 * inline `outline` style is applied and then cleared after the 2-second
 * timeout (driven by fake timers).
 */

import type { PulseResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUsePulseQuery = vi.fn();
vi.mock("../../../../hooks/api/usePulse", () => ({
	usePulseQuery: (args?: unknown) => mockUsePulseQuery(args),
}));

// Stub useThemeGradient so we don't have to wire ColorThemeProvider.
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#6366f1", to: "#8b5cf6" } }),
}));

// Avoid touching getServiceGradient's theme-gradient machinery indirectly.
vi.mock("../../../../lib/theme-gradients", async () => {
	const actual = await vi.importActual<typeof import("../../../../lib/theme-gradients")>(
		"../../../../lib/theme-gradients",
	);
	return actual;
});

import { PulseClient } from "../pulse-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(): PulseResponse {
	return {
		items: [
			{
				id: "scheduler-failing-queue-cleaner",
				severity: "warning",
				category: "operations",
				title: "Queue Cleaner is failing",
				detail: "2 consecutive failures",
				source: "system",
				timestamp: "2026-04-14T09:30:00.000Z",
				actionUrl: "/pulse#scheduler-failing-queue-cleaner",
			},
			{
				id: "other-item",
				severity: "info",
				category: "health",
				title: "Everything else",
				detail: "",
				source: "system",
				timestamp: "2026-04-14T09:30:00.000Z",
			},
		],
		summary: { critical: 0, warning: 1, info: 1 },
		generatedAt: "2026-04-14T09:30:00.000Z",
	};
}

function Wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let scrollIntoViewSpy: ReturnType<typeof vi.fn>;
let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

beforeEach(() => {
	mockUsePulseQuery.mockReset();
	// jsdom doesn't implement scrollIntoView — install a spy we can assert on.
	// Cast to the DOM signature because `vi.fn()` has a broader `Procedure`
	// type than `Element.prototype.scrollIntoView`.
	originalScrollIntoView = Element.prototype.scrollIntoView;
	scrollIntoViewSpy = vi.fn();
	Element.prototype.scrollIntoView =
		scrollIntoViewSpy as unknown as typeof Element.prototype.scrollIntoView;
	// Reset the URL hash between tests.
	window.history.replaceState(null, "", "/");
});

afterEach(() => {
	Element.prototype.scrollIntoView = originalScrollIntoView;
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("<PulseClient /> hash-scroll effect", () => {
	it("scrolls the matching row into view and highlights it when the URL has a hash", () => {
		vi.useFakeTimers();
		window.history.replaceState(null, "", "/pulse#scheduler-failing-queue-cleaner");
		mockUsePulseQuery.mockReturnValue({
			data: makeResponse(),
			isLoading: false,
			isError: false,
			isFetching: false,
			dataUpdatedAt: Date.now(),
		});

		const { container } = render(<PulseClient />, { wrapper: Wrapper });

		// The effect runs synchronously on the initial commit — data is already
		// present in the first render thanks to the mocked hook.
		expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
		expect(scrollIntoViewSpy.mock.instances[0]).toBeInstanceOf(Element);
		const target = container.querySelector("#scheduler-failing-queue-cleaner");
		expect(target).not.toBeNull();
		expect(scrollIntoViewSpy.mock.instances[0]).toBe(target);

		// Highlight applied.
		const element = target as HTMLElement;
		expect(element.style.outline).not.toBe("");
		expect(element.style.outlineOffset).toBe("2px");

		// After 2s the highlight is cleared.
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(element.style.outline).toBe("");
		expect(element.style.outlineOffset).toBe("");
	});

	it("does not scroll when the URL has no hash", () => {
		window.history.replaceState(null, "", "/pulse");
		mockUsePulseQuery.mockReturnValue({
			data: makeResponse(),
			isLoading: false,
			isError: false,
			isFetching: false,
			dataUpdatedAt: Date.now(),
		});

		render(<PulseClient />, { wrapper: Wrapper });
		expect(scrollIntoViewSpy).not.toHaveBeenCalled();
	});

	it("does not throw when the hash targets an id that isn't in the feed", () => {
		window.history.replaceState(null, "", "/pulse#nonexistent-id");
		mockUsePulseQuery.mockReturnValue({
			data: makeResponse(),
			isLoading: false,
			isError: false,
			isFetching: false,
			dataUpdatedAt: Date.now(),
		});

		expect(() => render(<PulseClient />, { wrapper: Wrapper })).not.toThrow();
		expect(scrollIntoViewSpy).not.toHaveBeenCalled();
	});
});
