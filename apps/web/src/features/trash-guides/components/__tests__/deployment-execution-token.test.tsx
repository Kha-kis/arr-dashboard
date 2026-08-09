import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeploymentPreview } from "@arr/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BulkDeploymentModal } from "../bulk-deployment-modal";
import { DeploymentPreviewModal } from "../deployment-preview-modal";

const hookMocks = vi.hoisted(() => ({
	useDeploymentPreview: vi.fn(),
	useExecuteDeployment: vi.fn(),
	useBulkDeploymentPreviews: vi.fn(),
	useExecuteBulkDeployment: vi.fn(),
}));

vi.mock("../../../../hooks/api/useDeploymentPreview", () => hookMocks);

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#6366f1",
			to: "#8b5cf6",
			glow: "rgba(99, 102, 241, 0.3)",
			fromLight: "rgba(99, 102, 241, 0.1)",
			fromMuted: "rgba(99, 102, 241, 0.3)",
		},
	}),
}));

const makePreview = (instanceId: string, executionToken: string): DeploymentPreview => ({
	templateId: "template-1",
	templateName: "Test Template",
	instanceId,
	instanceLabel: `Instance ${instanceId}`,
	instanceServiceType: "RADARR" as const,
	executionToken,
	summary: {
		totalItems: 1,
		newCustomFormats: 1,
		updatedCustomFormats: 0,
		deletedCustomFormats: 0,
		skippedCustomFormats: 0,
		totalConflicts: 0,
		unresolvedConflicts: 0,
		unmatchedCustomFormats: 0,
		orphanedCustomFormats: 0,
	},
	customFormats: [],
	unmatchedCustomFormats: [],
	orphanedCustomFormats: [],
	canDeploy: true,
	requiresConflictResolution: false,
	instanceReachable: true,
	warnings: [],
});

const renderWithQueryClient = (children: ReactNode) => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
};

describe("deployment execution tokens", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("passes the exact preview token to single-instance execution", async () => {
		const executionToken = "a".repeat(64);
		const mutate = vi.fn();
		hookMocks.useDeploymentPreview.mockReturnValue({
			data: { success: true, data: makePreview("instance-1", executionToken) },
			isLoading: false,
			error: null,
		});
		hookMocks.useExecuteDeployment.mockReturnValue({
			mutate,
			isError: false,
			isPending: false,
			data: undefined,
		});

		renderWithQueryClient(
			<DeploymentPreviewModal
				open
				onClose={vi.fn()}
				templateId="template-1"
				instanceId="instance-1"
			/>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "Deploy to Instance" }));

		expect(mutate).toHaveBeenCalledWith(
			expect.objectContaining({ executionToken }),
			expect.any(Object),
		);
	});

	it("passes each selected instance's exact preview token to bulk execution", async () => {
		const executionTokens = {
			"instance-1": "b".repeat(64),
			"instance-2": "c".repeat(64),
		};
		const mutate = vi.fn();
		hookMocks.useBulkDeploymentPreviews.mockReturnValue({
			results: Object.entries(executionTokens).map(([instanceId, executionToken]) => ({
				instanceId,
				isLoading: false,
				isError: false,
				error: null,
				data: { success: true, data: makePreview(instanceId, executionToken) },
			})),
			isLoading: false,
			hasErrors: false,
		});
		hookMocks.useExecuteBulkDeployment.mockReturnValue({
			mutate,
			reset: vi.fn(),
			isError: false,
			isPending: false,
			isSuccess: false,
			data: undefined,
		});

		renderWithQueryClient(
			<BulkDeploymentModal
				open
				onClose={vi.fn()}
				templateId="template-1"
				instances={[
					{ instanceId: "instance-1", instanceLabel: "One", instanceType: "RADARR" },
					{ instanceId: "instance-2", instanceLabel: "Two", instanceType: "RADARR" },
				]}
			/>,
		);

		const deployButton = await screen.findByRole("button", { name: "Deploy to 2 Instances" });
		await waitFor(() => expect(deployButton).toBeEnabled());
		fireEvent.click(deployButton);

		expect(mutate).toHaveBeenCalledWith(
			expect.objectContaining({ executionTokens }),
			expect.any(Object),
		);
	});
});
