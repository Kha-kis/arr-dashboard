import type { ApiErrorPayload } from "@arr/shared";
import { reportProtectedUnauthorized } from "../auth-session-signal";
import { getErrorMessage } from "../error-utils";

export class ApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly payload?: ApiErrorPayload,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export class UnauthorizedError extends ApiError {
	constructor(message = "Unauthorized") {
		super(message, 401);
		this.name = "UnauthorizedError";
	}
}

export class BadRequestError extends ApiError {
	constructor(message = "Bad Request", payload?: ApiErrorPayload) {
		super(message, 400, payload);
		this.name = "BadRequestError";
	}
}

export class NetworkError extends Error {
	constructor(message = "Cannot connect to API server") {
		super(message);
		this.name = "NetworkError";
	}
}

export class InvalidSuccessResponseError extends Error {
	constructor() {
		super("Request acknowledgment could not be verified.");
		this.name = "InvalidSuccessResponseError";
	}
}

type RequestOptions = RequestInit & {
	json?: unknown;
	expectedSuccessStatus?: number;
	requireJsonSuccess?: boolean;
};

const resolveUrl = (path: string): string => {
	if (path.startsWith("http://") || path.startsWith("https://")) {
		return path;
	}
	// Paths like /auth/* and /api/* are proxied by Next.js middleware
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return normalizedPath;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const {
		json,
		headers,
		body,
		method: requestedMethod,
		expectedSuccessStatus,
		requireJsonSuccess,
		...rest
	} = options;
	const method = requestedMethod ?? (json !== undefined ? "POST" : "GET");
	// Next.js may forward a body-less POST with chunked transfer encoding. Fastify
	// then sees a request body without a media type and rejects it before the route
	// handler runs. Give no-payload POST actions an explicit JSON representation.
	const sendsEmptyJson =
		method.toUpperCase() === "POST" && json === undefined && body === undefined;
	const sendsJson = json !== undefined || sendsEmptyJson;
	const jsonPayload = json !== undefined ? json : {};

	let response: Response;
	try {
		response = await fetch(resolveUrl(path), {
			method,
			credentials: "include",
			headers: {
				Accept: "application/json",
				...(sendsJson ? { "Content-Type": "application/json" } : {}),
				...headers,
			},
			body: sendsJson ? JSON.stringify(jsonPayload) : body,
			...rest,
		});
	} catch (error) {
		// Network error (API unreachable, CORS, etc.)
		throw new NetworkError(
			`Cannot connect to API server: ${getErrorMessage(error, "unknown error")}`,
		);
	}

	if (response.status === 401) {
		const publicOidcRequest =
			path === "/auth/oidc/providers" ||
			path === "/auth/oidc/setup" ||
			(path === "/auth/oidc/login" &&
				(json === undefined ||
					(typeof json === "object" &&
						json !== null &&
						"intent" in json &&
						json.intent === "login")));
		if (
			path !== "/auth/me" &&
			path !== "/auth/setup-required" &&
			path !== "/auth/login" &&
			!path.startsWith("/auth/passkey/login/") &&
			!publicOidcRequest
		) {
			reportProtectedUnauthorized();
		}
		throw new UnauthorizedError();
	}

	if (response.status === 400) {
		const contentType = response.headers.get("content-type");
		const errorPayload =
			contentType && contentType.includes("application/json")
				? await response.json().catch(() => undefined)
				: await response.text();
		const message =
			errorPayload &&
			typeof errorPayload === "object" &&
			"message" in errorPayload &&
			typeof errorPayload.message === "string"
				? errorPayload.message
				: "Bad Request";
		throw new BadRequestError(message, errorPayload);
	}

	// Only opting-in actions impose a precise success contract. Do not consume
	// or retain an unexpected successful body's private diagnostic content.
	if (
		response.ok &&
		expectedSuccessStatus !== undefined &&
		response.status !== expectedSuccessStatus
	) {
		throw new Error("Request acknowledgment could not be verified.");
	}

	if (response.status === 204) {
		return undefined as T;
	}

	const contentType = response.headers.get("content-type");
	if (response.ok && requireJsonSuccess) {
		if (!contentType?.includes("application/json")) throw new InvalidSuccessResponseError();
		try {
			return (await response.json()) as T;
		} catch {
			throw new InvalidSuccessResponseError();
		}
	}
	const payload =
		contentType && contentType.includes("application/json")
			? await response.json().catch(() => undefined)
			: await response.text();

	const resolveErrorMessage = () => {
		if (
			payload &&
			typeof payload === "object" &&
			"message" in payload &&
			typeof (payload as Record<string, unknown>).message === "string"
		) {
			return (payload as Record<string, unknown>).message as string;
		}

		if (
			payload &&
			typeof payload === "object" &&
			"error" in payload &&
			typeof (payload as Record<string, unknown>).error === "string"
		) {
			return (payload as Record<string, unknown>).error as string;
		}

		if (typeof payload === "string" && payload.trim().length > 0) {
			return payload;
		}

		return response.statusText || "Request failed";
	};

	if (!response.ok) {
		throw new ApiError(resolveErrorMessage(), response.status, payload as ApiErrorPayload);
	}

	return payload as T;
}
