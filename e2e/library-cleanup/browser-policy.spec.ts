import { expect, type Page, test } from "@playwright/test";

const RULE_PREFIX = "LC E2E Browser ";
const USERNAME = "gauntlet-admin";
const PASSWORD = "LibraryCleanupGauntlet2026!";

interface CleanupRule {
	id: string;
	name: string;
	enabled: boolean;
	priority: number;
	ruleType: string;
	parameters: Record<string, unknown>;
	serviceFilter: string[] | null;
	instanceFilter: string[] | null;
	excludeTags: number[] | null;
	excludeTitles: string[] | null;
	plexLibraryFilter: string[] | null;
	targetScope: string;
	action: string;
	scanMediaServerAfterDelete: boolean;
	operator: string | null;
	conditions: unknown[] | null;
	expression?: unknown;
	retentionMode: boolean;
	useGlobalRejectionMemory: boolean;
	rejectionMemoryDays: number | null;
	createdAt: string;
	updatedAt: string;
}

async function login(page: Page): Promise<void> {
	await page.goto("/login");
	await page.getByRole("textbox", { name: /username/i }).fill(USERNAME);
	await page.getByRole("textbox", { name: /password/i }).fill(PASSWORD);
	await page.getByRole("button", { name: /sign in with password/i }).click();
	await expect(page).toHaveURL(/\/dashboard$/);
}

async function readRules(page: Page): Promise<CleanupRule[]> {
	const response = await page.request.get("/api/library-cleanup/config");
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { rules: CleanupRule[] }).rules;
}

async function resetHarnessRules(page: Page): Promise<void> {
	const rules = await readRules(page);
	const foreignRules = rules.filter((rule) => !rule.name.startsWith("LC E2E "));
	expect(foreignRules, "browser gate refuses to alter non-harness rules").toEqual([]);
	for (const rule of rules) {
		const response = await page.request.delete(`/api/library-cleanup/rules/${rule.id}`);
		expect(response.ok()).toBe(true);
	}
}

async function openCreateRule(page: Page, name: string): Promise<void> {
	await page.goto("/library-cleanup");
	await expect(page.getByRole("heading", { name: "Library Cleanup" })).toBeVisible();
	await page.getByRole("button", { name: "Add Rule", exact: true }).first().click();
	await page.getByPlaceholder("e.g., Old low-rated movies").fill(name);
}

async function disableRule(page: Page): Promise<void> {
	const enabledSwitch = page
		.getByText("Enabled", { exact: true })
		.locator("..")
		.getByRole("switch");
	await expect(enabledSwitch).toHaveAttribute("aria-checked", "true");
	await enabledSwitch.click();
	await expect(enabledSwitch).toHaveAttribute("aria-checked", "false");
}

async function readRule(page: Page, name: string): Promise<CleanupRule> {
	const rule = (await readRules(page)).find((candidate) => candidate.name === name);
	expect(rule, `saved rule ${name}`).toBeDefined();
	return rule!;
}

function semanticRule(rule: CleanupRule): Omit<CleanupRule, "id" | "createdAt" | "updatedAt"> {
	const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...semantic } = rule;
	return semantic;
}

test.beforeEach(async ({ page }) => {
	await login(page);
	await resetHarnessRules(page);
});

test.afterEach(async ({ page }) => {
	await resetHarnessRules(page);
});

