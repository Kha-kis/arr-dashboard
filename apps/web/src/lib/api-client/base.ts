import type { ApiErrorPayload } from "@arr/shared";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

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

type RequestOptions = RequestInit & { json?: unknown };

const resolveUrl = (path: string): string => {
	if (path.startsWith("http://") || path.startsWith("https://")) {
		return path;
	}
	const base = API_BASE_URL.replace(/\/$/, "");
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${base}${normalizedPath}`;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const { json, headers, ...rest } = options;
	const response = await fetch(resolveUrl(path), {
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

	if (response.status === 401) {
		throw new UnauthorizedError();
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
