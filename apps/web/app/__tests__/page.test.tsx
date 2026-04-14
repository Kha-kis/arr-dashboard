/**
 * Regression tests for the root route (`/`).
 *
 * The product contract:
 *   - Authenticated users landing on `/` go to `/dashboard`.
 *   - Unauthenticated users go to `/login`.
 *   - Setup-required installs go to `/setup`.
 *
 * This file pins the first rule specifically — it is the change that made
 * Dashboard (with the Needs Attention panel) the primary landing surface
 * instead of Pulse. The other two branches are asserted at the same
 * granularity to keep the test file the single source of truth on where
 * `/` sends you.
 */

import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// UI stub — the real Skeleton requires a ColorThemeProvider. Render a plain
// placeholder so the component under test (the routing effect) is what we
// actually exercise.
// ---------------------------------------------------------------------------
vi.mock("../../src/components/ui", () => ({
	Skeleton: ({ className }: { className?: string }) => (
		<div data-testid="skeleton" className={className} />
	),
}));

// ---------------------------------------------------------------------------
// Router mock — captures which route the root page redirects to.
// ---------------------------------------------------------------------------
const replace = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Auth hooks — the root page's branching depends entirely on these.
// ---------------------------------------------------------------------------
const useSetupRequired = vi.fn();
const useCurrentUser = vi.fn();
vi.mock("../../src/hooks/api/useAuth", () => ({
	useSetupRequired: () => useSetupRequired(),
	useCurrentUser: (enabled: boolean) => useCurrentUser(enabled),
}));

import HomePage from "../page";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
	replace.mockReset();
	useSetupRequired.mockReset();
	useCurrentUser.mockReset();
	// Silence the `/setup` branch's use of `window.location.href`.
	Object.defineProperty(window, "location", {
		value: { href: "" },
		writable: true,
	});
});

describe("HomePage (`/`) routing", () => {
	it("redirects authenticated users to /dashboard", async () => {
		useSetupRequired.mockReturnValue({
			data: { required: false },
			isLoading: false,
			error: null,
		});
		useCurrentUser.mockReturnValue({
			data: { id: "u1", username: "admin" },
			isLoading: false,
		});

		render(wrap(<HomePage />));

		await waitFor(() => {
			expect(replace).toHaveBeenCalledWith("/dashboard");
		});
		// Crucially: NOT `/pulse` — regression guard for the product decision
		// that Dashboard (with the Needs Attention panel) is the primary
		// landing surface.
		expect(replace).not.toHaveBeenCalledWith("/pulse");
	});

	it("redirects unauthenticated users to /login", async () => {
		useSetupRequired.mockReturnValue({
			data: { required: false },
			isLoading: false,
			error: null,
		});
		useCurrentUser.mockReturnValue({ data: null, isLoading: false });

		render(wrap(<HomePage />));

		await waitFor(() => {
			expect(replace).toHaveBeenCalledWith("/login");
		});
		expect(replace).not.toHaveBeenCalledWith("/dashboard");
	});

	it("redirects to /login when the setup-required probe errors", async () => {
		useSetupRequired.mockReturnValue({
			data: undefined,
			isLoading: false,
			error: new Error("network"),
		});
		useCurrentUser.mockReturnValue({ data: undefined, isLoading: false });

		render(wrap(<HomePage />));

		await waitFor(() => {
			expect(replace).toHaveBeenCalledWith("/login");
		});
	});
});
