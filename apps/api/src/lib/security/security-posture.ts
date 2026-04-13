/**
 * Pure security-posture evaluator.
 *
 * Takes a snapshot of the effective runtime configuration + auth state and
 * returns a structured set of posture facts + warnings. Designed to be
 * dependency-free so it can be unit-tested without a Fastify/Prisma harness —
 * the route handler is responsible for gathering the inputs.
 *
 * Design notes:
 *   - "Effective" values mean "what is actually being used at runtime", not
 *     "what is stored in the DB settings singleton". The /system/settings
 *     endpoint already models this distinction; we follow the same convention.
 *   - Severity levels map 1:1 to UI StatusBadge variants:
 *       healthy        -> success
 *       warning        -> warning
 *       misconfigured  -> error
 *   - Every check is backed by real app state. No speculative "best-practice"
 *     nudges that aren't tied to a concrete condition we can detect.
 */

export type SecuritySeverity = "healthy" | "warning" | "misconfigured";

export interface SecurityCheck {
	/** Stable machine-readable identifier (kept in sync with UI copy). */
	id: string;
	/** Short human-readable label. */
	label: string;
	/** One-line operational detail explaining the current state. */
	detail: string;
	/** Overall severity of this check. */
	severity: SecuritySeverity;
	/**
	 * Optional remediation hint — a brief, concrete next step. Present only
	 * when severity !== "healthy" and a meaningful action exists.
	 */
	remediation?: string;
}

export interface SecurityPostureInput {
	/** From app.config — effective runtime env, not DB-stored settings. */
	env: {
		NODE_ENV: "development" | "test" | "production";
		TRUST_PROXY: boolean;
		/** Undefined means "auto-derive from TRUST_PROXY". */
		COOKIE_SECURE: boolean | undefined;
		SESSION_TTL_HOURS: number;
		SESSION_COOKIE_NAME: string;
		PASSWORD_POLICY: "strict" | "relaxed";
		APP_URL: string;
	};
	/** True if at least one OIDC provider is enabled. */
	oidcEnabled: boolean;
	/** Total passkey credentials registered across all users. */
	passkeyCount: number;
	/** Count of users with a password set (hashedPassword IS NOT NULL). */
	passwordUserCount: number;
	/** Total user count. */
	totalUserCount: number;
}

export interface SecurityPostureResult {
	/** Computed roll-up severity — the worst severity across all checks. */
	overall: SecuritySeverity;
	/** Individual posture checks. */
	checks: SecurityCheck[];
	/** Effective runtime values surfaced verbatim for the UI. */
	effective: {
		nodeEnv: "development" | "test" | "production";
		trustProxy: boolean;
		secureCookies: boolean;
		sessionTtlHours: number;
		sessionCookieName: string;
		passwordPolicy: "strict" | "relaxed";
		appUrl: string;
	};
	/** Auth-method summary for the UI. */
	auth: {
		passwordEnabled: boolean;
		passwordUserCount: number;
		oidcEnabled: boolean;
		passkeyCount: number;
	};
}

/** Worst-case reducer for the overall roll-up. */
function worstSeverity(checks: SecurityCheck[]): SecuritySeverity {
	if (checks.some((c) => c.severity === "misconfigured")) return "misconfigured";
	if (checks.some((c) => c.severity === "warning")) return "warning";
	return "healthy";
}

