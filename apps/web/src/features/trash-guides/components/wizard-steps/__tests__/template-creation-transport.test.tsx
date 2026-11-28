import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../../providers/color-theme-provider";
import { TemplateCreation } from "../template-creation";

let client: QueryClient;
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function state(): ComponentProps<typeof TemplateCreation>["wizardState"] {
	return {
		selectedProfile: {
			trashId: "profile-a",
			name: "Guide profile",
			description: "Guide description",
			customFormatCount: 3,
			qualityCount: 1,
			cutoff: "HDTV-720p",
			upgradeAllowed: true,
			language: "English",
		},
		templateName: "  My template  ",
		templateDescription: "  Reviewed description  ",
		customFormatSelections: {
			"cf-a": { selected: true, scoreOverride: 125, conditionsEnabled: { conditionA: false } },
			"cf-b": { selected: false, conditionsEnabled: {} },
			"manual-c": { selected: true, scoreOverride: -10, conditionsEnabled: { conditionC: true } },
		},
		customQualityConfig: {
			useCustomQualities: true,
			origin: "manual",
			cutoffId: "q1",
			customizedAt: "2026-01-01T00:00:00.000Z",
			items: [
				{
					type: "quality",
					item: {
						id: "q1",
						name: "HDTV-720p",
						allowed: true,
						source: "television",
						resolution: 720,
					},
				},
			],
		},
		namingSelection: { serviceType: "RADARR", filePreset: "movie-standard", folderPreset: null },
	};
}
const details = {
	profile: {
		name: "Guide profile",
		upgradeAllowed: true,
		cutoff: "HDTV-720p",
		minFormatScore: 0,
		cutoffFormatScore: 100,
		minUpgradeFormatScore: 0,
		items: [{ name: "HDTV-720p", allowed: true }],
	},
	mandatoryCFs: [],
	cfGroups: [
		{
			trash_id: "group-a",
			name: "Selected group",
			custom_formats: [{ trash_id: "cf-a", name: "Format A", required: false }],
		},
		{ trash_id: "group-b", name: "Unselected group", custom_formats: ["cf-b"] },
	],
	availableFormats: [],
	stats: { mandatoryCount: 0, optionalGroupCount: 2, totalOptionalCFs: 2 },
	qualityItems: [{ name: "HDTV-720p", allowed: true, source: "television", resolution: 720 }],
	trashScoreSet: "default",
	cfDescriptions: {},
};
function mount() {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	client.setQueryData(["trash-guides", "templates", { serviceType: "RADARR" }], {
		templates: [],
		totalCount: 0,
	});
	client.setQueryData(["unrelated"], { current: true });
	const onComplete = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<TemplateCreation
						serviceType="RADARR"
						wizardState={state()}
						onComplete={onComplete}
						onBack={vi.fn()}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return onComplete;
}
afterEach(async () => {
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("ordinary template creation rendered transport", () => {
	it("serializes selected groups, formats, qualities and naming through the real import client and invalidates templates on success", async () => {
		const imports: RequestInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === "/api/trash-guides/quality-profiles/RADARR/profile-a") return response(details);
				if (url === "/api/trash-guides/quality-profiles/import") {
					imports.push(init!);
					return response({
						template: { id: "created-template", name: "My template" },
						message: "Quality profile imported",
						customFormatsIncluded: 2,
					});
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const onComplete = mount();
		await screen.findByText("Review & Create Template");
		fireEvent.click(screen.getByRole("button", { name: "Create Template" }));
		await screen.findByText("Successfully imported quality profile as template!");
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatchObject({
			method: "POST",
			credentials: "include",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
		});
		expect(JSON.parse(String(imports[0]?.body))).toEqual({
			serviceType: "RADARR",
			trashId: "profile-a",
			templateName: "My template",
			templateDescription: "Reviewed description",
			selectedCFGroups: ["group-a"],
			customFormatSelections: {
				"cf-a": { selected: true, scoreOverride: 125, conditionsEnabled: { conditionA: false } },
				"cf-b": { selected: false, conditionsEnabled: {} },
				"manual-c": { selected: true, scoreOverride: -10, conditionsEnabled: { conditionC: true } },
			},
			customQualityConfig: {
				useCustomQualities: true,
				origin: "manual",
				cutoffId: "q1",
				customizedAt: "2026-01-01T00:00:00.000Z",
				items: [
					{
						type: "quality",
						item: {
							id: "q1",
							name: "HDTV-720p",
							allowed: true,
							source: "television",
							resolution: 720,
						},
					},
				],
			},
			namingSelection: { serviceType: "RADARR", filePreset: "movie-standard", folderPreset: null },
		});
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
		expect(
			client.getQueryState(["trash-guides", "templates", { serviceType: "RADARR" }])?.isInvalidated,
		).toBe(true);
		expect(client.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
	});
	it("renders a refused import and preserves the review without completing or invalidating templates", async () => {
		const imports: RequestInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === "/api/trash-guides/quality-profiles/RADARR/profile-a") return response(details);
				if (url === "/api/trash-guides/quality-profiles/import") {
					imports.push(init!);
					return response({ message: "Selected guide profile is unavailable" }, 409);
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const onComplete = mount();
		await screen.findByText("Review & Create Template");
		fireEvent.click(screen.getByRole("button", { name: "Create Template" }));
		await screen.findByText("Selected guide profile is unavailable");
		expect(imports).toHaveLength(1);
		expect(onComplete).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Create Template" })).toBeEnabled();
		expect(
			client.getQueryState(["trash-guides", "templates", { serviceType: "RADARR" }])?.isInvalidated,
		).toBe(false);
	});
});
