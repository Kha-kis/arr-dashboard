/**
 * Unit tests for the pure security-posture evaluator.
 *
 * The evaluator has no IO, so every scenario can be expressed as a plain
 * input object. Tests target the specific conditions that matter for admins:
 *   - The dangerous combos that warrant "misconfigured".
 *   - The nudges that warrant "warning".
 *   - The healthy baseline (to guard against severity drift).
 *   - The overall roll-up reducer.
 */

import { describe, expect, it } from "vitest";
import { evaluateSecurityPosture, type SecurityPostureInput } from "../security-posture.js";

type Overrides = Omit<Partial<SecurityPostureInput>, "env"> & {
	env?: Partial<SecurityPostureInput["env"]>;
};

function baseInput(overrides: Overrides = {}): SecurityPostureInput {
	return {
		env: {
			NODE_ENV: "development",
			TRUST_PROXY: false,
			COOKIE_SECURE: undefined,
			SESSION_TTL_HOURS: 24,
			SESSION_COOKIE_NAME: "arr_session",
			PASSWORD_POLICY: "strict",
			APP_URL: "http://localhost:3000",
			...overrides.env,
		},
		oidcEnabled: overrides.oidcEnabled ?? false,
		passkeyCount: overrides.passkeyCount ?? 0,
		passwordUserCount: overrides.passwordUserCount ?? 1,
		totalUserCount: overrides.totalUserCount ?? 1,
	};
}

function checkById(result: ReturnType<typeof evaluateSecurityPosture>, id: string) {
	const check = result.checks.find((c) => c.id === id);
	if (!check) throw new Error(`missing check: ${id}`);
	return check;
}

