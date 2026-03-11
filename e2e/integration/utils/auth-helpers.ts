/**
 * Integration test auth helpers
 *
 * Provides utilities for re-authenticating when sessions are lost
 * due to rate limiting or container load during test runs.
 */

import type { Page } from "@playwright/test";

/**
 * Ensure the page is authenticated by checking for the "Sign in" link.
 * If detected, re-login via the Next.js proxy route and reload.
 *
 * This handles intermittent auth loss caused by container restarts
 * or edge-case middleware failures.
 */
export async function ensureAuthenticated(page: Page): Promise<void> {
	// Quick check: are we on the login page or does "Sign in" appear?
	const isOnLogin = page.url().includes("/login");
	const signInLink = page.getByRole("link", { name: /sign in/i });
	const hasSignIn = isOnLogin || (await signInLink.count()) > 0;

	if (!hasSignIn) return;

	// Re-authenticate via the web proxy (same origin → cookie applies to browser)
	const baseURL = process.env.DASHBOARD_URL || "http://localhost:3000";
	const currentUrl = page.url();

	try {
		const response = await page.request.post(`${baseURL}/auth/login`, {
			data: {
				username: "admin",
				password: "TestPassword123!",
			},
		});

		if (response.ok()) {
			// Navigate back to the original page (or dashboard if on login)
			const target = isOnLogin ? `${baseURL}/dashboard` : currentUrl;
			await page.goto(target, { waitUntil: "domcontentloaded" });
			await page.waitForTimeout(500);
		}
	} catch {
		// If API request fails, try navigating to login page and using the form
		await page.goto(`${baseURL}/login`);
		await page.waitForTimeout(1000);

		const usernameInput = page.locator("#username");
		const passwordInput = page.locator("#password");

		if ((await usernameInput.count()) > 0) {
			await usernameInput.fill("admin");
			await passwordInput.fill("TestPassword123!");
			await page.locator('button[type="submit"]').click();
			await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 }).catch(() => {});
		}

		// Return to original page
		if (!isOnLogin) {
			await page.goto(currentUrl, { waitUntil: "domcontentloaded" });
			await page.waitForTimeout(500);
		}
	}
}
