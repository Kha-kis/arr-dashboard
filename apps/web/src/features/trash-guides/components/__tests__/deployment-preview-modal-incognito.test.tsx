import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeploymentPreview } from "@arr/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

const hookMocks = vi.hoisted(() => ({
	useDeploymentPreview: vi.fn(),
	useExecuteDeployment: vi.fn(),
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

import { DeploymentPreviewModal } from "../deployment-preview-modal";

const preview: DeploymentPreview = {
	templateId: "template-1",
	templateName: "Private Movie Profile",
	instanceId: "instance-1",
	instanceLabel: "Private Radarr",
	instanceServiceType: "RADARR",
	instanceVersion: "5.0.0",
	executionToken: "b".repeat(64),
	summary: {
		totalItems: 3,
		newCustomFormats: 1,
		updatedCustomFormats: 1,
		deletedCustomFormats: 0,
		skippedCustomFormats: 1,
		totalConflicts: 1,
		unresolvedConflicts: 1,
		unmatchedCustomFormats: 1,
		orphanedCustomFormats: 1,
	},
	customFormats: [
		{
			trashId: "format-new",
			name: "Secret New Format",
			action: "create",
			defaultScore: 1000,
			scoreOverride: 1000,
			templateData: {},
			conflicts: [],
			hasConflicts: false,
		},
		{
			trashId: "format-update",
			name: "Secret HDR",
			action: "update",
			defaultScore: 500,
			scoreOverride: 500,
			templateData: {},
			instanceData: {},
			conflicts: [
				{
					cfTrashId: "format-update",
					cfName: "Secret HDR",
					conflictType: "name_conflict",
					templateValue: "Private Template Value",
					instanceValue: "Private Instance Value",
					suggestedResolution: "use_template",
				},
			],
			hasConflicts: true,
		},
		{
			trashId: "format-skip",
			name: "Secret Family Profile",
			action: "skip",
			defaultScore: 25,
			scoreOverride: 25,
			templateData: {},
			instanceData: {},
			conflicts: [],
			hasConflicts: false,
		},
	],
	unmatchedCustomFormats: [
		{ instanceId: 8, name: "Private Unknown Format", reason: "Private match reason" },
	],
	orphanedCustomFormats: [{ instanceId: 7, name: "Private Old Format", score: 100 }],
	namingChanges: ["privateMovieFolderFormat"],
	canDeploy: true,
	requiresConflictResolution: true,
	instanceReachable: true,
	warnings: ["Private warning at http://private-radarr:7878"],
};

function renderWithProviders(children: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>,
	);
}

describe("DeploymentPreviewModal privacy boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
		hookMocks.useDeploymentPreview.mockReturnValue({
			data: { success: true, data: preview },
			isLoading: false,
			error: null,
		});
		hookMocks.useExecuteDeployment.mockReturnValue({
			mutate: vi.fn(),
			isError: false,
			isPending: false,
			data: undefined,
			error: null,
		});
	});

	it("shows every action in the reachable deployment plan", async () => {
		renderWithProviders(
			<DeploymentPreviewModal
				open
				onClose={vi.fn()}
				templateId="template-1"
				templateName="Private Movie Profile"
				instanceId="instance-1"
				instanceLabel="Private Radarr"
			/>,
		);

		expect(await screen.findByText("Deployment Summary")).toBeInTheDocument();
		expect(screen.getByText("Secret New Format")).toBeInTheDocument();
		expect(screen.getByText("Secret HDR")).toBeInTheDocument();
		expect(screen.getByText("Secret Family Profile")).toBeInTheDocument();
		expect(screen.getByText("Private Unknown Format")).toBeInTheDocument();
		expect(screen.getByText("Private match reason")).toBeInTheDocument();
		expect(screen.getByText("Private Old Format")).toBeInTheDocument();
		expect(screen.getByText("100 → 0")).toBeInTheDocument();
		expect(screen.getByText("Naming Changes (1)")).toBeInTheDocument();
		expect(screen.getByText("privateMovieFolderFormat")).toBeInTheDocument();
		expect(screen.getByText(/Private warning at/)).toBeInTheDocument();
	});

	it("masks the reachable plan without changing execution authority", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const mutate = vi.fn();
		hookMocks.useExecuteDeployment.mockReturnValue({
			mutate,
			isError: true,
			isPending: false,
			data: undefined,
			error: new Error("Private deployment error at http://private-radarr:7878"),
		});

		renderWithProviders(
			<DeploymentPreviewModal
				open
				onClose={vi.fn()}
				templateId="template-1"
				templateName="Private Movie Profile"
				instanceId="instance-1"
				instanceLabel="Private Radarr"
			/>,
		);

		expect(await screen.findByText(/TRaSH template/)).toBeInTheDocument();
		expect(screen.getByText(/Radarr 4K.*RADARR/)).toBeInTheDocument();
		expect(screen.getByText("Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Custom Format 2")).toBeInTheDocument();
		expect(screen.getByText("Custom Format 3")).toBeInTheDocument();
		expect(screen.getByText("Unmatched Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Orphaned Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Naming setting 1")).toBeInTheDocument();
		expect(screen.getByText("Deployment warnings hidden in incognito mode.")).toBeInTheDocument();
		expect(
			screen.getByText("Deployment error details hidden in incognito mode."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Instance Overrides" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "View differences" }));
		expect(
			screen.getAllByText("Conflict details hidden in incognito mode.").length,
		).toBeGreaterThan(0);
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "keep_existing" } });
		fireEvent.click(screen.getByRole("button", { name: "Deploy to Instance" }));
		expect(mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				templateId: "template-1",
				instanceId: "instance-1",
				executionToken: "b".repeat(64),
				conflictResolutions: { "format-update": "keep_existing" },
			}),
			expect.any(Object),
		);

		for (const sensitiveText of [
			"Private Movie Profile",
			"Private Radarr",
			"Secret New Format",
			"Secret HDR",
			"Secret Family Profile",
			"Private Template Value",
			"Private Instance Value",
			"Private Unknown Format",
			"Private match reason",
			"Private Old Format",
			"privateMovieFolderFormat",
			"Private warning",
			"Private deployment error",
			"private-radarr",
		]) {
			expect(document.body.innerHTML).not.toContain(sensitiveText);
		}
	});

	it("keeps a naming-only reviewed preview deployable", async () => {
		const mutate = vi.fn();
		hookMocks.useDeploymentPreview.mockReturnValue({
			data: {
				success: true,
				data: {
					...preview,
					summary: {
						...preview.summary,
						totalItems: 0,
						newCustomFormats: 0,
						updatedCustomFormats: 0,
						skippedCustomFormats: 0,
						totalConflicts: 0,
						unresolvedConflicts: 0,
						unmatchedCustomFormats: 0,
						orphanedCustomFormats: 0,
					},
					customFormats: [],
					unmatchedCustomFormats: [],
					orphanedCustomFormats: [],
					warnings: [],
					namingChanges: ["privateMovieFolderFormat"],
					requiresConflictResolution: false,
				},
			},
			isLoading: false,
			error: null,
		});
		hookMocks.useExecuteDeployment.mockReturnValue({
			mutate,
			isError: false,
			isPending: false,
			data: undefined,
			error: null,
		});

		renderWithProviders(
			<DeploymentPreviewModal
				open
				onClose={vi.fn()}
				templateId="template-1"
				templateName="Private Movie Profile"
				instanceId="instance-1"
				instanceLabel="Private Radarr"
			/>,
		);

		const deployButton = await screen.findByRole("button", { name: "Deploy to Instance" });
		expect(screen.queryByText("Instance is up to date")).toBeNull();
		expect(deployButton).toBeEnabled();
		fireEvent.click(deployButton);
		expect(mutate).toHaveBeenCalledWith(
			expect.objectContaining({ executionToken: "b".repeat(64) }),
			expect.any(Object),
		);
	});
});
