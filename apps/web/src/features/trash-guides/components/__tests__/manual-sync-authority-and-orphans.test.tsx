import type { DeploymentPreview } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncExecuteRequest } from "../../../../lib/api-client/trash-guides";
import { DeploymentPreviewModal } from "../deployment-preview-modal";
import { TemplateList } from "../template-list";

const executionToken = "a".repeat(64);

const hookMocks = vi.hoisted(() => ({
	executeSync: vi.fn(),
	useDeploymentPreview: vi.fn(),
	useExecuteDeployment: vi.fn(),
}));

const validationResult = {
	valid: true,
	conflicts: [],
	errors: [],
	warnings: [],
	executionToken,
	preview: {
		templateId: "template-1",
		templateName: "Test Template",
		instanceId: "instance-1",
		instanceLabel: "Test Instance",
		instanceServiceType: "RADARR" as const,
		executionToken,
		summary: {
			totalItems: 0,
			newCustomFormats: 0,
			updatedCustomFormats: 0,
			deletedCustomFormats: 0,
			skippedCustomFormats: 0,
			totalConflicts: 0,
			unresolvedConflicts: 0,
			unmatchedCustomFormats: 0,
			orphanedCustomFormats: 2,
		},
		customFormats: [],
		unmatchedCustomFormats: [],
		orphanedCustomFormats: [
			{ instanceId: 10, name: "Orphan One", score: 125 },
			{ instanceId: 11, name: "Orphan Two", score: -50 },
		],
		canDeploy: true,
		requiresConflictResolution: false,
		instanceReachable: true,
		warnings: [],
	},
};

vi.mock("../../../../hooks/api/useSync", () => ({
	useExecuteSync: () => ({ mutateAsync: hookMocks.executeSync }),
	useValidateSync: (options?: { onSuccess?: (data: typeof validationResult) => void }) => ({
		mutate: (
			_request: unknown,
			callbacks?: { onSuccess?: (data: typeof validationResult) => void },
		) => {
			options?.onSuccess?.(validationResult);
			callbacks?.onSuccess?.(validationResult);
		},
		isPending: false,
		isError: false,
		isSuccess: true,
		error: null,
		cancelRetry: vi.fn(),
	}),
}));

vi.mock("../../../../hooks/api/useDeploymentPreview", () => ({
	useDeploymentPreview: hookMocks.useDeploymentPreview,
	useExecuteDeployment: hookMocks.useExecuteDeployment,
	useUnlinkTemplateFromInstance: () => ({ mutate: vi.fn() }),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [] }),
}));

vi.mock("../../../../hooks/api/useTemplates", () => ({
	TEMPLATES_QUERY_KEY: ["trash-guides", "templates"],
	useDeleteTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDuplicateTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useTemplates: () => ({ data: { templates: [] }, isLoading: false, error: null }),
}));

vi.mock("../../../../hooks/api/useTemplateUpdates", () => ({
	useTemplateUpdates: () => ({ data: undefined }),
}));

vi.mock("../../hooks/use-template-list-modals", () => ({
	useTemplateListModals: () => [
		{
			deleteConfirm: null,
			duplicateName: "",
			duplicatingId: null,
			instanceSelectorTemplate: null,
			validationModal: {
				templateId: "template-1",
				templateName: "Test Template",
				instanceId: "instance-1",
				instanceName: "Test Instance",
			},
			progressModal: null,
			deploymentModal: null,
			exportModal: null,
			importModal: false,
			unlinkConfirm: null,
			bulkDeployModal: null,
		},
		vi.fn(),
	],
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#6366f1",
			to: "#8b5cf6",
			glow: "rgba(99, 102, 241, 0.3)",
			fromLight: "rgba(99, 102, 241, 0.1)",
			fromMedium: "rgba(99, 102, 241, 0.2)",
			fromMuted: "rgba(99, 102, 241, 0.3)",
		},
	}),
}));

vi.mock("../../../../lib/incognito", () => ({
	getLinuxInstanceName: (name: string) => name,
	useIncognitoMode: () => [false],
}));

function renderWithQueryClient(children: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

describe("manual sync authority", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hookMocks.executeSync.mockResolvedValue({ syncId: "sync-1" });
	});

	it("passes the exact validation token through the modal to sync execution", async () => {
		renderWithQueryClient(
			<TemplateList
				onCreateNew={vi.fn()}
				onEdit={vi.fn()}
				onImport={vi.fn()}
				onBrowseQualityProfiles={vi.fn()}
			/>,
		);

		const startSyncButton = await screen.findByRole("button", { name: "Start Sync" });
		await waitFor(() => expect(startSyncButton).toBeEnabled());
		fireEvent.click(startSyncButton);

		await waitFor(() =>
			expect(hookMocks.executeSync).toHaveBeenCalledWith({
				templateId: "template-1",
				instanceId: "instance-1",
				syncType: "MANUAL",
				executionToken,
				conflictResolutions: {},
			}),
		);
	});

	it("does not expose scheduled authority in the browser request type", () => {
		const manualRequest: SyncExecuteRequest = {
			templateId: "template-1",
			instanceId: "instance-1",
			syncType: "MANUAL",
			executionToken,
		};

		expect(manualRequest.syncType).toBe("MANUAL");

		// @ts-expect-error Browser callers cannot claim scheduler authority.
		const scheduledRequest: SyncExecuteRequest = { ...manualRequest, syncType: "SCHEDULED" };
		expect(scheduledRequest.syncType).toBe("SCHEDULED");
	});
});

describe("orphan review visibility", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows every orphan score reset in manual sync validation", async () => {
		renderWithQueryClient(
			<TemplateList
				onCreateNew={vi.fn()}
				onEdit={vi.fn()}
				onImport={vi.fn()}
				onBrowseQualityProfiles={vi.fn()}
			/>,
		);

		expect(await screen.findByText("Orphan One")).toBeInTheDocument();
		expect(screen.getByText("125 → 0")).toBeInTheDocument();
		expect(screen.getByText("Orphan Two")).toBeInTheDocument();
		expect(screen.getByText("-50 → 0")).toBeInTheDocument();
	});

	it("shows every orphan score reset in deployment preview", async () => {
		hookMocks.useDeploymentPreview.mockReturnValue({
			data: { success: true, data: validationResult.preview as DeploymentPreview },
			isLoading: false,
			error: null,
		});
		hookMocks.useExecuteDeployment.mockReturnValue({
			mutate: vi.fn(),
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

		expect(await screen.findByText("Orphan One")).toBeInTheDocument();
		expect(screen.getByText("125 → 0")).toBeInTheDocument();
		expect(screen.getByText("Orphan Two")).toBeInTheDocument();
		expect(screen.getByText("-50 → 0")).toBeInTheDocument();
		expect(screen.queryByText("Instance is up to date")).not.toBeInTheDocument();
	});
});
