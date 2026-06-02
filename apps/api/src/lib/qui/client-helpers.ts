import type { FastifyBaseLogger } from "fastify";
import type { ZodType } from "zod";
import { QuiApiError, QuiInstanceUnreachableError } from "../errors.js";

/**
 * Default request timeout for qui calls. qui caches reads at its own
 * sync-manager layer, so most calls return well under a second; the
 * 10-second budget is generous head-room for cold caches.
 */
export const DEFAULT_QUI_TIMEOUT_MS = 10_000;

export interface QuiRequestContext {
	instanceId: string;
	baseUrl: string;
	apiKey: string;
	log: FastifyBaseLogger;
	timeoutMs?: number;
}

/**
 * Issue a request to qui and validate the response with the supplied
 * Zod schema. Errors are normalised:
 *  - network/timeout → QuiInstanceUnreachableError (HTTP 503)
 *  - 4xx/5xx HTTP   → QuiApiError (status mapped per CLAUDE.md error convention)
 *  - shape drift    → QuiApiError(502)
 *
 * Validation lives at this boundary so handlers receive already-typed
 * data — never `unknown` — and shape drift between qui versions surfaces
 * loudly during PR review rather than silently breaking UI fields.
 */
export async function quiRequest<T>(
	ctx: QuiRequestContext,
	path: string,
	schema: ZodType<T>,
	init?: {
		method?: string;
		query?: Record<string, string>;
		body?: unknown;
		/**
		 * Per-call timeout override. Resolves in this order:
		 *   init.timeoutMs → ctx.timeoutMs → DEFAULT_QUI_TIMEOUT_MS.
		 * Used by `listAllTorrents` (which paginates and can legitimately
		 * exceed the default 10s budget on slow qui responses) without
		 * widening every other call's timeout.
		 */
		timeoutMs?: number;
	},
): Promise<T> {
	const url = buildUrl(ctx.baseUrl, path, init?.query);
	const timeoutMs = init?.timeoutMs ?? ctx.timeoutMs ?? DEFAULT_QUI_TIMEOUT_MS;

	let response: Response;
	try {
		response = await fetch(url, {
			method: init?.method ?? "GET",
			headers: {
				"X-API-Key": ctx.apiKey,
				Accept: "application/json",
				...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new QuiInstanceUnreachableError(ctx.instanceId, {
			reason: describeNetworkError(error),
			cause: error,
		});
	}

	if (!response.ok) {
		const message = await readErrorMessage(response);
		ctx.log.warn(
			{ instanceId: ctx.instanceId, path, status: response.status, message },
			"qui request failed",
		);
		throw new QuiApiError(`qui request to ${path} failed: ${message}`, {
			upstreamStatus: response.status,
		});
	}

	const json = await response.json().catch((cause) => {
		throw new QuiApiError(`qui returned non-JSON response from ${path}`, {
			upstreamStatus: response.status,
			statusCodeOverride: 502,
			cause,
		});
	});

	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		ctx.log.warn(
			{ instanceId: ctx.instanceId, path, issues: parsed.error.issues.slice(0, 5) },
			"qui response shape drift",
		);
		throw new QuiApiError(`qui response from ${path} did not match expected shape`, {
			upstreamStatus: response.status,
			statusCodeOverride: 502,
			cause: parsed.error,
		});
	}

	return parsed.data;
}

/**
 * Issue a HEAD/GET to qui's `/health` endpoint to confirm reachability
 * + auth. Returns a discriminated result rather than throwing — used by
 * the connection tester surface where "not reachable" is an expected
 * outcome, not an error.
 */
export async function quiHealthProbe(
	ctx: QuiRequestContext,
): Promise<{ ok: true; status: number } | { ok: false; reason: string }> {
	const url = buildUrl(ctx.baseUrl, "/health");
	const timeoutMs = ctx.timeoutMs ?? DEFAULT_QUI_TIMEOUT_MS;

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { "X-API-Key": ctx.apiKey, Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			return { ok: false, reason: `qui returned HTTP ${response.status}` };
		}
		return { ok: true, status: response.status };
	} catch (error) {
		return { ok: false, reason: describeNetworkError(error) };
	}
}

/**
 * Safe hostname extraction from a qBit announce URL.
 *
 * Private-tracker announce URLs include a passkey in the path or query
 * (`tracker.beyond-hd.me:2053/announce/PASSKEY` or
 * `hdbits.org/announce.php?passkey=PASSKEY`). The passkey is equivalent
 * to login credentials — leaking it in an API response or log would
 * compromise the user's tracker account.
 *
 * Returns ONLY the hostname; discards path, query, fragment, userinfo.
 * Empty string on parse failure — better to lose tracker identification
 * than to risk passkey exposure.
 *
 * Single source of truth for tracker-identity stripping across the qui
 * integration: the library-seeding summary, torrent trackers list, and
 * cross-seed match transform all funnel through here.
 */
export function extractHostnameSafe(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
	const trimmed = baseUrl.replace(/\/$/, "");
	const url = new URL(`${trimmed}${path.startsWith("/") ? path : `/${path}`}`);
	if (query) {
		for (const [k, v] of Object.entries(query)) {
			url.searchParams.set(k, v);
		}
	}
	return url.toString();
}

async function readErrorMessage(response: Response): Promise<string> {
	const fallback = `${response.status} ${response.statusText}`;
	try {
		const text = await response.text();
		if (!text) return fallback;
		try {
			const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
			const msg = parsed.message ?? parsed.error;
			if (typeof msg === "string" && msg.length > 0) return msg;
		} catch {
			// Not JSON — handle HTML separately, then plaintext fallback.
		}
		// Detect HTML responses (nginx error pages, auth proxy challenges,
		// Cloudflare 403s) and synthesize a clean message rather than
		// leaking the raw markup into toasts and the qui Activity surface.
		const trimmed = text.trimStart();
		if (isHtmlLikeResponse(trimmed)) {
			const title = extractHtmlTitle(trimmed);
			return title
				? `${fallback} — upstream HTML page (title: "${title}"). Likely an auth proxy or reverse-proxy error page in front of qui. Use the service's internal/LAN URL or configure your proxy to bypass /api/*.`
				: `${fallback} — upstream returned HTML (probable auth proxy fronting qui). Use the internal/LAN URL or bypass /api/* in your proxy.`;
		}
		return text.slice(0, 200);
	} catch {
		return fallback;
	}
}

/** True when `text` begins with a recognizable HTML/XML tag opener. */
function isHtmlLikeResponse(text: string): boolean {
	const prefix = text.slice(0, 16).toLowerCase();
	return prefix.startsWith("<!doctype") || prefix.startsWith("<html") || prefix.startsWith("<?xml");
}

/** Extract `<title>...</title>` content from an HTML response body. */
function extractHtmlTitle(html: string): string | null {
	const match = /<title>\s*([^<]{1,120})\s*<\/title>/i.exec(html);
	return match?.[1]?.trim() ?? null;
}

function describeNetworkError(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") {
			return "qui request timed out";
		}
		const code = (error as { cause?: { code?: string } }).cause?.code;
		if (code === "ECONNREFUSED") return "qui connection refused";
		if (code === "ENOTFOUND") return "qui hostname not found";
		if (code === "ETIMEDOUT") return "qui connection timed out";
		return error.message || "qui request failed";
	}
	return "qui request failed";
}
