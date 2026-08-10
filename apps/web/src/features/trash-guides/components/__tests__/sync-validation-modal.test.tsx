import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

const validation = vi.hoisted(() => ({
	valid: true,
	conflicts: [
		{
			configName: "Private Legacy Conflict",
			existingId: 42,
			action: "REPLACE" as const,
			reason: "Private legacy conflict reason",
		},
	],
	errors: [] as string[],
	warnings: [] as string[],
	executionToken: "a".repeat(64),
	preview: {
		templateId: "template-1",
		templateName: "Private Movie Profile",
		instanceId: "instance-1",
		instanceLabel: "Private Radarr",
		instanceServiceType: "RADARR" as const,
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
				action: "create" as const,
				defaultScore: 1000,
				scoreOverride: 1000,
				templateData: {},
				instanceData: {},
				conflicts: [],
				hasConflicts: false,
			},
			{
				trashId: "format-1",
				name: "Secret HDR",
				action: "update" as const,
				defaultScore: 500,
				scoreOverride: 500,
				templateData: {},
				instanceData: {},
				conflicts: [
					{
						cfTrashId: "format-1",
						conflictType: "name",
						templateValue: "Private Template Value",
						instanceValue: "Private Instance Value",
					},
				],
				hasConflicts: true,
			},
			{
				trashId: "format-2",
				name: "Secret Family Profile",
				action: "skip" as const,
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
		canDeploy: true,
		requiresConflictResolution: true,
		instanceReachable: true,
		executionToken: "a".repeat(64),
		namingChanges: ["privateMovieFolderFormat"],
		warnings: ["Private legacy mapping will be rebound during execution."],
	},
}));

const hookState = vi.hoisted(() => ({
	mode: "success" as "success" | "error" | "silent",
	callbackInvoked: vi.fn(),
	error: new Error("Private validation error at http://private-radarr:7878"),
}));

