import { expect, test } from "@playwright/test";

const profileItems = [
	{ name: "WEB 2160p", allowed: true },
	{ name: "WEB 1080p", allowed: true, items: ["WEB 1080p", "WEBDL 1080p"] },
	{ name: "SD", allowed: false },
];
const cacheFetchedAt = "2026-11-24T00:00:00.000Z";
const formatId = "synthetic-format";

const importedTemplate = {
	id: "quality-order-template",
	userId: "fixture-admin",
	name: "Imported quality profile",
	description: "Browser fixture for quality ordering",
	serviceType: "RADARR",
	config: {
		customFormats: [
			{
				trashId: formatId,
				name: "Synthetic score format",
				scoreOverride: 10,
				conditionsEnabled: {},
				originalConfig: {
					trash_id: formatId,
					name: "Synthetic score format",
					specifications: [],
				},
				origin: "trash_profile",
				addedAt: cacheFetchedAt,
			},
		],
		customFormatGroups: [],
		qualityProfile: {
			cutoff: "WEB 1080p",
			items: profileItems,
		},
		syncSettings: { deleteRemovedCFs: false },
	},
	createdAt: cacheFetchedAt,
	updatedAt: cacheFetchedAt,
	usageCount: 0,
	isDefault: false,
	isActive: false,
	instanceIds: [],
};

test("imported quality order is readable and a score-only edit preserves the profile without creating an override", async ({
	page,
}) => {
	let savedPayload: Record<string, any> | undefined;
	let savedPath: string | undefined;
	const writes: string[] = [];

	await page.route("**/{api,auth}/**", async (route) => {
		const request = route.request();
		const { pathname } = new URL(request.url());

		if (request.method() !== "GET" && request.method() !== "PUT") {
			writes.push(request.method() + " " + pathname);
			return route.fulfill({ status: 405, json: { error: "unexpected_method" } });
		}

		if (pathname === "/auth/setup-required") {
			return route.fulfill({ json: { required: false } });
		}
		if (pathname === "/auth/me") {
			return route.fulfill({
				json: {
					user: {
						id: "fixture-admin",
						username: "fixture-admin",
						mustChangePassword: false,
						createdAt: cacheFetchedAt,
					},
				},
			});
		}
		if (pathname === "/api/services") {
			return route.fulfill({ json: { services: [] } });
		}
		if (pathname === "/api/trash-guides/templates" && request.method() === "GET") {
			return route.fulfill({ json: { templates: [importedTemplate], count: 1 } });
		}
		if (pathname === "/api/trash-guides/updates") {
			return route.fulfill({
				json: { success: true, data: { templatesWithUpdates: [], totalTemplates: 1 } },
			});
		}
		if (pathname === "/api/trash-guides/templates/quality-order-template/stats") {
			return route.fulfill({
				json: {
					stats: {
						instances: [],
						formatCount: 1,
						groupCount: 0,
						usageCount: 0,
						isActive: false,
						activeInstanceCount: 0,
					},
				},
			});
		}
		if (pathname === "/api/trash-guides/cache/entries") {
			return route.fulfill({
				json: [
					{
						id: "synthetic-cache",
						serviceType: "RADARR",
						configType: "CUSTOM_FORMATS",
						data: [
							{
								trash_id: formatId,
								name: "Synthetic score format",
								specifications: [],
							},
						],
						version: 1,
						fetchedAt: cacheFetchedAt,
						lastCheckedAt: cacheFetchedAt,
						updatedAt: cacheFetchedAt,
					},
				],
			});
		}
		if (request.method() === "PUT") {
			savedPath = pathname;
			savedPayload = request.postDataJSON() as Record<string, any>;
			return route.fulfill({
				json: {
					template: importedTemplate,
					message: "Template updated",
					customFormatsIncluded: 1,
				},
			});
		}

		return route.fulfill({ json: {} });
	});

	await page.goto("/trash-guides");
	const edit = page.getByRole("button", { name: "Edit template Imported quality profile" });
	await expect(edit).toBeVisible();
	await edit.click();

	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: "Configure Qualities" })).toBeVisible();
	await expect(dialog.getByText("Quality Priority Configuration")).toBeVisible();
	const qualityRows = dialog.locator('[draggable="true"]');
	await expect(qualityRows).toHaveCount(3);
	await expect(qualityRows.nth(0)).toContainText("WEB 2160p");
	await expect(qualityRows.nth(1)).toContainText("WEB 1080p");
	await expect(qualityRows.nth(1)).toContainText("(2 qualities)");
	await expect(qualityRows.nth(2)).toContainText("SD");
	await expect(dialog.getByText("Cutoff:")).toBeVisible();
	await expect(dialog.getByText("WEB 1080p", { exact: true }).first()).toBeVisible();

	await dialog.getByRole("button", { name: /Edit Custom Formats/ }).click();
	await expect(dialog.getByRole("heading", { name: "Edit Custom Formats" })).toBeVisible();
	await expect(dialog.getByText("Synthetic score format")).toBeVisible();
	const score = dialog.locator('input[type="number"]');
	await score.fill("25");
	await expect(score).toHaveValue("25");
	await dialog.getByRole("button", { name: "Continue to Review" }).click();
	await expect(dialog.getByRole("heading", { name: "Review & Update Template" })).toBeVisible();
	await dialog.getByRole("button", { name: "Update Template" }).click();

	await expect.poll(() => savedPayload).toBeDefined();
	expect(savedPayload?.customQualityConfig).toBeUndefined();
	expect(savedPath).toBe("/api/trash-guides/quality-profiles/update/quality-order-template");
	expect(savedPayload?.customFormatSelections[formatId].selected).toBe(true);
	expect(savedPayload?.customFormatSelections[formatId].scoreOverride).toBe(25);
	expect(savedPayload?.customFormatSelections[formatId].conditionsEnabled).toEqual({});
	expect(writes).toEqual([]);
});