export function evaluateSecurityPosture(input: SecurityPostureInput): SecurityPostureResult {
	const effectiveSecureCookies = input.env.COOKIE_SECURE ?? input.env.TRUST_PROXY;
	const isProduction = input.env.NODE_ENV === "production";
	const passwordEnabled = input.passwordUserCount > 0;
	const appUrlProtocol = safeProtocol(input.env.APP_URL);
	const appUrlIsHttps = appUrlProtocol === "https:";

	const checks: SecurityCheck[] = [];

	// ──────────────────────────────────────────────────────────────────────
	// 1. Trust Proxy
	// ──────────────────────────────────────────────────────────────────────
	checks.push({
		id: "trust-proxy",
		label: "Trust Proxy",
		detail: input.env.TRUST_PROXY
			? "Enabled — X-Forwarded-* headers from the reverse proxy are trusted."
			: "Disabled — the app does not trust proxy-forwarded headers.",
		severity: "healthy",
	});

	// ──────────────────────────────────────────────────────────────────────
	// 2. Secure Cookies
	// ──────────────────────────────────────────────────────────────────────
	if (effectiveSecureCookies && !input.env.TRUST_PROXY) {
		// The /system/settings PUT handler already blocks this combo, but the
		// env-var path (COOKIE_SECURE=true + TRUST_PROXY=false) can still produce
		// it. Users get locked out over plain HTTP because the browser refuses
		// to send the Secure cookie.
		checks.push({
			id: "secure-cookies",
			label: "Secure Cookies",
			detail: "Enabled, but Trust Proxy is off — session cookies will not be sent over HTTP.",
			severity: "misconfigured",
			remediation:
				"Enable Trust Proxy (when terminating TLS at a reverse proxy) or set COOKIE_SECURE=false.",
		});
	} else if (effectiveSecureCookies) {
		checks.push({
			id: "secure-cookies",
			label: "Secure Cookies",
			detail: "Enabled — session cookies are only sent over HTTPS.",
			severity: "healthy",
		});
	} else if (isProduction) {
		checks.push({
			id: "secure-cookies",
			label: "Secure Cookies",
			detail: "Disabled in production — session cookies can be intercepted over plain HTTP.",
			severity: "warning",
			remediation: "Enable Trust Proxy behind HTTPS, or set COOKIE_SECURE=true.",
		});
	} else {
		checks.push({
			id: "secure-cookies",
			label: "Secure Cookies",
			detail: "Disabled — acceptable for local development over HTTP.",
			severity: "healthy",
		});
	}

	// ──────────────────────────────────────────────────────────────────────
	// 3. Authentication posture
	// ──────────────────────────────────────────────────────────────────────
	const authMethodCount =
		(passwordEnabled ? 1 : 0) + (input.oidcEnabled ? 1 : 0) + (input.passkeyCount > 0 ? 1 : 0);

	if (input.totalUserCount === 0) {
		checks.push({
			id: "authentication",
			label: "Authentication",
			detail: "No users exist — initial setup has not been completed.",
			severity: "warning",
			remediation: "Complete the initial setup to create an admin account.",
		});
	} else if (authMethodCount === 0) {
		// Shouldn't happen if users exist (setup requires a password), but guard anyway.
		checks.push({
			id: "authentication",
			label: "Authentication",
			detail: "No authentication methods are currently enabled.",
			severity: "misconfigured",
			remediation: "Enable password auth, OIDC, or register a passkey.",
		});
	} else if (passwordEnabled && !input.oidcEnabled && input.passkeyCount === 0) {
		checks.push({
			id: "authentication",
			label: "Authentication",
			detail: "Password-only authentication is in use.",
			severity: "warning",
			remediation: "Consider enrolling a passkey or enabling OIDC for phishing-resistant sign-in.",
		});
	} else {
		checks.push({
			id: "authentication",
			label: "Authentication",
			detail: buildAuthDetail(passwordEnabled, input.oidcEnabled, input.passkeyCount),
			severity: "healthy",
		});
	}

	// ──────────────────────────────────────────────────────────────────────
	// 4. Password policy (informational — only flagged if relaxed in prod)
	// ──────────────────────────────────────────────────────────────────────
	if (input.env.PASSWORD_POLICY === "relaxed" && isProduction) {
		checks.push({
			id: "password-policy",
			label: "Password Policy",
			detail: "Relaxed policy is active in production.",
			severity: "warning",
			remediation: "Set PASSWORD_POLICY=strict to require stronger passwords.",
		});
	} else {
		checks.push({
			id: "password-policy",
			label: "Password Policy",
			detail:
				input.env.PASSWORD_POLICY === "strict"
					? "Strict — 12+ characters with mixed classes required."
					: "Relaxed — acceptable for local development.",
			severity: "healthy",
		});
	}

	// ──────────────────────────────────────────────────────────────────────
	// 5. Session lifetime
	// ──────────────────────────────────────────────────────────────────────
	// The schema clamps TTL at 30 days (720h). Flag anything over 14 days as
	// informational-warning in production — long-lived sessions amplify the
	// blast radius of a stolen cookie.
	const SESSION_TTL_WARN_HOURS = 24 * 14;
	if (isProduction && input.env.SESSION_TTL_HOURS > SESSION_TTL_WARN_HOURS) {
		checks.push({
			id: "session-ttl",
			label: "Session Lifetime",
			detail: `Sessions last ${input.env.SESSION_TTL_HOURS}h — long-lived cookies increase risk if stolen.`,
			severity: "warning",
			remediation: `Reduce SESSION_TTL_HOURS (default 24, current ${input.env.SESSION_TTL_HOURS}).`,
		});
	} else {
		checks.push({
			id: "session-ttl",
			label: "Session Lifetime",
			detail: `Sessions last ${input.env.SESSION_TTL_HOURS}h (HttpOnly, SameSite=Lax).`,
			severity: "healthy",
		});
	}

	// ──────────────────────────────────────────────────────────────────────
	// 6. App URL consistency
	// ──────────────────────────────────────────────────────────────────────
	if (isProduction && !appUrlIsHttps) {
		checks.push({
			id: "app-url",
			label: "App URL",
			detail: `APP_URL uses ${appUrlProtocol ?? "an unrecognized protocol"} in production.`,
			severity: "warning",
			remediation: "Set APP_URL to an https:// origin so OIDC redirect URIs and links are secure.",
		});
	} else if (effectiveSecureCookies && !appUrlIsHttps) {
		checks.push({
			id: "app-url",
			label: "App URL",
			detail: "Secure cookies are enabled but APP_URL is not https — clients may fail to log in.",
			severity: "warning",
			remediation: "Update APP_URL to match the public https:// origin.",
		});
	} else {
		checks.push({
			id: "app-url",
			label: "App URL",
			detail: `${input.env.APP_URL}`,
			severity: "healthy",
		});
	}

	const effective = {
		nodeEnv: input.env.NODE_ENV,
		trustProxy: input.env.TRUST_PROXY,
		secureCookies: effectiveSecureCookies,
		sessionTtlHours: input.env.SESSION_TTL_HOURS,
		sessionCookieName: input.env.SESSION_COOKIE_NAME,
		passwordPolicy: input.env.PASSWORD_POLICY,
		appUrl: input.env.APP_URL,
	};

	return {
		overall: worstSeverity(checks),
		checks,
		effective,
		auth: {
			passwordEnabled,
			passwordUserCount: input.passwordUserCount,
			oidcEnabled: input.oidcEnabled,
			passkeyCount: input.passkeyCount,
		},
	};
}

function buildAuthDetail(password: boolean, oidc: boolean, passkeys: number): string {
	const parts: string[] = [];
	if (password) parts.push("password");
	if (oidc) parts.push("OIDC");
	if (passkeys > 0) parts.push(`${passkeys} passkey${passkeys === 1 ? "" : "s"}`);
	return `Active methods: ${parts.join(", ")}.`;
}

function safeProtocol(url: string): string | null {
	try {
		return new URL(url).protocol;
	} catch {
		return null;
	}
}
