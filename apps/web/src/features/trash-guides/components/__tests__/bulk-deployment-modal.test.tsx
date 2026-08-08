import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { getLinuxInstanceName } from "../../../../lib/incognito";

const previewMocks = vi.hoisted(() => ({
	results: [] as Array<Record<string, unknown>>,
	mutate: vi.fn(),
}));

vi.mock("../../../../hooks/api/useDeploymentPreview", () => ({
	useBulkDeploymentPreviews: () => ({
		results: previewMocks.results,
		isLoading: false,
	}),
	useExecuteBulkDeployment: () => ({
		mutate: previewMocks.mutate,
		reset: vi.fn(),
		isPending: false,
		isSuccess: false,
		isError: false,
		data: undefined,
		error: null,
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#334155", to: "#475569", glow: "#334155" },
	}),
}));

import { BulkDeploymentModal } from "../bulk-deployment-modal";

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
}

describe("BulkDeploymentModal incognito labels", () => {
	beforeEach(() => {
		previewMocks.results = [
			{
				instanceId: "instance-secret",
				isLoading: false,
				error: null,
				data: {
					data: {
						instanceReachable: true,
						canDeploy: true,
						executionToken: "token",
						summary: {
							totalItems: 1,
							newCustomFormats: 1,
							updatedCustomFormats: 0,
							totalConflicts: 0,
						},
					},
				},
			},
		];
		previewMocks.mutate.mockReset();
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
	});

	it("masks instance labels in the selection list", async () => {
		render(
			<BulkDeploymentModal
				open={true}
				onClose={vi.fn()}
				templateId="template-1"
				instances={[
					{
						instanceId: "instance-secret",
						instanceLabel: "Secret Radarr",
						instanceType: "RADARR",
					},
				]}
			/>,
			{ wrapper: Wrapper },
		);

		await waitFor(() => {
			expect(screen.getByText(getLinuxInstanceName("instance-secret"))).toBeInTheDocument();
		});
		expect(screen.queryByText("Secret Radarr")).not.toBeInTheDocument();
	});

	it("does not deploy when any selected instance is unavailable", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
		previewMocks.results = [
			...previewMocks.results,
			{
				instanceId: "instance-offline",
				isLoading: false,
				error: null,
				data: {
					data: {
						instanceReachable: false,
						canDeploy: false,
						executionToken: "offline-token",
						summary: {
							totalItems: 0,
							newCustomFormats: 0,
							updatedCustomFormats: 0,
							totalConflicts: 0,
						},
					},
				},
			},
		];
		render(
			<BulkDeploymentModal
				open={true}
				onClose={vi.fn()}
				templateId="template-1"
				instances={[
					{
						instanceId: "instance-secret",
						instanceLabel: "Online Radarr",
						instanceType: "RADARR",
					},
					{
						instanceId: "instance-offline",
						instanceLabel: "Offline Radarr",
						instanceType: "RADARR",
					},
				]}
			/>,
			{ wrapper: Wrapper },
		);

		const deployButton = await screen.findByRole("button", { name: /Deploy to 2 Instances$/ });
		expect(deployButton).toBeDisabled();
		fireEvent.click(deployButton);
		expect(previewMocks.mutate).not.toHaveBeenCalled();
		expect(
			screen.getByText("Some instances have conflicts or are unreachable"),
		).toBeInTheDocument();
	});
});