vi.mock("../../../../hooks/api/useSync", () => ({
	useValidateSync: (options: {
		onSuccess?: (data: typeof validation) => void;
		onError?: (error: Error) => void;
	}) => ({
		mutate: (_request: unknown, callbacks?: { onSuccess?: (data: typeof validation) => void }) => {
			if (hookState.mode === "error") {
				hookState.callbackInvoked("error");
				options.onError?.(hookState.error);
				return;
			}
			if (hookState.mode === "silent") {
				validation.valid = false;
				validation.errors.length = 0;
				hookState.callbackInvoked("silent");
			}
			options.onSuccess?.(validation);
			callbacks?.onSuccess?.(validation);
		},
		isPending: false,
		isError: hookState.mode === "error",
		isSuccess: hookState.mode !== "error",
		error: hookState.mode === "error" ? hookState.error : null,
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

function renderModal() {
	return render(
		<IncognitoProvider>
			<SyncValidationModal
				templateId="template-1"
				templateName="Private Movie Profile"
				instanceId="instance-1"
				instanceName="Private Radarr"
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>
		</IncognitoProvider>,
	);
}

describe("SyncValidationModal deployment plan", () => {
	beforeEach(() => {
		localStorage.setItem("arr-dashboard-incognito-mode", "false");
		hookState.mode = "success";
		hookState.callbackInvoked.mockClear();
		validation.valid = true;
		validation.errors.length = 0;
		validation.warnings.length = 0;
	});

	it("shows the complete upstream plan authorized by the execution token", async () => {
		const onConfirm = vi.fn();
		render(
			<IncognitoProvider>
				<SyncValidationModal
					templateId="template-1"
					templateName="Private Movie Profile"
					instanceId="instance-1"
					instanceName="Private Radarr"
					onConfirm={onConfirm}
					onCancel={vi.fn()}
				/>
			</IncognitoProvider>,
		);

		await waitFor(() => expect(screen.getByText("Deployment plan")).toBeInTheDocument());
		expect(screen.getByText(/1 create, 1 update, 1 score reset, 1 unchanged/)).toBeInTheDocument();
		expect(screen.getByText("Secret New Format")).toBeInTheDocument();
		expect(screen.getByText("Create")).toBeInTheDocument();
		expect(screen.getByText("Secret HDR")).toBeInTheDocument();
		expect(screen.getByText("Update")).toBeInTheDocument();
		expect(screen.getByText("Score: 500")).toBeInTheDocument();
		expect(screen.getByText("Secret Family Profile")).toBeInTheDocument();
		expect(screen.getAllByText("Skip").length).toBeGreaterThan(0);
		expect(screen.getByText("Private Old Format")).toBeInTheDocument();
		expect(screen.getByText("100 → 0")).toBeInTheDocument();
		expect(screen.getByText("Private Unknown Format")).toBeInTheDocument();
		expect(screen.getByText("Private match reason")).toBeInTheDocument();
		expect(screen.getByText("privateMovieFolderFormat")).toBeInTheDocument();
		expect(screen.getByText(/Private legacy mapping will be rebound/)).toBeInTheDocument();
		expect(screen.getByText("Private Legacy Conflict")).toBeInTheDocument();
		expect(screen.getByText("Private legacy conflict reason")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Use template version of Secret HDR" }));
		fireEvent.click(
			screen.getByRole("button", {
				name: "Replace Private Legacy Conflict with template version",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Proceed with Resolutions" }));
		expect(onConfirm).toHaveBeenCalledWith("a".repeat(64), {
			"format-1": "REPLACE",
			"Private Legacy Conflict": "REPLACE",
		});
	});

	it("masks every name-bearing deployment-plan field in incognito mode", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		validation.warnings.push("Missing Custom Formats at http://private-radarr:7878");
		renderModal();

		await waitFor(() => expect(screen.getByText("Deployment plan")).toBeInTheDocument());
		expect(screen.getByText("TRaSH template")).toBeInTheDocument();
		expect(screen.getByText("Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Custom Format 2")).toBeInTheDocument();
		expect(screen.getByText("Custom Format 3")).toBeInTheDocument();
		expect(screen.getByText("Orphaned Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Unmatched Custom Format 1")).toBeInTheDocument();
		expect(screen.getByText("Naming setting 1")).toBeInTheDocument();
		expect(screen.getByText("Custom Format conflict 1")).toBeInTheDocument();
		expect(
			screen.getAllByText("Conflict details hidden in incognito mode.").length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText(/Deployment warnings hidden in incognito mode\./).length,
		).toBeGreaterThan(0);

		for (const sensitiveText of [
			"Private Movie Profile",
			"Secret New Format",
			"Secret HDR",
			"Secret Family Profile",
			"Private Template Value",
			"Private Instance Value",
			"Private Old Format",
			"Private Unknown Format",
			"Private match reason",
			"privateMovieFolderFormat",
			"Private legacy mapping will be rebound during execution.",
			"Private Legacy Conflict",
			"Private legacy conflict reason",
			"http://private-radarr:7878",
		]) {
			expect(document.body.innerHTML).not.toContain(sensitiveText);
		}
		expect(
			screen.queryByRole("button", {
				name: /Secret New Format|Secret HDR|Private Legacy Conflict/,
			}),
		).toBeNull();
	});

	it("masks validation errors in incognito mode", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		validation.valid = false;
		validation.errors.push("Private Radarr at http://private-radarr:7878 is unreachable");
		renderModal();

		await waitFor(() =>
			expect(screen.getByText(/Validation errors hidden in incognito mode\./)).toBeInTheDocument(),
		);
		expect(screen.queryByText(/Private Radarr|private-radarr/)).toBeNull();
	});

	it.each(["error", "silent"] as const)(
		"does not log raw %s callback payloads in incognito mode",
		async (mode) => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			hookState.mode = mode;
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

			try {
				renderModal();
				await waitFor(() => expect(hookState.callbackInvoked).toHaveBeenCalledWith(mode));
				const serializedLogs = JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls]);
				for (const sensitiveText of [
					"Private validation error",
					"private-radarr",
					"Private Legacy Conflict",
					"Secret New Format",
					"Secret HDR",
					"Private Movie Profile",
					"Private Radarr",
					"Private Template Value",
					"Private Instance Value",
				]) {
					expect(serializedLogs).not.toContain(sensitiveText);
				}
			} finally {
				errorSpy.mockRestore();
				warnSpy.mockRestore();
			}
		},
	);
});
