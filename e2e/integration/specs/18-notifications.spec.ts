/**
 * Integration: Notification System
 *
 * Tests the full notification pipeline:
 * 1. Creates a WEBHOOK notification channel pointing to the echo receiver
 * 2. Tests the channel via the API test endpoint
 * 3. Verifies the UI shows the channel as configured
 * 4. Validates that the settings notifications tab renders correctly
 */

import { test, expect, request } from "@playwright/test";
import { ROUTES, TIMEOUTS, waitForLoadingComplete, selectTab } from "../../utils/test-helpers";
import { ensureAuthenticated } from "../utils/auth-helpers";

const API_URL = process.env.DASHBOARD_API_URL || "http://localhost:3001";
// Internal Docker URL — the dashboard container sends webhooks inside the Docker network
const WEBHOOK_INTERNAL_URL = process.env.WEBHOOK_RECEIVER_URL || "http://webhook-receiver:80";

/** Extract a valid session cookie from the browser context, or fail. */
function getSessionCookie(cookies: { name: string; value: string }[]): string {
	const cookie = cookies.find((c) => c.name === "arr_session");
	if (!cookie) throw new Error("Session cookie 'arr_session' not found in browser context");
	return cookie.value;
}

test.describe("Notification System", () => {
	let channelId: string | undefined;

	test("should create a webhook notification channel via API", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		const sessionValue = getSessionCookie(await page.context().cookies());

		const api = await request.newContext({
			baseURL: API_URL,
			extraHTTPHeaders: {
				Cookie: `arr_session=${sessionValue}`,
			},
		});

		// Create a webhook channel pointing to the echo receiver
		const createResponse = await api.post("/api/notifications/channels", {
			data: {
				name: "E2E Webhook Test",
				type: "WEBHOOK",
				enabled: true,
				config: {
					url: `${WEBHOOK_INTERNAL_URL}/webhook-test`,
					method: "POST",
				},
			},
		});

		expect(createResponse.ok(), `Create channel failed: ${createResponse.status()}`).toBe(true);

		const body = await createResponse.json();
		channelId = body.channel?.id ?? body.id;
		expect(channelId, "Channel ID should be returned").toBeTruthy();

		console.log(`[notifications] Created webhook channel: ${channelId}`);
		await api.dispose();
	});

	test("should test the webhook channel successfully", async ({ page }) => {
		test.skip(!channelId, "Depends on channel creation test");

		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		const sessionValue = getSessionCookie(await page.context().cookies());

		const api = await request.newContext({
			baseURL: API_URL,
			extraHTTPHeaders: {
				Cookie: `arr_session=${sessionValue}`,
			},
		});

		// Test the channel — dashboard sends a POST to the webhook receiver
		const testResponse = await api.post(`/api/notifications/channels/${channelId}/test`);

		expect(testResponse.ok(), `Test failed: ${testResponse.status()}`).toBe(true);

		const result = await testResponse.json();
		expect(result.success).toBe(true);

		console.log("[notifications] Webhook test delivered successfully");
		await api.dispose();
	});

	test("should show notification channels in settings", async ({ page }) => {
		test.skip(!channelId, "Depends on channel creation test");

		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		// Navigate to Notifications tab
		await selectTab(page, "Notifications");
		await page.waitForTimeout(1000);

		// The webhook channel we created should be visible
		await expect(page.getByText("E2E Webhook Test").first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should show channel type badge", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
		await selectTab(page, "Notifications");
		await page.waitForTimeout(1000);

		// Should show WEBHOOK type indicator
		await expect(page.getByText(/webhook/i).first()).toBeVisible({
			timeout: TIMEOUTS.medium,
		});
	});

	test("should list notification channel types", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);

		const sessionValue = getSessionCookie(await page.context().cookies());

		const api = await request.newContext({
			baseURL: API_URL,
			extraHTTPHeaders: {
				Cookie: `arr_session=${sessionValue}`,
			},
		});

		// Verify the channel types endpoint returns all supported types
		const response = await api.get("/api/notifications/channel-types");
		expect(response.ok()).toBe(true);

		const data = await response.json();
		const types = Array.isArray(data) ? data : data.types ?? [];
		const typeNames = types.map((t: { type?: string; name?: string }) => t.type ?? t.name);

		// Should include at least the core notification types
		for (const expected of ["DISCORD", "SLACK", "WEBHOOK"]) {
			expect(typeNames, `Missing channel type: ${expected}`).toContainEqual(expected);
		}

		console.log(`[notifications] ${types.length} channel types available`);
		await api.dispose();
	});

	test("should not show error alerts on notifications tab", async ({ page }) => {
		await page.goto(ROUTES.settings);
		await waitForLoadingComplete(page);
		await ensureAuthenticated(page);
		await selectTab(page, "Notifications");
		await page.waitForTimeout(1000);

		const errorAlerts = page.getByRole("alert").filter({ hasText: /error|failed/i });
		expect(await errorAlerts.count()).toBe(0);
	});
});
