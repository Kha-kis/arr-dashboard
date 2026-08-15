import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { DeploymentHistoryDetailsModal } from "../deployment-history-details-modal";

const { mockUseDeploymentHistoryDetail } = vi.hoisted(() => ({
	mockUseDeploymentHistoryDetail: vi.fn(),
}));

vi.mock("../../../../hooks/api/useDeploymentHistory", () => ({
	useDeploymentHistoryDetail: mockUseDeploymentHistoryDetail,
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#6366f1", to: "#8b5cf6" },
	}),
}));

type AppliedConfig = {
	name: string;
	action: string;
	type?: string;
};

function deploymentDetail(appliedConfigs: AppliedConfig[]) {
	return {
		success: true,
		data: {
			id: "history-1",
			instanceId: "instance-1",
			templateId: "template-1",
			userId: "user-1",
			deployedAt: "2026-08-10T12:00:00.000Z",
			deployedBy: "user-1",
			duration: 5,
			status: "SUCCESS",
			appliedCFs: 1,
			failedCFs: 0,
			totalCFs: 1,
			conflictsCount: 0,
			appliedConfigs,
			failedConfigs: [],
			conflictResolutions: null,
			errors: null,
			warnings: null,
			backupId: null,
			canRollback: false,
			rolledBack: false,
			rolledBackAt: null,
			rolledBackBy: null,
			deploymentNotes: null,
			templateSnapshot: null,
		},
	};
}

function renderModal(appliedConfigs: AppliedConfig[]) {
	mockUseDeploymentHistoryDetail.mockReturnValue({
		data: deploymentDetail(appliedConfigs),
		isLoading: false,
		error: null,
	});

	render(
		<IncognitoProvider>
			<DeploymentHistoryDetailsModal historyId="history-1" onClose={vi.fn()} />
		</IncognitoProvider>,
	);
}

describe("DeploymentHistoryDetailsModal", () => {
	it("renders typed applied resources in separately counted sections", () => {
		renderModal([
			{ name: "Movie CF", action: "created", type: "custom_format" },
			{ name: "HD-1080p", action: "updated", type: "quality_profile" },
			{ name: "Naming configuration", action: "updated", type: "naming" },
		]);

		const customFormats = screen.getByRole("heading", {
			name: "Applied Custom Formats (1)",
		}).parentElement;
		const qualityProfiles = screen.getByRole("heading", {
			name: "Applied Quality Profiles (1)",
		}).parentElement;
		const namingConfigurations = screen.getByRole("heading", {
			name: "Applied Naming Configurations (1)",
		}).parentElement;

		expect(customFormats).not.toBeNull();
		expect(qualityProfiles).not.toBeNull();
		expect(namingConfigurations).not.toBeNull();
		expect(within(customFormats!).getByText("Movie CF")).toBeInTheDocument();
		expect(within(qualityProfiles!).getByText("HD-1080p")).toBeInTheDocument();
		expect(within(namingConfigurations!).getByText("Naming configuration")).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Applied Custom Formats (3)" })).toBeNull();
	});

	it("keeps legacy untyped entries as custom formats without mislabeling unknown typed entries", () => {
		renderModal([
			{ name: "Legacy CF", action: "created" },
			{ name: "Future resource", action: "updated", type: "metadata" },
		]);

		const customFormats = screen.getByRole("heading", {
			name: "Applied Custom Formats (1)",
		}).parentElement;
		const otherConfigs = screen.getByRole("heading", {
			name: "Applied Configurations (1)",
		}).parentElement;

		expect(customFormats).not.toBeNull();
		expect(otherConfigs).not.toBeNull();
		expect(within(customFormats!).getByText("Legacy CF")).toBeInTheDocument();
		expect(within(otherConfigs!).getByText("Future resource")).toBeInTheDocument();
	});
});
