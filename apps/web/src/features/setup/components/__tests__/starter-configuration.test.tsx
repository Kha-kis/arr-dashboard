import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	mutateAsync: vi.fn(),
	incognito: false,
	starters: [
		{
			id: "notification-throttle" as const,
			kind: "notifications" as const,
			title: "Throttle repeated hunt matches",
			description: "Notification starter",
			effect: "Creates a disabled throttle rule.",
			available: true,
			unavailableReason: null,
			existing: false,
			source: null,
			destination: null,
		},
		{
			id: "auto-tag-recent" as const,
			kind: "auto-tag" as const,
			title: "Tag recently added media",
			description: "Auto-Tag starter",
			effect: "Creates a disabled tag rule.",
			available: true,
			unavailableReason: null,
			existing: false,
			source: { id: "sonarr-1", service: "sonarr" as const, label: "Family Sonarr" },
			destination: null,
		},
		{
			id: "label-sync-recent" as const,
			kind: "label-sync" as const,
			title: "Sync the recently added label",
			description: "Label Sync starter",
			effect: "Creates a disabled label mapping.",
			available: true,
			unavailableReason: null,
			existing: false,
			source: { id: "sonarr-1", service: "sonarr" as const, label: "Family Sonarr" },
			destination: { id: "plex-1", service: "plex" as const, label: "Family Plex" },
		},
	],
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));

vi.mock("../../../../hooks/api/useSetupStarters", () => ({
	useSetupStarters: () => ({ data: { starters: mocks.starters }, isLoading: false, error: null }),
	useApplySetupStarters: () => ({
		mutateAsync: mocks.mutateAsync,
		isPending: false,
		error: null,
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "blue", to: "purple", glow: "blue" } }),
}));

vi.mock("../../../../lib/incognito", () => ({
	useIncognitoMode: () => [mocks.incognito, vi.fn()],
	getLinuxServerName: () => "linux-server",
}));

import { StarterConfiguration } from "../starter-configuration";

describe("StarterConfiguration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.incognito = false;
		mocks.mutateAsync.mockResolvedValue({ created: ["notification-throttle"], existing: [] });
	});

	it("creates only explicitly selected starters as disabled drafts", async () => {
		render(<StarterConfiguration />);

		expect(screen.queryByRole("button", { name: /Create/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("checkbox", { name: /Throttle repeated hunt matches/ }));
		fireEvent.click(screen.getByRole("button", { name: "Create 1 disabled draft" }));

		await waitFor(() => {
			expect(mocks.mutateAsync).toHaveBeenCalledWith({
				starterIds: ["notification-throttle"],
			});
		});
		expect(screen.getByText(/Created 1 disabled draft/)).toBeInTheDocument();
	});

	it("masks service labels and supports safe navigation without applying", () => {
		mocks.incognito = true;
		render(<StarterConfiguration />);

		expect(screen.queryByText("Family Sonarr", { exact: false })).not.toBeInTheDocument();
		expect(screen.getAllByText(/linux-server/).length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mocks.push).toHaveBeenCalledWith("/setup?stage=console");
		expect(mocks.mutateAsync).not.toHaveBeenCalled();
	});

	it("returns to service setup", () => {
		render(<StarterConfiguration />);
		fireEvent.click(screen.getByRole("button", { name: "Back to services" }));
		expect(mocks.push).toHaveBeenCalledWith("/setup?stage=services");
	});
});