describe("evaluateSecurityPosture", () => {
	describe("healthy baseline", () => {
		it("returns overall=healthy for a dev setup with password-only on localhost http", () => {
			// Dev + password-only would normally flag the auth-strength warning,
			// so we enroll a passkey here to get an all-green baseline and guard
			// against severity drift in future changes.
			const result = evaluateSecurityPosture(baseInput({ passkeyCount: 1 }));

			expect(result.overall).toBe("healthy");
			expect(result.checks.every((c) => c.severity === "healthy")).toBe(true);
		});

		it("exposes effective runtime values verbatim for the UI", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: {
						NODE_ENV: "production",
						TRUST_PROXY: true,
						COOKIE_SECURE: true,
						SESSION_TTL_HOURS: 12,
						SESSION_COOKIE_NAME: "arr_session",
						PASSWORD_POLICY: "strict",
						APP_URL: "https://arr.example.com",
					},
					oidcEnabled: true,
				}),
			);

			expect(result.effective).toEqual({
				nodeEnv: "production",
				trustProxy: true,
				secureCookies: true,
				sessionTtlHours: 12,
				sessionCookieName: "arr_session",
				passwordPolicy: "strict",
				appUrl: "https://arr.example.com",
			});
			expect(result.auth).toEqual({
				passwordEnabled: true,
				passwordUserCount: 1,
				oidcEnabled: true,
				passkeyCount: 0,
			});
		});
	});

	describe("secure cookies + trust proxy", () => {
		it("flags secure cookies without trust proxy as misconfigured (lockout risk)", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: { NODE_ENV: "production", TRUST_PROXY: false, COOKIE_SECURE: true },
				}),
			);

			const check = checkById(result, "secure-cookies");
			expect(check.severity).toBe("misconfigured");
			expect(check.remediation).toBeDefined();
			expect(result.overall).toBe("misconfigured");
		});

		it("auto-derives secureCookies=true from TRUST_PROXY=true when COOKIE_SECURE is unset", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: { TRUST_PROXY: true, COOKIE_SECURE: undefined },
				}),
			);

			expect(result.effective.secureCookies).toBe(true);
			expect(checkById(result, "secure-cookies").severity).toBe("healthy");
		});

		it("warns when secure cookies are disabled in production", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: {
						NODE_ENV: "production",
						TRUST_PROXY: false,
						COOKIE_SECURE: false,
						APP_URL: "https://arr.example.com",
					},
					passkeyCount: 1, // avoid tripping the auth-strength warning
				}),
			);

			const check = checkById(result, "secure-cookies");
			expect(check.severity).toBe("warning");
			expect(result.overall).toBe("warning");
		});

		it("treats insecure cookies as acceptable in development", () => {
			const result = evaluateSecurityPosture(baseInput({ passkeyCount: 1 }));
			expect(checkById(result, "secure-cookies").severity).toBe("healthy");
		});
	});

	describe("authentication posture", () => {
		it("warns on password-only auth and suggests stronger methods", () => {
			const result = evaluateSecurityPosture(baseInput({ oidcEnabled: false, passkeyCount: 0 }));

			const check = checkById(result, "authentication");
			expect(check.severity).toBe("warning");
			expect(check.detail).toContain("Password-only");
		});

		it("marks authentication healthy when OIDC is enabled alongside password", () => {
			const result = evaluateSecurityPosture(baseInput({ oidcEnabled: true }));

			const check = checkById(result, "authentication");
			expect(check.severity).toBe("healthy");
			expect(check.detail).toContain("password");
			expect(check.detail).toContain("OIDC");
		});

		it("marks authentication healthy when passkeys are enrolled", () => {
			const result = evaluateSecurityPosture(baseInput({ passkeyCount: 3 }));

			const check = checkById(result, "authentication");
			expect(check.severity).toBe("healthy");
			expect(check.detail).toContain("3 passkeys");
		});

		it("pluralizes passkeys correctly for a single credential", () => {
			const result = evaluateSecurityPosture(baseInput({ passkeyCount: 1 }));
			expect(checkById(result, "authentication").detail).toContain("1 passkey");
			expect(checkById(result, "authentication").detail).not.toContain("passkeys");
		});

		it("warns when no users exist (setup not completed)", () => {
			const result = evaluateSecurityPosture(
				baseInput({ totalUserCount: 0, passwordUserCount: 0 }),
			);
			expect(checkById(result, "authentication").severity).toBe("warning");
		});

		it("reports misconfigured when users exist but no auth methods are active", () => {
			// Synthetic edge case — guard for a user with hashedPassword=null, no OIDC, no passkeys.
			const result = evaluateSecurityPosture(
				baseInput({ totalUserCount: 1, passwordUserCount: 0, oidcEnabled: false, passkeyCount: 0 }),
			);
			expect(checkById(result, "authentication").severity).toBe("misconfigured");
			expect(result.overall).toBe("misconfigured");
		});
	});

	describe("password policy", () => {
		it("warns when relaxed policy runs in production", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: {
						NODE_ENV: "production",
						PASSWORD_POLICY: "relaxed",
						TRUST_PROXY: true,
						COOKIE_SECURE: true,
						APP_URL: "https://arr.example.com",
					},
					passkeyCount: 1,
				}),
			);
			expect(checkById(result, "password-policy").severity).toBe("warning");
		});

		it("does not warn on relaxed policy in development", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: { PASSWORD_POLICY: "relaxed" },
					passkeyCount: 1,
				}),
			);
			expect(checkById(result, "password-policy").severity).toBe("healthy");
		});
	});

	describe("session TTL", () => {
		it("warns on long-lived sessions in production (>14 days)", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: {
						NODE_ENV: "production",
						SESSION_TTL_HOURS: 24 * 30,
						TRUST_PROXY: true,
						COOKIE_SECURE: true,
						APP_URL: "https://arr.example.com",
					},
					passkeyCount: 1,
				}),
			);
			expect(checkById(result, "session-ttl").severity).toBe("warning");
		});

		it("does not warn on default 24h TTL", () => {
			const result = evaluateSecurityPosture(baseInput({ passkeyCount: 1 }));
			expect(checkById(result, "session-ttl").severity).toBe("healthy");
		});
	});

	describe("app URL", () => {
		it("warns on non-https APP_URL in production", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: {
						NODE_ENV: "production",
						APP_URL: "http://arr.example.com",
						TRUST_PROXY: true,
						COOKIE_SECURE: true,
					},
					passkeyCount: 1,
				}),
			);
			expect(checkById(result, "app-url").severity).toBe("warning");
		});

		it("warns when secure cookies are on but APP_URL is http", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: {
						TRUST_PROXY: true,
						COOKIE_SECURE: true,
						APP_URL: "http://arr.example.com",
					},
					passkeyCount: 1,
				}),
			);
			expect(checkById(result, "app-url").severity).toBe("warning");
		});

		it("handles a malformed APP_URL without throwing", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: { NODE_ENV: "production", APP_URL: "not-a-url" },
					passkeyCount: 1,
				}),
			);
			expect(checkById(result, "app-url").severity).toBe("warning");
		});
	});

	describe("overall severity roll-up", () => {
		it("returns misconfigured when any single check is misconfigured", () => {
			const result = evaluateSecurityPosture(
				baseInput({
					env: { TRUST_PROXY: false, COOKIE_SECURE: true },
					passkeyCount: 1,
				}),
			);
			expect(result.overall).toBe("misconfigured");
		});

		it("returns warning when the worst severity is a warning", () => {
			// Password-only auth fires the warning, nothing else does
			const result = evaluateSecurityPosture(baseInput({ oidcEnabled: false, passkeyCount: 0 }));
			expect(result.overall).toBe("warning");
		});
	});
});
