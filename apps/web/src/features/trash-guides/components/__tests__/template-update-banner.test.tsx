import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TemplateUpdateBanner } from "../template-update-banner";

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#6366f1", to: "#8b5cf6", fromMuted: "#6366f155", fromLight: "#6366f111" },
	}),
}));

vi.mock("../template-diff-modal", () => ({
	TemplateDiffModal: () => <div data-testid="template-diff-modal" />,
}));

describe("TemplateUpdateBanner", () => {
	it("shows deployment catch-up without offering template sync actions", () => {
		render(
			<TemplateUpdateBanner
				update={{
					templateId: "template-1",
					templateName: "Anime",
					currentCommit: "current",
					latestCommit: "current",
					hasUserModifications: false,
					autoSyncInstanceCount: 1,
					canAutoSync: true,
					serviceType: "SONARR",
					deploymentCatchUp: true,
				}}
			/>,
		);

		expect(screen.getByText("Deployment Catch-up Pending")).toBeInTheDocument();
		expect(
			screen.getByText("A re-enabled auto-sync target will be brought up to date automatically."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "View Changes" })).toBeNull();
		expect(screen.queryByTestId("template-diff-modal")).toBeNull();
	});

	it("explains when local modifications block automatic deployment catch-up", () => {
		render(
			<TemplateUpdateBanner
				update={{
					templateId: "template-1",
					templateName: "Anime",
					currentCommit: "current",
					latestCommit: "current",
					hasUserModifications: true,
					autoSyncInstanceCount: 1,
					canAutoSync: false,
					serviceType: "SONARR",
					deploymentCatchUp: true,
				}}
			/>,
		);

		expect(screen.getByText("Manual Deployment Needed")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Local template modifications prevent automatic catch-up. Review them, then use Deploy to Instance to update the re-enabled target.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Deployment Catch-up Pending")).toBeNull();
		expect(screen.queryByText(/brought up to date automatically/i)).toBeNull();
		expect(screen.queryByRole("button", { name: "View Changes" })).toBeNull();
		expect(screen.queryByTestId("template-diff-modal")).toBeNull();
	});
});
