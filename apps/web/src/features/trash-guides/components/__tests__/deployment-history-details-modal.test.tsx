import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { getLinuxInstanceName, getLinuxUsername } from "../../../../lib/incognito";

vi.mock("../../../../hooks/api/useDeploymentHistory", () => ({
	useDeploymentHistoryDetail: () => ({
		isLoading: false,
		error: null,
		data: {
			success: true,
			data: {
				id: "history-1",
				instanceId: "instance-secret",
				templateId: "template-1",
				userId: "user-1",
				deployedAt: "2026-08-08T12:00:00.000Z",
				deployedBy: "secret-admin",
				duration: 2,
				status: "PARTIAL_SUCCESS",
				appliedCFs: 1,
				failedCFs: 1,
				totalCFs: 2,
				conflictsCount: 0,
				canRollback: true,
				rolledBack: false,
				rolledBackAt: null,
				undeployStatus: "PARTIAL",
				undeployAttemptedAt: "2026-08-08T12:05:00.000Z",
				undeployProgress: [
					{
						key: "custom_format:7",
						kind: "custom_format",
						name: "Private rollback format",
						outcome: "failed",
						error: "Private rollback error",
					},
				],
				instance: {
					id: "instance-secret",
					label: "Secret Radarr",
					service: "RADARR",
				},
				template: {
					id: "template-1",
					name: "Private Template",
					description: "Private description",
					serviceType: "RADARR",
				},
				appliedConfigs: [{ name: "Private Custom Format", action: "created" }],
				failedConfigs: [{ name: "Failed Private Format", error: "Private upstream error" }],
				errors: "Private deployment error",
				warnings: "Private deployment warning",
			},
		},
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#334155", to: "#475569", glow: "#334155" },
	}),
}));

import { DeploymentHistoryDetailsModal } from "../deployment-history-details-modal";

function Wrapper({ children }: { children: ReactNode }) {
	return <IncognitoProvider>{children}</IncognitoProvider>;
}

describe("DeploymentHistoryDetailsModal incognito mode", () => {
	beforeEach(() => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
	});

	it("masks operator, instance, template, Custom Format, and error details", () => {
		render(<DeploymentHistoryDetailsModal historyId="history-1" onClose={vi.fn()} />, {
			wrapper: Wrapper,
		});

		expect(screen.getAllByText(getLinuxInstanceName("instance-secret"))).toHaveLength(2);
		expect(screen.getByText(getLinuxUsername("secret-admin"))).toBeInTheDocument();
		expect(screen.getByText("TRaSH template")).toBeInTheDocument();
		expect(screen.getByText("Deployment errors hidden in incognito mode.")).toBeInTheDocument();
		expect(screen.queryByText("Secret Radarr")).not.toBeInTheDocument();
		expect(screen.queryByText("Private Template")).not.toBeInTheDocument();
		expect(screen.queryByText("Private Custom Format")).not.toBeInTheDocument();
		expect(screen.queryByText("Private upstream error")).not.toBeInTheDocument();
		expect(screen.getByText("Partial undeploy")).toBeInTheDocument();
		expect(screen.queryByText("Private rollback error")).not.toBeInTheDocument();
	});

	it("shows durable undeploy status and retryable step failures", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
		render(<DeploymentHistoryDetailsModal historyId="history-1" onClose={vi.fn()} />, {
			wrapper: Wrapper,
		});

		expect(screen.getByText("Partial undeploy")).toBeInTheDocument();
		expect(screen.getByText("Private rollback format")).toBeInTheDocument();
		expect(screen.getByText("Private rollback error")).toBeInTheDocument();
	});
});