test("authors and round-trips (A AND B) OR (A AND NOT C)", async ({ page }) => {
	const name = `${RULE_PREFIX}recursive policy`;
	await openCreateRule(page, name);
	await disableRule(page);
	await page.getByRole("button", { name: "Unmonitor", exact: true }).click();
	await page.getByRole("button", { name: "Filter by radarr" }).click();
	await page.getByLabel("Exclude Titles (regex patterns, comma-separated)").fill("^Protected$");
	await page
		.getByText("Override rejection memory", { exact: true })
		.locator("..")
		.locator("..")
		.getByRole("switch")
		.click();
	await page.getByLabel("Memory mode (this rule)").selectOption("days");
	await page.getByRole("spinbutton", { name: "Days" }).first().fill("17");
	await page.getByRole("button", { name: "Composite Rule", exact: true }).click();
	await page.getByRole("button", { name: "OR", exact: true }).first().click();

	// Top-level expression controls render after every child node, so the last
	// + Group button remains the root control while authoring nested children.
	await page.getByRole("button", { name: "+ Group", exact: true }).last().click();
	await page.getByRole("button", { name: "+ Group", exact: true }).last().click();

	const conditionTypes = page.getByLabel("Condition type");
	await expect(conditionTypes).toHaveCount(2);
	await conditionTypes.nth(0).selectOption("monitored");
	await conditionTypes.nth(1).selectOption("monitored");

	await page.getByRole("button", { name: "+ Condition", exact: true }).first().click();
	await expect(conditionTypes).toHaveCount(3);
	await conditionTypes.nth(1).selectOption("year_range");

	// The second nested group owns the second group-level + NOT control.
	await page.getByRole("button", { name: "+ NOT", exact: true }).nth(1).click();
	await expect(conditionTypes).toHaveCount(4);
	await conditionTypes.nth(3).selectOption("year_range");

	const yearOperators = page.getByLabel("Operator");
	await expect(yearOperators).toHaveCount(2);
	await yearOperators.nth(0).selectOption("after");
	await yearOperators.nth(1).selectOption("after");
	await page.getByLabel("Year", { exact: true }).nth(0).fill("1990");
	await page.getByLabel("Year", { exact: true }).nth(1).fill("2020");

	await page.getByRole("button", { name: "Add Rule", exact: true }).last().click();
	await expect(page.getByText(name, { exact: true })).toBeVisible();
	await expect(page.getByText("Nested expression", { exact: true })).toBeVisible();

	const expectedExpression = {
		version: 1,
		root: {
			type: "group",
			operator: "OR",
			children: [
				{
					type: "group",
					operator: "AND",
					children: [
						{ type: "condition", ruleType: "monitored", parameters: {} },
						{
							type: "condition",
							ruleType: "year_range",
							parameters: { operator: "after", year: 1990 },
						},
					],
				},
				{
					type: "group",
					operator: "AND",
					children: [
						{ type: "condition", ruleType: "monitored", parameters: {} },
						{
							type: "not",
							child: {
								type: "condition",
								ruleType: "year_range",
								parameters: { operator: "after", year: 2020 },
							},
						},
					],
				},
			],
		},
	};
	const savedRule = await readRule(page, name);
	expect(savedRule).toMatchObject({
		enabled: false,
		action: "unmonitor",
		serviceFilter: ["radarr"],
		excludeTitles: ["^Protected$"],
		useGlobalRejectionMemory: false,
		rejectionMemoryDays: 17,
		expression: expectedExpression,
	});
	const savedSemantics = semanticRule(savedRule);

	await page.getByRole("button", { name: `Edit rule: ${name}` }).click();
	await expect(page.getByText("NOT", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Condition type")).toHaveCount(4);
	await expect(
		page.getByText("Any condition matching will trigger the rule.", { exact: true }),
	).toBeVisible();
	await expect(
		page.locator('button[aria-pressed="true"]').filter({ hasText: /^AND$/ }),
	).toHaveCount(2);
	await expect(page.getByLabel("Condition type").nth(0)).toHaveValue("monitored");
	await expect(page.getByLabel("Condition type").nth(1)).toHaveValue("year_range");
	await expect(page.getByLabel("Condition type").nth(2)).toHaveValue("monitored");
	await expect(page.getByLabel("Condition type").nth(3)).toHaveValue("year_range");
	await expect(page.getByLabel("Year", { exact: true }).nth(0)).toHaveValue("1990");
	await expect(page.getByLabel("Year", { exact: true }).nth(1)).toHaveValue("2020");
	await expect(
		page.getByText("Enabled", { exact: true }).locator("..").getByRole("switch"),
	).toHaveAttribute("aria-checked", "false");
	await page.getByRole("button", { name: "Save Changes", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Edit Rule" })).not.toBeVisible();
	const resavedRule = await readRule(page, name);
	expect(semanticRule(resavedRule)).toEqual(savedSemantics);
});

test("authors the direct Monitored condition with an Unmonitor action", async ({ page }) => {
	const name = `${RULE_PREFIX}monitored action`;
	await openCreateRule(page, name);
	await disableRule(page);
	await page.getByText("Monitored", { exact: true }).click();
	await expect(
		page.getByText("Matches all monitored items. No additional parameters."),
	).toBeVisible();
	await page.getByRole("button", { name: "Unmonitor", exact: true }).click();
	await page.getByRole("button", { name: "Add Rule", exact: true }).last().click();

	await expect(page.getByText(name, { exact: true })).toBeVisible();
	await expect(
		page
			.locator("span")
			.filter({ hasText: /^Unmonitor$/ })
			.first(),
	).toBeVisible();
	const savedRule = await readRule(page, name);
	expect(savedRule).toMatchObject({
		name,
		enabled: false,
		ruleType: "monitored",
		parameters: {},
		action: "unmonitor",
	});
	const savedSemantics = semanticRule(savedRule);

	await page.getByRole("button", { name: `Edit rule: ${name}` }).click();
	await expect(
		page.getByText("Matches all monitored items. No additional parameters."),
	).toBeVisible();
	await expect(
		page.getByText("Set the item as unmonitored (keeps files and data).", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Enabled", { exact: true }).locator("..").getByRole("switch"),
	).toHaveAttribute("aria-checked", "false");
	await page.getByRole("button", { name: "Save Changes", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Edit Rule" })).not.toBeVisible();
	expect(semanticRule(await readRule(page, name))).toEqual(savedSemantics);
});
