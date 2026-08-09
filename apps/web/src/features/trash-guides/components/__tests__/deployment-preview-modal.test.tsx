import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError } from "../../../../lib/api-client/base";

const previewMocks = vi.hoisted(() => ({
	mutationData: undefined as unknown,
	mutationError: null as Error | null,
}));

vi.mock("../../../../hooks/api/useDeploymentPreview", () => ({
	useDeploymentPreview: () => ({
		isLoading: false,
		error: null,
		data: useMemo(
			() => ({
				success: true,
				data: {
					instanceLabel: "Private Radarr",
					instanceServiceType: "RADARR",
					instanceReachable: true,
					instanceVersion: "6.0.0",
					canDeploy: true,
					executionToken: "token",
					existingSyncStrategy: "notify",
					warnings: ["Preview includes Private Preview Format"],
					requiresConflictResolution: true,
					customFormats: [
						{
							trashId: "private-format",
							name: "Private Preview Format",
							action: "update",
							defaultScore: 100,
							hasConflicts: true,
							conflicts: [
								{
									conflictType: "name",
									templateValue: "Private Template Value",
									instanceValue: "Private Instance Value",
								},
							],
						},
					],
					orphanedCustomFormats: [{ instanceId: 7, name: "Private Orphaned Format", score: 125 }],
					unmatchedCustomFormats: [
						{
							instanceId: 8,
							name: "Private Unmatched Format",
							reason: "Private match reason",
						},
					],
					summary: {
						totalItems: 1,
						newCustomFormats: 0,
						updatedCustomFormats: 1,
						totalConflicts: 1,
						unresolvedConflicts: 1,
						orphanedCustomFormats: 1,
						unmatchedCustomFormats: 1,
					},
				},
			}),
			[],
		),
	}),
	useExecuteDeployment: () => ({
		mutate: vi.fn(),
		isPending: false,
		isError: previewMocks.mutationError !== null,
		error: previewMocks.mutationError,
		data: previewMocks.mutationData,
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#334155",
			to: "#475569",
			glow: "#334155",
			fromLight: "#33415520",
			fromMuted: "#33415560",
		},
	}),
}));

import { DeploymentPreviewModal } from "../deployment-preview-modal";

function Wrapper({ children }: { children: ReactNode }) {
	return <IncognitoProvider>{children}</IncognitoProvider>;
}

describe("DeploymentPreviewModal incognito additions", () => {
	beforeEach(() => {
		previewMocks.mutationData = undefined;
		previewMocks.mutationError = null;
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
	});

	it("masks every name-bearing preview field and conflict detail", async () => {
		render(
			<DeploymentPreviewModal
				open={true}
				onClose={vi.fn()}
				templateId="template-1"
				templateName="Private Template"
				instanceId="instance-1"
				instanceLabel="Private Radarr"
			/>,
			{ wrapper: Wrapper },
		);

		await waitFor(() => {
			expect(screen.getByText("Custom Format score reset 1")).toBeInTheDocument();
		});
		expect(screen.getByText(/TRaSH template/)).toBeInTheDocument();
		expect(screen.getByText(/Instance \(RADARR\)/)).toBeInTheDocument();
		expect(screen.getByText("Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Unmatched Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Preview warnings hidden in incognito mode.")).toBeInTheDocument();
		expect(screen.getByText("Match details hidden in incognito mode.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "View differences" }));
		expect(screen.getAllByText("Conflict details hidden in incognito mode.")).toHaveLength(2);
		expect(screen.queryByText(/Private Radarr/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Private Template/)).not.toBeInTheDocument();
		expect(screen.queryByText("Private Preview Format")).not.toBeInTheDocument();
		expect(screen.queryByText("Private Orphaned Format")).not.toBeInTheDocument();
		expect(screen.queryByText("Private Unmatched Format")).not.toBeInTheDocument();
		expect(screen.queryByText("Private match reason")).not.toBeInTheDocument();
		expect(screen.queryByText("Private Template Value")).not.toBeInTheDocument();
		expect(screen.queryByText("Private Instance Value")).not.toBeInTheDocument();
		expect(screen.queryByText("Preview includes Private Preview Format")).not.toBeInTheDocument();
	});

	it("masks name-bearing deployment warnings", async () => {
		previewMocks.mutationData = {
			success: true,
			result: { warnings: ["Reset Private Orphaned Format on Private Radarr"] },
		};

		render(
			<DeploymentPreviewModal
				open={true}
				onClose={vi.fn()}
				templateId="template-1"
				templateName="Private Template"
				instanceId="instance-1"
				instanceLabel="Private Radarr"
			/>,
			{ wrapper: Wrapper },
		);

		await waitFor(() => {
			expect(screen.getByText("Deployment warnings hidden in incognito mode.")).toBeInTheDocument();
		});
		expect(
			screen.queryByText("Reset Private Orphaned Format on Private Radarr"),
		).not.toBeInTheDocument();
	});

	it("masks deployment errors", async () => {
		previewMocks.mutationError = new Error(
			"Private deployment failure for Private Preview Format at http://private-radarr:7878",
		);

		render(
			<DeploymentPreviewModal
				open={true}
				onClose={vi.fn()}
				templateId="template-1"
				instanceId="instance-1"
			/>,
			{ wrapper: Wrapper },
		);

		await waitFor(() => {
			expect(
				screen.getByText("Deployment failed; details hidden in incognito mode."),
			).toBeInTheDocument();
		});
		expect(screen.queryByText(/private-radarr/)).not.toBeInTheDocument();
	});

	it("preserves safe partial-deployment recovery details", async () => {
		previewMocks.mutationError = new ApiError(
			"Private deployment conflict at http://private-radarr:7878",
			409,
			{
				details: {
					partialDeployment: {
						created: 1,
						updated: 1,
						skipped: 0,
						details: {
							created: ["Private Created Format"],
							updated: ["Private Updated Format"],
							failed: [],
						},
						qualityProfile: {
							action: "updated",
							profileId: 7,
							profileName: "Private Profile",
						},
					},
				},
			},
		);

		render(
			<DeploymentPreviewModal
				open={true}
				onClose={vi.fn()}
				templateId="template-1"
				instanceId="instance-1"
			/>,
			{ wrapper: Wrapper },
		);

		await waitFor(() => {
			expect(
				screen.getByText(
					"Deployment changed during execution; details hidden in incognito mode. 3 deployment changes had already been applied. Refresh the preview before taking another action.",
				),
			).toBeInTheDocument();
		});
		expect(screen.queryByText(/Private Profile/)).not.toBeInTheDocument();
		expect(screen.queryByText(/private-radarr/)).not.toBeInTheDocument();
	});

	it("preserves operational preview details when incognito mode is disabled", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "false");

		render(
			<DeploymentPreviewModal
				open={true}
				onClose={vi.fn()}
				templateId="template-1"
				templateName="Private Template"
				instanceId="instance-1"
				instanceLabel="Private Radarr"
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.getByText(/Private Template/)).toBeInTheDocument();
		expect(screen.getByText(/Private Radarr/)).toBeInTheDocument();
		expect(screen.getByText("Private Preview Format")).toBeInTheDocument();
		expect(screen.getByText("Private Orphaned Format")).toBeInTheDocument();
		expect(screen.getByText("Private Unmatched Format")).toBeInTheDocument();
		expect(screen.getByText("Private match reason")).toBeInTheDocument();
		expect(screen.getByText("Preview includes Private Preview Format")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "View differences" }));
		expect(screen.getByText("Private Template Value")).toBeInTheDocument();
		expect(screen.getByText("Private Instance Value")).toBeInTheDocument();
	});
});
