import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

const validation = vi.hoisted(() => ({
	valid: true,
	conflicts: [],
	errors: [],
	warnings: [],
	executionToken: "a".repeat(64),
	preview: {
		templateId: "template-1",
		templateName: "Movie profile",
		instanceId: "instance-1",
		instanceLabel: "Radarr",
		instanceServiceType: "RADARR" as const,
		summary: {
			totalItems: 2,
			newCustomFormats: 0,
			updatedCustomFormats: 1,
			deletedCustomFormats: 0,
			skippedCustomFormats: 1,
			totalConflicts: 0,
			unresolvedConflicts: 0,
			unmatchedCustomFormats: 0,
			orphanedCustomFormats: 1,
		},
		customFormats: [
			{
				trashId: "format-1",
				name: "HDR",
				action: "update" as const,
				defaultScore: 500,
				scoreOverride: 500,
				templateData: {},
				instanceData: {},
				conflicts: [],
				hasConflicts: false,
			},
		],
		unmatchedCustomFormats: [],
		orphanedCustomFormats: [{ instanceId: 7, name: "Old format", score: 100 }],
		canDeploy: true,
		requiresConflictResolution: false,
		instanceReachable: true,
		executionToken: "a".repeat(64),
		namingChanges: ["movieFolderFormat"],
		warnings: ["A legacy mapping will be rebound during execution."],
	},
}));

vi.mock("../../../../hooks/api/useSync", () => ({
	useValidateSync: (options: { onSuccess?: (data: typeof validation) => void }) => ({
		mutate: (_request: unknown, callbacks?: { onSuccess?: (data: typeof validation) => void }) => {
			options.onSuccess?.(validation);
			callbacks?.onSuccess?.(validation);
		},
		isPending: false,
		isError: false,
		isSuccess: true,
		error: null,
		cancelRetry: vi.fn(),
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#334155",
			to: "#475569",
			glow: "#334155",
			fromLight: "#33415520",
			fromMuted: "#33415540",
		},
	}),
}));

import { SyncValidationModal } from "../sync-validation-modal";

describe("SyncValidationModal deployment plan", () => {
	beforeEach(() => {
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
	});

	it("shows every upstream action that the execution token authorizes", async () => {
		render(
			<IncognitoProvider>
				<SyncValidationModal
					templateId="template-1"
					templateName="Movie profile"
					instanceId="instance-1"
					instanceName="Radarr"
					onConfirm={vi.fn()}
					onCancel={vi.fn()}
				/>
			</IncognitoProvider>,
		);

		await waitFor(() => expect(screen.getByText("Deployment plan")).toBeInTheDocument());
		expect(screen.getByText("HDR")).toBeInTheDocument();
		expect(screen.getByText("Update to score 500")).toBeInTheDocument();
		expect(screen.getByText("Old format")).toBeInTheDocument();
		expect(screen.getByText("Reset score from 100 to 0")).toBeInTheDocument();
		expect(screen.getByText("Update naming: movieFolderFormat")).toBeInTheDocument();
		expect(
			screen.getByText(/A legacy mapping will be rebound during execution\./),
		).toBeInTheDocument();
	});
});
