import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SyncProgressModal } from "../sync-progress-modal";

vi.mock("../../../../hooks/api/useSync", () => ({
	useSyncProgress: () => ({
		progress: {
			syncId: "sync-1",
			status: "UNCERTAIN",
			currentStep: "Sync result is uncertain; resolve or roll back before retrying",
			progress: 100,
			totalConfigs: 1,
			appliedConfigs: 0,
			failedConfigs: 0,
			errors: [
				{
					configName: "Naming configuration",
					error: "ARR may have applied the naming change",
					retryable: true,
				},
			],
		},
		error: null,
		isLoading: false,
		isPolling: false,
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#6366f1", to: "#8b5cf6" },
	}),
}));

vi.mock("../../../../lib/incognito", () => ({
	getLinuxInstanceName: (name: string) => name,
	useIncognitoMode: () => [false],
}));

describe("SyncProgressModal", () => {
	it("renders uncertainty as a terminal needs-review state", () => {
		render(
			<SyncProgressModal
				syncId="sync-1"
				templateName="Any"
				instanceName="Radarr"
				onComplete={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByText("Needs Review")).toBeInTheDocument();
		expect(screen.getByText("Result could not be verified")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
		expect(screen.queryByText("Sync in progress...")).not.toBeInTheDocument();
	});
});
