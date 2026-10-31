import type { DeploymentPreview } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DeploymentPreviewModal } from "../deployment-preview-modal";

const clients: QueryClient[] = [];
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function preview(overrides: Partial<DeploymentPreview> = {}): DeploymentPreview {
	return {
		templateId: "template-a",
		templateName: "Reviewed template",
		instanceId: "radarr-a",
		instanceLabel: "Radarr A",
		instanceServiceType: "RADARR",
		executionToken: "1111111111111111111111111111111111111111111111111111111111111111",
		summary: {
			totalItems: 1,
			newCustomFormats: 0,
			updatedCustomFormats: 1,
			deletedCustomFormats: 0,
			skippedCustomFormats: 0,
			totalConflicts: 1,
			unresolvedConflicts: 0,
			unmatchedCustomFormats: 0,
			orphanedCustomFormats: 0,
		},
		customFormats: [
			{
				trashId: "cf-a",
				name: "Reviewed format",
				action: "update",
				defaultScore: 100,
				scoreOverride: 100,
				templateData: { name: "Reviewed format", specifications: [] },
				instanceData: { id: 9, name: "Reviewed format", specifications: [] },
				hasConflicts: true,
				conflicts: [
					{
						cfTrashId: "cf-a",
						cfName: "Reviewed format",
						conflictType: "score_mismatch",
						templateValue: 100,
						instanceValue: 50,
						suggestedResolution: "use_template",
					},
				],
			},
		],
		unmatchedCustomFormats: [],
		orphanedCustomFormats: [],
		namingChanges: [],
		canDeploy: true,
		requiresConflictResolution: false,
		instanceReachable: true,
		instanceVersion: "5.0.0",
		warnings: [],
		...overrides,
	};
}
function result(status: "SUCCESS" | "FAILED" | "UNCERTAIN") {
	return {
		success: status === "SUCCESS",
		result: {
			instanceId: "radarr-a",
			instanceLabel: "Radarr A",
			success: status === "SUCCESS",
			status,
			customFormatsCreated: 0,
			customFormatsUpdated: status === "SUCCESS" ? 1 : 0,
			customFormatsSkipped: 0,
			errors: status === "SUCCESS" ? [] : ["Review the upstream result before retrying"],
			details: {
				created: [],
				updated: status === "SUCCESS" ? ["cf-a"] : [],
				failed: status === "SUCCESS" ? [] : ["cf-a"],
			},
		},
	};
}
function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	clients.push(client);
	const onClose = vi.fn(),
		onDeploySuccess = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<DeploymentPreviewModal
						open
						templateId="template-a"
						instanceId="radarr-a"
						onClose={onClose}
						onDeploySuccess={onDeploySuccess}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { client, onClose, onDeploySuccess };
}
afterEach(async () => {
	cleanup();
	await Promise.all(clients.map((c) => c.cancelQueries()));
	clients.splice(0).forEach((c) => {
		c.clear();
	});
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("single deployment rendered transport", () => {
	it("posts the reviewed token and user choices once while pending, then completes verified success", async () => {
		let release!: (r: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const executions: RequestInit[] = [];
		const previews: RequestInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url === "/api/trash-guides/deployment/preview") {
					previews.push(init);
					return response({ success: true, data: preview() });
				}
				if (url === "/api/trash-guides/deployment/execute") {
					executions.push(init);
					return pending;
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const { onClose, onDeploySuccess } = mount();
		try {
			await screen.findByText("Reviewed format");
			fireEvent.click(screen.getByRole("button", { name: /Auto-sync/ }));
			fireEvent.change(screen.getByRole("combobox"), { target: { value: "keep_existing" } });
			fireEvent.click(screen.getByRole("button", { name: "Deploy to Instance" }));
			await waitFor(() => expect(executions).toHaveLength(1));
			expect(previews[0]).toMatchObject({
				method: "POST",
				credentials: "include",
				body: '{"templateId":"template-a","instanceId":"radarr-a"}',
			});
			expect(JSON.parse(String(executions[0]?.body))).toEqual({
				templateId: "template-a",
				instanceId: "radarr-a",
				executionToken: "1111111111111111111111111111111111111111111111111111111111111111",
				syncStrategy: "auto",
				conflictResolutions: { "cf-a": "keep_existing" },
			});
			expect(screen.getByRole("button", { name: "Deploying..." })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: "Deploying..." }));
			expect(executions).toHaveLength(1);
			expect(onClose).not.toHaveBeenCalled();
			await act(async () => {
				release(response(result("SUCCESS")));
				await pending;
			});
			await waitFor(() => expect(onDeploySuccess).toHaveBeenCalledTimes(1));
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => {
				release(response(result("SUCCESS")));
				await pending;
			});
		}
	});
	it.each([
		{ canDeploy: false, instanceReachable: true },
		{ canDeploy: false, instanceReachable: false },
	])("does not submit a blocked preview %j", async (blocked) => {
		const executions: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/preview")) return response({ success: true, data: preview(blocked) });
				executions.push(url);
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		mount();
		await screen.findByText("Reviewed format");
		const deploy = screen.getByRole("button", { name: "Deploy to Instance" });
		expect(deploy).toBeDisabled();
		fireEvent.click(deploy);
		expect(executions).toEqual([]);
	});
	it("shows an unavailable preview and cannot submit", async () => {
		const requests: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				requests.push(url);
				return response({ message: "Instance unavailable" }, 503);
			}),
		);
		mount();
		await screen.findByText("Failed to load deployment preview");
		expect(screen.getByRole("button", { name: "Deploy to Instance" })).toBeDisabled();
		expect(requests).toEqual(["/api/trash-guides/deployment/preview"]);
	});
	it("refetches after rejected execution and uses the new token on the next deliberate submission", async () => {
		let previews = 0;
		const executions: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url.endsWith("/preview")) {
					previews++;
					return response({
						success: true,
						data: preview({
							executionToken:
								previews === 1
									? "1111111111111111111111111111111111111111111111111111111111111111"
									: "2222222222222222222222222222222222222222222222222222222222222222",
						}),
					});
				}
				if (url.endsWith("/execute")) {
					executions.push(JSON.parse(String(init.body)));
					return executions.length === 1
						? response({ message: "Preview expired; review again" }, 409)
						: response(result("SUCCESS"));
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const { onClose, onDeploySuccess, client } = mount();
		await screen.findByText("Reviewed format");
		fireEvent.click(screen.getByRole("button", { name: "Deploy to Instance" }));
		await screen.findByText("Preview expired; review again");
		await waitFor(() => expect(previews).toBe(2));
		await waitFor(() => expect(client.isFetching()).toBe(0));
		expect(executions).toHaveLength(1);
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Deploy to Instance" }));
		await waitFor(() => expect(onDeploySuccess).toHaveBeenCalledTimes(1));
		expect(executions).toEqual([
			{
				templateId: "template-a",
				instanceId: "radarr-a",
				executionToken: "1111111111111111111111111111111111111111111111111111111111111111",
				syncStrategy: "notify",
				conflictResolutions: { "cf-a": "use_template" },
			},
			{
				templateId: "template-a",
				instanceId: "radarr-a",
				executionToken: "2222222222222222222222222222222222222222222222222222222222222222",
				syncStrategy: "notify",
				conflictResolutions: { "cf-a": "use_template" },
			},
		]);
	});
	it.each(["FAILED", "UNCERTAIN"] as const)(
		"keeps HTTP 200 %s in visible failure/review state without completing",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) => {
					if (url.endsWith("/preview")) return response({ success: true, data: preview() });
					if (url.endsWith("/execute")) return response(result(status));
					throw new Error(`Unexpected request ${url}`);
				}),
			);
			const { onClose, onDeploySuccess } = mount();
			await screen.findByText("Reviewed format");
			fireEvent.click(screen.getByRole("button", { name: "Deploy to Instance" }));
			await screen.findByText(
				status === "UNCERTAIN" ? "Deployment Result Needs Review" : "Deployment Failed",
			);
			expect(screen.getByText("Review the upstream result before retrying")).toBeVisible();
			expect(onClose).not.toHaveBeenCalled();
			expect(onDeploySuccess).not.toHaveBeenCalled();
		},
	);
});
