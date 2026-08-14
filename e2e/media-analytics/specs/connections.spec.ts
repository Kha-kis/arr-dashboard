import { expect, test } from "@playwright/test";

const SERVICES = [
	{ label: "E2E Plex", result: /Successfully connected to Plex/i },
	{ label: "E2E Tautulli", result: /Successfully connected to Tautulli/i },
	{ label: "E2E Tracearr", result: /Connected to Tracearr/i },
] as const;

test("renders the three real provider connections", async ({ page }) => {
	await page.goto("/settings#services");
	await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

	for (const { label, result } of SERVICES) {
		const heading = page.getByRole("heading", { name: label, level: 3 });
		await expect(heading).toBeVisible();
		const card = page.locator("div.group").filter({ has: heading });
		await card.getByRole("button", { name: "Test", exact: true }).click();
		await expect(card.getByText(result)).toBeVisible();
	}
});

test("renders the provider-choice setup guidance", async ({ page }) => {
	await page.goto("/setup?stage=services");

	await expect(
		page.getByText(/Tracearr is recommended for new analytics setups/i),
	).toBeVisible();
	await expect(page.getByText(/Tautulli remains a supported alternative/i)).toBeVisible();
	await expect(page.getByText(/Choose one historical analytics provider/i)).toBeVisible();
});
