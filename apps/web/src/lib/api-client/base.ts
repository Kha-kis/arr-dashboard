import type { ApiErrorPayload } from "@arr/shared";
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
	constructor(message = "Bad Request") {
		super(message, 400);
		this.name = "BadRequestError";
	}
}

export class NetworkError extends Error {
	constructor(message = "Cannot connect to API server") {
		super(message);
		this.name = "NetworkError";
	}
}

type RequestOptions = RequestInit & { json?: unknown };

const resolveUrl = (path: string): string => {
	if (path.startsWith("http://") || path.startsWith("https://")) {
		return path;
	}
	// Paths like /auth/* and /api/* are proxied by Next.js middleware
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return normalizedPath;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const { json, headers, ...rest } = options;

	let response: Response;
	try {
		response = await fetch(resolveUrl(path), {
			method: json ? "POST" : (options.method ?? "GET"),
			credentials: "include",
			headers: {
				Accept: "application/json",
				...(json ? { "Content-Type": "application/json" } : {}),
				...headers,
			},
			body: json ? JSON.stringify(json) : options.body,
			...rest,
		});
	} catch (error) {
		// Network error (API unreachable, CORS, etc.)
		throw new NetworkError(
			`Cannot connect to API server: ${getErrorMessage(error, "unknown error")}`
		);
	}

	if (response.status === 401) {
		throw new UnauthorizedError();
	}

	if (response.status === 400) {
		const contentType = response.headers.get("content-type");
		const errorPayload =
			contentType && contentType.includes("application/json")
				? await response.json().catch(() => undefined)
				: await response.text();
		const message =
			errorPayload && typeof errorPayload === "object" && "message" in errorPayload
				? (errorPayload as { message: string }).message
				: "Bad Request";
		throw new BadRequestError(message);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	const contentType = response.headers.get("content-type");
	const payload =
		contentType && contentType.includes("application/json")
			? await response.json().catch(() => undefined)
			: await response.text();

	const resolveErrorMessage = () => {
		if (
			payload &&
			typeof payload === "object" &&
			"message" in payload &&
			typeof (payload as any).message === "string"
		) {
			return (payload as any).message as string;
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
