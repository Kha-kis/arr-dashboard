import type { CompleteQualityProfile, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QualityProfileWizard } from "../quality-profile-wizard";
import { TemplateCreation } from "../wizard-steps/template-creation";

let client: QueryClient;
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
const service: ServiceInstanceSummary = {
	id: "radarr-a",
	service: "radarr",
	label: "Radarr A",
	baseUrl: "http://radarr.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: true,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	tags: [],
};
const imported: CompleteQualityProfile = {
	sourceInstanceId: "radarr-a",
	sourceInstanceLabel: "Radarr A",
	sourceProfileId: 7,
	sourceProfileName: "Source profile",
	sourceConnectionStateToken: "connection-a",
	importedAt: "2026-01-01T00:00:00.000Z",
	upgradeAllowed: true,
	cutoff: 4,
	cutoffQuality: { id: 4, name: "HDTV-720p", source: "television", resolution: 720 },
	items: [
		{
			id: 4,
			name: "HDTV-720p",
			allowed: true,
			quality: { id: 4, name: "HDTV-720p", source: "television", resolution: 720 },
		},
	],
	minFormatScore: 10,
	cutoffFormatScore: 100,
	minUpgradeFormatScore: 5,
	language: { id: 1, name: "English" },
	languages: [{ id: 1, name: "English", allowed: true }],
};
function details(reviewed: boolean) {
	return {
		success: true,
		data: {
			sourceStateToken: reviewed
				? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			serviceType: "RADARR",
			profile: {
				name: "Source profile",
				upgradeAllowed: true,
				cutoff: 4,
				minFormatScore: reviewed ? 20 : 10,
				cutoffFormatScore: 100,
				items: [
					{
						id: 4,
						name: "HDTV-720p",
						allowed: true,
						quality: { id: 4, name: "HDTV-720p", source: "television", resolution: 720 },
					},
				],
				language: { id: 1, name: "English" },
			},
			customFormats: [
				{
					trash_id: "instance-42",
					name: "Instance format",
					score: 100,
					specifications: [],
					includeCustomFormatWhenRenaming: false,
				},
			],
			allCustomFormats: [
				{
					trash_id: "instance-42",
					name: "Instance format",
					score: 100,
					specifications: [],
					includeCustomFormatWhenRenaming: false,
				},
			],
		},
	};
}
function mount(children: ReactNode) {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
function transport(mode: "success" | "refused" | "failed-review" | "missing-token") {
	const creates: RequestInit[] = [],
		requests: Array<{ url: string; init?: RequestInit }> = [];
	let detailReads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			requests.push({ url, init });
			if (url === "/api/services") return response({ services: [service] });
			if (url === "/api/trash-guides/quality-profiles/RADARR")
				return response({
					profiles: [
						{
							trashId: "guide-a",
							name: "Guide profile",
							description: "",
							customFormatCount: 0,
							qualityCount: 1,
							cutoff: "HDTV-720p",
							upgradeAllowed: true,
						},
					],
					totalCount: 1,
					serviceType: "RADARR",
				});
			if (url === "/api/trash-guides/profile-clone/profiles/radarr-a")
				return response({
					success: true,
					data: {
						profiles: [
							{
								id: 7,
								name: "Source profile",
								upgradeAllowed: true,
								cutoff: 4,
								cutoffQuality: { id: 4, name: "HDTV-720p" },
								minFormatScore: 10,
								formatItemsCount: 1,
							},
						],
					},
				});
			if (url === "/api/trash-guides/profile-clone/import")
				return response({ success: true, data: { profile: imported } });
			if (url === "/api/trash-guides/profile-clone/validate-cfs")
				return response({
					success: true,
					profileName: "Source profile",
					summary: { total: 1, exactMatches: 0, nameMatches: 0, specsSimilar: 0, noMatch: 1 },
					results: [
						{
							instanceCF: { id: 42, name: "Instance format", score: 100 },
							trashCF: null,
							confidence: "no_match",
							matchDetails: { nameMatch: false, specsMatch: false, specsDiffer: [] },
						},
					],
				});
			if (url === "/api/trash-guides/profile-clone/match-profile")
				return response({
					matched: false,
					reason: "No matching guide profile",
					availableProfiles: [],
				});
			if (url === "/api/trash-guides/profile-clone/profile-details/radarr-a/7") {
				detailReads++;
				if (detailReads > 1 && mode === "failed-review")
					return response({ message: "Source review unavailable" }, 503);
				const body = details(detailReads > 1);
				if (detailReads > 1 && mode === "missing-token") body.data.sourceStateToken = "";
				return response(body);
			}
			if (url === "/api/trash-guides/cache/cf-descriptions/list?serviceType=RADARR")
				return response({ radarr: [] });
			if (url === "/api/trash-guides/profile-clone/create-template") {
				creates.push(init!);
				return mode === "refused"
					? response({ message: "Reviewed source changed; review again" }, 409)
					: response({
							template: { id: "cloned-template", name: "Source profile" },
							message: "Template created",
							customFormatsIncluded: 1,
						});
			}
			throw new Error(`Unexpected request ${url}`);
		}),
	);
	return { creates, requests, detailReads: () => detailReads };
}
async function navigateToConfiguration() {
	fireEvent.click(await screen.findByText("Clone from Instance"));
	await screen.findByRole("option", { name: "Radarr A (radarr)" });
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "radarr-a" } });
	fireEvent.click(await screen.findByRole("button", { name: /Source profile/ }));
	fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
	fireEvent.click(await screen.findByRole("button", { name: "Use This Profile" }));
	fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
	const next = await screen.findByRole("button", { name: "Continue to Custom Formats" });
	await waitFor(() => expect(client.isFetching()).toBe(0));
	fireEvent.click(next);
}
afterEach(async () => {
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("cloned profile reviewed handoff transport", () => {
	it("physically carries the configuration review through the real wizard into exact create-template transport", async () => {
		const io = transport("success"),
			onClose = vi.fn();
		mount(<QualityProfileWizard open serviceType="RADARR" onClose={onClose} />);
		await navigateToConfiguration();
		fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
		await screen.findByText("Review & Create Template");
		fireEvent.click(screen.getByRole("button", { name: "Create Template" }));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(io.detailReads()).toBe(2);
		expect(io.creates).toHaveLength(1);
		const body = JSON.parse(String(io.creates[0]?.body));
		expect(io.creates[0]).toMatchObject({ method: "POST", credentials: "include" });
		expect(body).toMatchObject({
			serviceType: "RADARR",
			templateName: "Source profile",
			templateDescription: "Cloned from Radarr A",
			sourceInstanceId: "radarr-a",
			sourceProfileId: 7,
			sourceProfileName: "Source profile",
			sourceInstanceLabel: "Radarr A",
			sourceStateToken: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			customFormatSelections: { "instance-42": { selected: true, conditionsEnabled: {} } },
			profileConfig: {
				upgradeAllowed: true,
				cutoff: 4,
				minFormatScore: 20,
				cutoffFormatScore: 100,
				items: [
					{
						id: 4,
						name: "HDTV-720p",
						allowed: true,
						quality: { id: 4, name: "HDTV-720p", source: "television", resolution: 720 },
					},
				],
				language: { id: 1, name: "English" },
			},
		});
		expect(body.trashId).toMatch(/^cloned-radarr-a-7-/);
		expect(Object.keys(body.customFormatSelections)).toEqual(["instance-42"]);
		expect(body.customQualityConfig).toMatchObject({
			useCustomQualities: false,
			items: [{ type: "quality", item: { name: "HDTV-720p", allowed: true } }],
		});
		expect(io.requests.find((r) => r.url.endsWith("/validate-cfs"))?.init?.body).toBe(
			'{"instanceId":"radarr-a","profileId":7,"serviceType":"RADARR"}',
		);
	});
	it("shows rejected creation and keeps the physically reviewed wizard open", async () => {
		const io = transport("refused"),
			onClose = vi.fn();
		mount(<QualityProfileWizard open serviceType="RADARR" onClose={onClose} />);
		await navigateToConfiguration();
		fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
		await screen.findByText("Review & Create Template");
		fireEvent.click(screen.getByRole("button", { name: "Create Template" }));
		await screen.findByText("Reviewed source changed; review again");
		expect(io.creates).toHaveLength(1);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Create Template" })).toBeEnabled();
	});
	it.each(["failed-review", "missing-token"] as const)(
		"blocks the real wizard when configuration has %s",
		async (mode) => {
			const io = transport(mode),
				onClose = vi.fn();
			mount(<QualityProfileWizard open serviceType="RADARR" onClose={onClose} />);
			await navigateToConfiguration();
			await screen.findByText(
				mode === "failed-review"
					? "Source review unavailable"
					: "The cloned profile source review is unavailable. Refresh and try again.",
			);
			expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Create Template" })).not.toBeInTheDocument();
			expect(io.creates).toEqual([]);
			expect(onClose).not.toHaveBeenCalled();
		},
	);
	it("blocks direct final creation when no source review has been carried", () => {
		const requests: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				requests.push(url);
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const onComplete = vi.fn();
		mount(
			<TemplateCreation
				serviceType="RADARR"
				wizardState={{
					selectedProfile: {
						trashId: "cloned-radarr-a-7-1700000000000-abc123",
						name: "Source profile",
						description: "Cloned from Radarr A",
						customFormatCount: 1,
						qualityCount: 1,
						cutoff: "HDTV-720p",
						upgradeAllowed: true,
					},
					templateName: "Cloned template",
					templateDescription: "",
					customFormatSelections: { "instance-42": { selected: true, conditionsEnabled: {} } },
				}}
				onComplete={onComplete}
				onBack={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(
				"The cloned profile review is unavailable. Go back and review the Custom Formats again.",
			),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Create Template" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Create Template" }));
		expect(requests).toEqual([]);
		expect(onComplete).not.toHaveBeenCalled();
	});
});
