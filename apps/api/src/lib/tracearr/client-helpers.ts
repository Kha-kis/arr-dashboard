import type { FastifyBaseLogger } from "fastify";
import type { ZodType } from "zod";
import { TracearrApiError, TracearrInstanceUnreachableError } from "../errors.js";

/**
 * Base path all Tracearr Public API endpoints hang off. Kept as a single
 * constant so `baseUrl` stored on the ServiceInstance is just the host
 * origin (e.g. `http://tracearr:3000`) — the operator never types the
 * `/api/v1/public` suffix, matching how the *arr clients own their
 * `/api/v3` prefix internally.
 */
export const TRACEARR_PUBLIC_API_BASE = "/api/v1/public";

/**
 * Default request timeout for Tracearr calls. Tracearr serves the public
 * API from its own cache/DB layer, so reads return quickly; 10s is generous
 * head-room for a cold instance.
 */
export const DEFAULT_TRACEARR_TIMEOUT_MS = 10_000;

export interface TracearrRequestContext {
	instanceId: string;
	/** Host origin only (no `/api/v1/public` suffix — this module adds it). */
	baseUrl: string;
	/** The `trr_pub_...` Public API key, sent as `Authorization: Bearer`. */
	apiKey: string;
	log: FastifyBaseLogger;
	timeoutMs?: number;
}

/**
 * Issue a request to a Tracearr instance and validate the response with the
 * supplied Zod schema. Errors are normalised the same way as the qui client:
 *  - network/timeout → TracearrInstanceUnreachableError (HTTP 503)
 *  - 4xx/5xx HTTP    → TracearrApiError (status mapped per CLAUDE.md convention)
 *  - shape drift     → TracearrApiError(502)
 *
 * Validation lives at this boundary so handlers receive already-typed data,
 * never `unknown`. `path` is relative to the Public API base (e.g. `/health`,
 * `/streams`) — the base + host origin are joined here.
 */
export async function tracearrRequest<T>(
	ctx: TracearrRequestContext,
	path: string,
	schema: ZodType<T>,
	init?: {
		method?: string;
		query?: Record<string, string | number | boolean | undefined>;
		body?: unknown;
		timeoutMs?: number;
	},
): Promise<T> {
	const url = buildUrl(ctx.baseUrl, path, init?.query);
	const timeoutMs = init?.timeoutMs ?? ctx.timeoutMs ?? DEFAULT_TRACEARR_TIMEOUT_MS;

	let response: Response;
	try {
		response = await fetch(url, {
			method: init?.method ?? "GET",
			headers: {
				Authorization: `Bearer ${ctx.apiKey}`,
				Accept: "application/json",
				...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new TracearrInstanceUnreachableError(ctx.instanceId, {
			reason: describeNetworkError(error),
			cause: error,
		});
	}

	if (!response.ok) {
		const message = await readErrorMessage(response);
		ctx.log.warn(
			{ instanceId: ctx.instanceId, path, status: response.status, message },
			"tracearr request failed",
		);
		throw new TracearrApiError(`tracearr request to ${path} failed: ${message}`, {
			upstreamStatus: response.status,
		});
	}

	const json = await response.json().catch((cause) => {
		throw new TracearrApiError(`tracearr returned non-JSON response from ${path}`, {
			upstreamStatus: response.status,
			statusCodeOverride: 502,
			cause,
		});
	});

	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		ctx.log.warn(
			{ instanceId: ctx.instanceId, path, issues: parsed.error.issues.slice(0, 5) },
			"tracearr response shape drift",
		);
		throw new TracearrApiError(`tracearr response from ${path} did not match expected shape`, {
			upstreamStatus: response.status,
			statusCodeOverride: 502,
			cause: parsed.error,
		});
	}

	return parsed.data;
}

/**
 * Probe Tracearr's `/health` endpoint to confirm reachability + auth.
 * Returns a discriminated result rather than throwing — used by the
 * connection tester where "not reachable" is an expected outcome. The
 * caller supplies the server count for a friendlier success message.
 */
export async function tracearrHealthProbe(
	ctx: Omit<TracearrRequestContext, "log">,
): Promise<
	| { ok: true; status: number; version?: string; serverCount: number }
	| { ok: false; reason: string }
> {
	const url = buildUrl(ctx.baseUrl, "/health");
	const timeoutMs = ctx.timeoutMs ?? DEFAULT_TRACEARR_TIMEOUT_MS;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${ctx.apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		return { ok: false, reason: describeNetworkError(error) };
	}

	if (!response.ok) {
		return { ok: false, reason: `Tracearr returned HTTP ${response.status}` };
	}

	// Best-effort enrichment: pull version + server count for the message.
	// A malformed body still counts as reachable+authed (2xx) — we just
	// drop the extras rather than failing the probe.
	let version: string | undefined;
	let serverCount = 0;
	try {
		const body = (await response.json()) as {
			version?: unknown;
			servers?: unknown;
		};
		if (typeof body.version === "string") version = body.version;
		if (Array.isArray(body.servers)) serverCount = body.servers.length;
	} catch {
		// non-JSON 2xx — reachable, extras unavailable
	}

	return { ok: true, status: response.status, version, serverCount };
}

/** Join host origin + Public API base + endpoint path + query params. */
function buildUrl(
	baseUrl: string,
	path: string,
	query?: Record<string, string | number | boolean | undefined>,
): string {
	const origin = baseUrl.replace(/\/$/, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	const url = new URL(`${origin}${TRACEARR_PUBLIC_API_BASE}${suffix}`);
	if (query) {
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined) url.searchParams.set(k, String(v));
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
			// Not JSON — fall through to plaintext/HTML handling.
		}
		const trimmed = text.trimStart();
		if (isHtmlLikeResponse(trimmed)) {
			return `${fallback} — upstream returned HTML (probable auth proxy in front of Tracearr). Use the internal/LAN URL or bypass /api/* in your proxy.`;
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

function describeNetworkError(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") {
			return "Tracearr request timed out";
		}
		const code = (error as { cause?: { code?: string } }).cause?.code;
		if (code === "ECONNREFUSED") return "Tracearr connection refused";
		if (code === "ENOTFOUND") return "Tracearr hostname not found";
		if (code === "ETIMEDOUT") return "Tracearr connection timed out";
		return error.message || "Tracearr request failed";
	}
	return "Tracearr request failed";
}
