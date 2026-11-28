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

const observed = vi.hoisted(() => ({ deploy: undefined as undefined | (() => void) }));
// Render through the REAL Button; retain its actual callback to test the handler
// independently of the browser/React disabled-button event suppression.
vi.mock("../../../../components/ui", async (importOriginal) => {
	const ui = await importOriginal<typeof import("../../../../components/ui")>();
	return {
		...ui,
		Button: (props: React.ComponentProps<typeof ui.Button>) => {
			if (props.children === "Deploy to Instance")
				observed.deploy = () => props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
			return <ui.Button {...props} />;
		},
	};
});
describe("reviewed preview authority while replacement settles", () => {
	it("blocks both DOM and actual handler during refetch/error, then sends only the replacement token", async () => {
		let release!: (value: Response) => void;
		const pending = new Promise<Response>((resolve) => (release = resolve));
		let previews = 0;
		const executions: Array<{ executionToken: string }> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			if (url.endsWith("/preview")) {
				previews++;
				if (previews === 2) return pending;
				return response({
					success: true,
					data: preview({ executionToken: previews === 1 ? "1".repeat(64) : "2".repeat(64) }),
				});
			}
			if (url.endsWith("/execute")) {
				executions.push(JSON.parse(String(init.body)));
				return response(result("SUCCESS"));
			}
			throw Error("Unexpected synthetic request");
		});
		const { client } = mount();
		let refresh: Promise<void> | undefined;
		try {
			await screen.findByText("Reviewed format");
			await act(async () => {
				refresh = client.invalidateQueries({
					queryKey: ["trash-guides", "deployment", "preview", "template-a", "radarr-a"],
				});
			});
			await waitFor(() => expect(client.isFetching()).toBe(1));
			expect.soft(screen.getByRole("button", { name: "Deploy to Instance" })).toBeDisabled();
			await act(async () => {
				(screen.getByRole("button", { name: "Deploy to Instance" }) as HTMLButtonElement).click();
				observed.deploy?.();
			});
			expect.soft(executions).toEqual([]);
			await act(async () => {
				release(response({ message: "Replacement unavailable" }, 503));
				await refresh;
			});
			await screen.findByText("Failed to load deployment preview");
			expect.soft(screen.getByRole("button", { name: "Deploy to Instance" })).toBeDisabled();
			await act(async () => {
				observed.deploy?.();
			});
			expect.soft(executions).toEqual([]);
			await act(async () => {
				await client.refetchQueries({
					queryKey: ["trash-guides", "deployment", "preview", "template-a", "radarr-a"],
				});
			});
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Deploy to Instance" })).toBeEnabled(),
			);
			fireEvent.click(screen.getByRole("button", { name: "Deploy to Instance" }));
			await waitFor(() => expect(executions).toHaveLength(1));
			expect(executions[0]?.executionToken).toBe("2".repeat(64));
		} finally {
			release(response({ success: true, data: preview() }));
			await refresh;
		}
	});
});
