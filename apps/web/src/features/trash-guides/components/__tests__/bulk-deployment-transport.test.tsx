import type { DeploymentPreview } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BulkDeploymentModal } from "../bulk-deployment-modal";

let client: QueryClient;
const instances = ["a", "b", "blocked", "excluded"].map((id) => ({
	instanceId: id,
	instanceLabel: `Instance ${id}`,
	instanceType: "RADARR",
}));
function response(body: unknown) {
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
function preview(instanceId: string): DeploymentPreview {
	return {
		templateId: "template-a",
		templateName: "Bulk template",
		instanceId,
		instanceLabel: `Instance ${instanceId}`,
		instanceServiceType: "RADARR",
		executionToken:
			instanceId === "a"
				? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
		customFormats: [
			{
				trashId: "cf-a",
				name: "Format A",
				action: "create",
				defaultScore: 100,
				scoreOverride: 100,
				templateData: { name: "Format A", specifications: [] },
				hasConflicts: false,
				conflicts: [],
			},
		],
		unmatchedCustomFormats: [],
		orphanedCustomFormats: [],
		namingChanges: [],
		canDeploy: instanceId !== "blocked",
		requiresConflictResolution: false,
		instanceReachable: instanceId !== "blocked",
		warnings: [],
	};
}
afterEach(async () => {
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("bulk deployment rendered transport", () => {
	it("waits for authority, submits only selected deployable tokens and strategies, and preserves mixed outcomes without duplicate submission", async () => {
		let releasePreview!: (r: Response) => void, releaseExecute!: (r: Response) => void;
		const heldPreview = new Promise<Response>((resolve) => {
			releasePreview = resolve;
		});
		const heldExecute = new Promise<Response>((resolve) => {
			releaseExecute = resolve;
		});
		const executions: RequestInit[] = [];
		const previewIds: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				if (url === "/api/trash-guides/deployment/preview") {
					const { instanceId } = JSON.parse(String(init.body));
					previewIds.push(instanceId);
					return instanceId === "b" && previewIds.filter((id) => id === "b").length === 1
						? heldPreview
						: response({ success: true, data: preview(instanceId) });
				}
				if (url === "/api/trash-guides/deployment/execute-bulk") {
					executions.push(init);
					return heldExecute;
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const onClose = vi.fn(),
			onDeploySuccess = vi.fn();
		client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<BulkDeploymentModal
							open
							templateId="template-a"
							instances={instances}
							onClose={onClose}
							onDeploySuccess={onDeploySuccess}
						/>
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
		const outcome = {
			success: false,
			result: {
				templateId: "template-a",
				templateName: "Bulk template",
				totalInstances: 2,
				successfulInstances: 0,
				failedInstances: 1,
				uncertainInstances: 1,
				results: [
					{
						instanceId: "a",
						instanceLabel: "Instance a",
						success: false,
						status: "FAILED",
						customFormatsCreated: 0,
						customFormatsUpdated: 0,
						customFormatsSkipped: 0,
						errors: ["Rejected format"],
						details: { created: [], updated: [], failed: ["cf-a"] },
					},
					{
						instanceId: "b",
						instanceLabel: "Instance b",
						success: false,
						status: "UNCERTAIN",
						customFormatsCreated: 0,
						customFormatsUpdated: 0,
						customFormatsSkipped: 0,
						errors: ["Reconcile upstream state"],
						details: { created: [], updated: [], failed: ["cf-a"] },
					},
				],
			},
		};
		try {
			await waitFor(() => expect(previewIds).toHaveLength(4));
			expect(screen.getByRole("button", { name: "Loading Previews..." })).toBeDisabled();
			expect(executions).toEqual([]);
			await act(async () => {
				releasePreview(response({ success: true, data: preview("b") }));
				await heldPreview;
			});
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Deploy to 3 Instances" })).toBeEnabled(),
			);
			const excluded = screen.getByText("Instance excluded").parentElement!;
			fireEvent.click(within(excluded).getByRole("checkbox"));
			fireEvent.keyDown(
				within(screen.getByText("Instance a").parentElement!).getByRole("button", {
					name: "Notify",
				}),
				{ key: "ArrowDown" },
			);
			fireEvent.click(await screen.findByRole("menuitem", { name: "Manual" }));
			fireEvent.keyDown(
				within(screen.getByText("Instance b").parentElement!).getByRole("button", {
					name: "Notify",
				}),
				{ key: "ArrowDown" },
			);
			fireEvent.click(await screen.findByRole("menuitem", { name: "Auto-sync" }));
			fireEvent.click(screen.getByRole("button", { name: "Deploy to 2 Instances" }));
			await waitFor(() => expect(executions).toHaveLength(1));
			expect(executions[0]).toMatchObject({ method: "POST", credentials: "include" });
			expect(JSON.parse(String(executions[0]?.body))).toEqual({
				templateId: "template-a",
				instanceIds: ["a", "b"],
				executionTokens: {
					a: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					b: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				},
				instanceSyncStrategies: { a: "manual", b: "auto" },
			});
			expect(screen.getByRole("button", { name: /Deploying to 2 Instances/ })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: /Deploying to 2 Instances/ }));
			expect(executions).toHaveLength(1);
			await act(async () => {
				releaseExecute(response(outcome));
				await heldExecute;
			});
			await screen.findByText("Deployment Partially Failed");
			expect(screen.getByText("Deployment Result Uncertain")).toBeVisible();
			expect(screen.getByRole("button", { name: /Deploy/ })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: /Deploy/ }));
			expect(executions).toHaveLength(1);
			expect(onDeploySuccess).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		} finally {
			await act(async () => {
				releasePreview(response({ success: true, data: preview("b") }));
				releaseExecute(response(outcome));
				await Promise.all([heldPreview, heldExecute]);
			});
		}
	});
});
