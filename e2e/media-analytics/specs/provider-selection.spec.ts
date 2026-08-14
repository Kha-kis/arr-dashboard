import { expect, test, type Page } from "@playwright/test";

const PROVIDERS = {
	tracearr: { label: "Tracearr", radioName: "Tracearr Recommended" },
	tautulli: { label: "Tautulli", radioName: "Tautulli Alternative" },
} as const;

type Provider = keyof typeof PROVIDERS;

async function showProviderSettings(page: Page) {
	await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
	await page.getByRole("button", { name: "Services", exact: true }).click();
	await expect(
		page.getByRole("radiogroup", { name: "Historical analytics provider" }),
	).toBeVisible();
}

async function openProviderSettings(page: Page) {
	await page.goto("/settings#services");
	await showProviderSettings(page);
}

async function ensureProviderEnabled(page: Page, label: string) {
	const card = page.getByRole("heading", { name: label, level: 3 }).locator("xpath=../../..");
	const enable = card.getByRole("button", { name: "Enable", exact: true });
	if ((await enable.count()) === 0) return;

	await enable.click();
	await expect(card.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
}

async function selectProvider(page: Page, provider: Provider) {
	const target = PROVIDERS[provider];
	const radio = page.getByRole("radio", { name: target.radioName, exact: true });
	if (await radio.isChecked()) return;

	await radio.locator("xpath=..").click();
	const dialog = page.getByRole("dialog", { name: "Switch historical analytics provider?" });
	await expect(dialog).toBeVisible();
	const selectionResponse = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/system/analytics-provider" &&
			response.request().method() === "PUT",
	);
	await dialog.getByRole("button", { name: `Switch to ${target.label}`, exact: true }).click();
	await expect((await selectionResponse).status()).toBe(200);
	await page.reload();
	await expect(radio).toBeChecked();
}

async function openAnalytics(page: Page) {
	await page.goto("/statistics");
	await expect(page.getByRole("heading", { name: "Statistics", level: 1 })).toBeVisible();
	await page.getByRole("button", { name: "Analytics", exact: true }).click();
}

function expectNoTracearrAnalytics(page: Page) {
	return Promise.all([
		expect(page.getByTestId("tracearr-stats-cards")).toHaveCount(0),
		expect(page.getByText(/^Source: Tracearr/)).toHaveCount(0),
	]);
}

test("switches both configured analytics providers through Settings without mixing their rendered data", async ({
	page,
}) => {
	await openProviderSettings(page);
	await ensureProviderEnabled(page, "E2E Tracearr");
	await ensureProviderEnabled(page, "E2E Tautulli");
	await selectProvider(page, "tracearr");
	await expect(
		page.getByRole("radio", { name: PROVIDERS.tracearr.radioName, exact: true }),
	).toBeChecked();

	await selectProvider(page, "tautulli");
	await openAnalytics(page);
	await expect(page.getByTestId("tautulli-analytics")).toBeVisible();
	await expect(page.getByRole("heading", { name: "E2E Tautulli", level: 2 })).toBeVisible();
	await expectNoTracearrAnalytics(page);

	await page.goBack();
	await showProviderSettings(page);
	await selectProvider(page, "tracearr");
	await openAnalytics(page);
	await expect(page.getByTestId("tracearr-stats-cards")).toBeVisible();
	await expect(page.getByText(/^Source: Tracearr/)).toBeVisible();
	await expect(page.getByTestId("tautulli-analytics")).toHaveCount(0);
});

test("does not render Tracearr analytics when the selected Tautulli source is unreachable", async ({
	page,
}) => {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: this one-off browser assertion is run directly from the documented outage sequence, not through Turbo.
	const selectedTautulliOutage = process.env.MEDIA_ANALYTICS_EXPECT_TAUTULLI_OUTAGE === "1";
	test.skip(
		!selectedTautulliOutage,
		"Run only from the documented selected-Tautulli outage sequence.",
	);

	await openProviderSettings(page);
	await selectProvider(page, "tautulli");
	await openAnalytics(page);

	await expect(page.getByTestId("tautulli-analytics")).toBeVisible();
	await expect(page.getByText("Statistics unavailable: source unreachable.")).toBeVisible();
	await expectNoTracearrAnalytics(page);
});
