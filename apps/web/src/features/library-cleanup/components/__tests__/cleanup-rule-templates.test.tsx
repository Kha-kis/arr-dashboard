import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CleanupRuleTemplates } from "../cleanup-rule-templates.js";

vi.mock("@/hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#3b82f6",
			to: "#8b5cf6",
			fromLight: "#3b82f610",
			fromMuted: "#3b82f630",
		},
	}),
}));

const props = {
	hasPlex: false,
	hasJellyfin: false,
	hasSeerr: false,
	hasTautulli: false,
	onSelectTemplate: vi.fn(),
};

describe("CleanupRuleTemplates", () => {
	it("offers requester templates with Seerr and Jellyfin only", () => {
		render(<CleanupRuleTemplates {...props} hasJellyfin hasSeerr />);

		expect(screen.getByText("Requested & Watched")).toBeInTheDocument();
		expect(screen.getByText("Requested but Not Watched")).toBeInTheDocument();
	});

	it("offers no requester templates without Seerr or a watch provider", () => {
		render(<CleanupRuleTemplates {...props} hasSeerr />);

		expect(screen.queryByText("Requested & Watched")).not.toBeInTheDocument();
		expect(screen.queryByText("Requested but Not Watched")).not.toBeInTheDocument();
	});
});
