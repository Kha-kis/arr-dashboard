/**
 * Jellyfin Setup Wizard + Seerr seeding — driven via Playwright.
 *
 * Seerr requires a media server to create its first admin user.
 * Jellyfin's startup REST API is broken across versions (POST /Startup/User
 * crashes), so this script completes the wizard through the web UI, then
 * logs Seerr into Jellyfin (creating the Seerr admin user), connects Radarr,
 * creates a non-admin requester, and submits pending requests.
 *
 * Runs as part of the integration setup project (after bootstrap-services.sh,
 * which only waits for container readiness):
 *   pnpm run e2e:integration:up   # compose up + bootstrap
 *   pnpm run e2e:integration      # setup fixtures then specs
 */

import { test as setup, expect, request } from "@playwright/test";

const JELLYFIN_URL = process.env.JELLYFIN_EXTERNAL_URL || "http://localhost:8096";
const ADMIN_USER = "e2e-admin";
const ADMIN_PASS = "E2eTestPass123!";

setup("complete Jellyfin setup wizard", async ({ page }) => {
	await page.goto(`${JELLYFIN_URL}/web/`);

	// Wait for the wizard or detect it's already completed
	const wizardHeading = page.getByText(/preferred language|welcome to jellyfin/i).first();

	try {
		await wizardHeading.waitFor({ state: "visible", timeout: 15_000 });
	} catch {
		console.log("[jellyfin-setup] Wizard not found — may be already completed");
		return;
	}

	console.log("[jellyfin-setup] Wizard detected, completing setup...");

	const nextButton = page.getByRole("button", { name: /next/i });

	// Step 1: Language — click Next
	await nextButton.click();
	await page.waitForTimeout(500);

	// Step 2: Create admin user
	const usernameInput = page.locator('input[id="txtUsername"], input[name="Username"]').first();
	const passwordInput = page.locator('input[id="txtManualPassword"], input[name="Password"], input[type="password"]').first();

	await expect(usernameInput).toBeVisible({ timeout: 5_000 });
	await usernameInput.clear();
	await usernameInput.fill(ADMIN_USER);

	if (await passwordInput.isVisible()) {
		await passwordInput.fill(ADMIN_PASS);
		const confirmPassword = page.locator('input[id="txtPasswordConfirm"], input[name="PasswordConfirm"]').first();
		if (await confirmPassword.isVisible().catch(() => false)) {
			await confirmPassword.fill(ADMIN_PASS);
		}
	}

	await nextButton.click();
	await page.waitForTimeout(500);

	// Steps 3-5: Media Libraries, Metadata, Remote Access — click Next through all
	for (let i = 0; i < 3; i++) {
		await nextButton.click();
		await page.waitForTimeout(500);
	}

	// Step 6: Finish
	const finishButton = page.getByRole("button", { name: /finish|done|complete/i }).first();
	if (await finishButton.isVisible().catch(() => false)) {
		await finishButton.click();
	} else {
		await nextButton.click();
	}

	await page.waitForTimeout(1000);
	console.log("[jellyfin-setup] Wizard completed");

	// Verify admin user was created
	const response = await page.request.post(`${JELLYFIN_URL}/Users/AuthenticateByName`, {
		headers: {
			"Content-Type": "application/json",
			"X-Emby-Authorization": 'MediaBrowser Client="e2e", Device="setup", DeviceId="setup-001", Version="1.0"',
		},
		data: { Username: ADMIN_USER, Pw: ADMIN_PASS },
	});

	if (response.ok()) {
		const data = await response.json();
		console.log(`[jellyfin-setup] Auth verified: ${data.User?.Name} (admin: ${data.User?.Policy?.IsAdministrator})`);
	} else {
		console.log(`[jellyfin-setup] WARN: Auth verification failed (${response.status()})`);
	}
});

/**
 * Seed Seerr: admin login via Jellyfin, Radarr connection, requester user,
 * and pending requests. Idempotent across re-runs (skips when already seeded).
 * Fails loudly if pending requests cannot be established, because the
 * Requests spec relies on them.
 */
