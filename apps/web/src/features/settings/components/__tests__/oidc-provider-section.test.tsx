import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { initiateOIDCLogin, oidcState } = vi.hoisted(() => ({
	initiateOIDCLogin: vi.fn(),
	oidcState: { linked: false },
}));

vi.mock("../../../../hooks/api/useOIDCProviders", () => ({
	useOIDCProvider: () => ({
		data: {
			provider: {
				id: 1,
				displayName: "Authentik",
				clientId: "arr-dashboard",
				issuer: "https://auth.example.com/application/o/arr-dashboard/",
				redirectUri: "https://arr.example.com/auth/oidc/callback",
				scopes: "openid,email,profile",
				enabled: true,
				createdAt: "2026-07-29T00:00:00.000Z",
				updatedAt: "2026-07-29T00:00:00.000Z",
			},
			linked: oidcState.linked,
		},
		isLoading: false,
	}),
	useCreateOIDCProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateOIDCProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteOIDCProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#111111", to: "#222222", glow: "#333333" },
	}),
}));

vi.mock("../../../../lib/api-client/auth", () => ({
	initiateOIDCLogin,
}));

import { OIDCProviderSection } from "../oidc-provider-section";

describe("OIDCProviderSection account linking", () => {
	beforeEach(() => {
		initiateOIDCLogin.mockReset();
		oidcState.linked = false;
	});

	it("offers existing installations an explicit admin-link action", async () => {
		initiateOIDCLogin.mockRejectedValueOnce(new Error("provider unavailable"));
		render(<OIDCProviderSection />);

		expect(screen.getByText("Not linked")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /link account/i }));

		await waitFor(() => expect(initiateOIDCLogin).toHaveBeenCalledWith("link"));
		expect(await screen.findByText("provider unavailable")).toBeDefined();
	});

	it("offers linked installations both test and relink recovery actions", async () => {
		oidcState.linked = true;
		initiateOIDCLogin.mockRejectedValueOnce(new Error("provider unavailable"));

		render(<OIDCProviderSection />);

		expect(screen.getByText("Linked")).toBeDefined();
		expect(screen.getByRole("button", { name: /relink account/i })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /test account/i }));

		await waitFor(() => expect(initiateOIDCLogin).toHaveBeenCalledWith("test"));
	});

	it("starts a new link flow when the stored identity is stale", async () => {
		oidcState.linked = true;
		initiateOIDCLogin.mockRejectedValueOnce(new Error("provider unavailable"));

		render(<OIDCProviderSection />);

		fireEvent.click(screen.getByRole("button", { name: /relink account/i }));

		await waitFor(() => expect(initiateOIDCLogin).toHaveBeenCalledWith("link"));
	});
});
