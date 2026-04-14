import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import type { SecurityPosture } from "../../../../lib/api-client/system";
import { SecurityPostureSection } from "../security-posture-section";

const renderWithTheme = (ui: ReactElement) => render(<ColorThemeProvider>{ui}</ColorThemeProvider>);

/*
 * Verifies the AsyncStateView adoption on SecurityPostureSection (#326).
 *
 * The underlying `AsyncStateView` + `AsyncErrorCard` primitives are already
 * tested elsewhere — what this suite locks in is the *wiring*:
 *   - loading branch renders the skeleton scaffold, not the bespoke text
 *   - error branch renders a retry button that actually calls `onRetry`
 *   - posture present renders the full content (no AsyncStateView takeover)
 *
 * Without these checks, a future refactor could silently regress the retry
 * affordance (e.g. by forgetting to thread `onRetry` through) and the
 * operator would be stuck on a broken panel with no way out.
 */

function makePosture(overrides: Partial<SecurityPosture> = {}): SecurityPosture {
	const base: SecurityPosture = {
		capturedAt: new Date(0).toISOString(),
		overall: "healthy",
		checks: [],
		auth: {
			passwordEnabled: true,
			passwordUserCount: 1,
			oidcEnabled: false,
			passkeyCount: 0,
		},
		effective: {
			nodeEnv: "development",
			trustProxy: false,
			secureCookies: false,
			sessionTtlHours: 24,
			sessionCookieName: "arr.sid",
			passwordPolicy: "strict",
			appUrl: "http://localhost:3000",
		},
	};
	return { ...base, ...overrides };
}

describe("SecurityPostureSection", () => {
	it("renders a skeleton scaffold while loading with no posture yet", () => {
		renderWithTheme(<SecurityPostureSection posture={undefined} isLoading={true} />);
		// Section chrome stays visible so the layout doesn't jump.
		expect(screen.getByText("Security Posture")).toBeInTheDocument();
		// Loading branch uses role="status" via AsyncStateView.
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("renders the themed error card with a retry button when isError && no posture", () => {
		const onRetry = vi.fn();
		renderWithTheme(
			<SecurityPostureSection
				posture={undefined}
				isLoading={false}
				isError={true}
				onRetry={onRetry}
			/>,
		);
		// Error title comes from the prop we passed into AsyncStateView.
		expect(screen.getByText("Couldn't load security posture")).toBeInTheDocument();
		const retry = screen.getByRole("button", { name: /try again/i });
		fireEvent.click(retry);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("renders the real error message instead of the generic fallback when one is passed", () => {
		const realError = new Error("503 Service Unavailable");
		renderWithTheme(
			<SecurityPostureSection
				posture={undefined}
				isLoading={false}
				isError={true}
				error={realError}
				onRetry={vi.fn()}
			/>,
		);
		expect(screen.getByText("Couldn't load security posture")).toBeInTheDocument();
		// The operator-facing error description should be the real message,
		// not AsyncStateView's default fallback ("Something went wrong…").
		expect(screen.getByText("503 Service Unavailable")).toBeInTheDocument();
		expect(screen.queryByText(/something went wrong while loading/i)).not.toBeInTheDocument();
	});

	it("surfaces the contract-violation no-data case as an error (with retry), not as an empty state", () => {
		// The "loaded but posture missing" path used to render as 'empty', which
		// implied success. It's actually a bug state — the API always returns
		// a posture. This test pins that the operator sees an error + retry.
		const onRetry = vi.fn();
		renderWithTheme(
			<SecurityPostureSection posture={undefined} isLoading={false} onRetry={onRetry} />,
		);
		expect(screen.getByText("Security posture unavailable")).toBeInTheDocument();
		expect(screen.getByText(/didn't return any posture data/i)).toBeInTheDocument();
		const retry = screen.getByRole("button", { name: /try again/i });
		fireEvent.click(retry);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("renders the full posture content when data is present (AsyncStateView does not take over)", () => {
		const posture = makePosture({
			overall: "warning",
			checks: [
				{
					id: "auth-methods",
					label: "Authentication",
					severity: "warning",
					detail: "Password-only authentication is in use.",
					remediation: "Enable a passkey or OIDC.",
				},
			],
		});
		renderWithTheme(<SecurityPostureSection posture={posture} isLoading={false} />);
		expect(screen.getByText("Authentication")).toBeInTheDocument();
		expect(screen.getByText("Password-only authentication is in use.")).toBeInTheDocument();
		// The "Recommended improvements" banner copy only appears on the loaded path.
		expect(screen.getByText("Recommended improvements")).toBeInTheDocument();
	});
});