setup("seed Seerr admin, Radarr, requester, and pending requests", async () => {
	const seerr = process.env.SEERR_EXTERNAL_URL || "http://localhost:5055";
	const seerrKey = process.env.SEERR_API_KEY || "";
	const radarrKey = process.env.RADARR_API_KEY || "";

	if (!seerrKey || !radarrKey) {
		throw new Error("SEERR_API_KEY / RADARR_API_KEY missing from .env.services");
	}

	const ctx = await request.newContext();
	const headers = { "X-Api-Key": seerrKey };
	const jsonHeaders = { ...headers, "Content-Type": "application/json" };

	// 1. Detect existing state before any mutation. The request/count endpoint
	// returns 403 while Seerr has no admin user yet; once the admin exists it
	// returns the current counts, letting re-runs skip cleanly.
	const countResp = await ctx.get(`${seerr}/api/v1/request/count`, { headers });
	if (countResp.ok()) {
		const existing = await countResp.json();
		if ((existing.pending ?? 0) >= 2) {
			console.log(`[seerr-seed] ${existing.pending} pending requests already present, skipping`);
			await ctx.dispose();
			return;
		}
		console.log(`[seerr-seed] Admin present but ${existing.pending} pending — completing seeding`);
	} else if (countResp.status() === 403) {
		// 2. Fresh Seerr — login via Jellyfin creates the admin user (id 1).
		// Subsequent calls (even the login itself) 500 with
		// "Jellyfin hostname already configured" once Seerr is initialized.
		const login = await ctx.post(`${seerr}/api/v1/auth/jellyfin`, {
			data: {
				username: ADMIN_USER,
				password: ADMIN_PASS,
				hostname: "jellyfin",
				port: 8096,
				useSsl: false,
				urlBase: "",
				serverType: 2,
			},
		});
		if (!login.ok()) {
			throw new Error(`Seerr Jellyfin login failed (${login.status()}): ${await login.text()}`);
		}
		const loginData = await login.json();
		console.log(`[seerr-seed] Logged in via Jellyfin (user id ${loginData.id})`);
	} else {
		throw new Error(`Unexpected Seerr request/count status ${countResp.status()}: ${await countResp.text()}`);
	}

	// 3. Connect Radarr if not already connected
	const radarrList = await ctx.get(`${seerr}/api/v1/settings/radarr`, { headers });
	const radarrData = await radarrList.json();
	const hasRadarr = (radarrData || []).some((r: { is4k?: boolean; isDefault?: boolean }) => !r.is4k && r.isDefault);
	if (!hasRadarr) {
		const connect = await ctx.post(`${seerr}/api/v1/settings/radarr`, {
			headers: jsonHeaders,
			data: {
				name: "E2E Radarr",
				hostname: "radarr",
				port: 7878,
				apiKey: radarrKey,
				useSsl: false,
				baseUrl: "",
				activeProfileId: 1,
				activeProfileName: "Any",
				activeDirectory: "/config/media/movies",
				is4k: false,
				minimumAvailability: "released",
				isDefault: true,
			},
		});
		if (!connect.ok()) {
			throw new Error(`Seerr Radarr connection failed (${connect.status()}): ${await connect.text()}`);
		}
		console.log("[seerr-seed] Radarr connected");
	} else {
		console.log("[seerr-seed] Radarr already connected, skipping");
	}

	// 4. Create requester user (non-admin) if missing
	let requesterId = 0;
	const users = await ctx.get(`${seerr}/api/v1/user?take=100&skip=0`, { headers });
	const usersData = await users.json();
	const existing = (usersData.results || []).find((u: { username?: string }) => u.username === "e2e-requester");
	if (existing) {
		requesterId = (existing as { id: number }).id;
		console.log(`[seerr-seed] Requester exists (id ${requesterId}), skipping`);
	} else {
		// Explicit password avoids the email-notifications requirement
		const create = await ctx.post(`${seerr}/api/v1/user`, {
			headers: jsonHeaders,
			data: { username: "e2e-requester", password: "E2eRequester123!", permissions: 32 },
		});
		if (!create.ok()) {
			throw new Error(`Seerr requester creation failed (${create.status()}): ${await create.text()}`);
		}
		requesterId = (await create.json()).id;
		console.log(`[seerr-seed] Requester created (id ${requesterId})`);
	}

	// 5. Submit movie + TV requests as the requester. Acting as a non-admin
	// (X-API-User header, no userId in body) keeps the requests PENDING instead
	// of auto-approving them via the API-key admin.
	const asRequester = { ...headers, "X-API-User": String(requesterId) };
	const movieReq = await ctx.post(`${seerr}/api/v1/request`, {
		headers: { ...asRequester, "Content-Type": "application/json" },
		data: { mediaId: 550, mediaType: "movie" },
	});
	if (movieReq.status() !== 201 && movieReq.status() !== 409) {
		throw new Error(`Seerr movie request failed (${movieReq.status()}): ${await movieReq.text()}`);
	}

	const tvReq = await ctx.post(`${seerr}/api/v1/request`, {
		headers: { ...asRequester, "Content-Type": "application/json" },
		data: { mediaId: 2316, mediaType: "tv", seasons: [1] },
	});
	if (tvReq.status() !== 201 && tvReq.status() !== 409) {
		throw new Error(`Seerr TV request failed (${tvReq.status()}): ${await tvReq.text()}`);
	}

	// 6. Fail loudly if pending requests are not present
	const finalCount = await ctx.get(`${seerr}/api/v1/request/count`, { headers });
	const finalData = await finalCount.json();
	if ((finalData.pending ?? 0) < 2) {
		throw new Error(
			`Seerr seeding incomplete: expected >= 2 pending requests, got ${JSON.stringify(finalData)}`,
		);
	}
	console.log(`[seerr-seed] Pending requests confirmed: ${finalData.pending}`);

	await ctx.dispose();
});
