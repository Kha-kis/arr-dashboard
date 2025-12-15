import type { ServiceInstance } from "@prisma/client";
import { API_TIMEOUT_MS, API_USER_AGENT } from "../hunting/constants.js";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

interface HasEncryptor {
	encryptor: {
		decrypt: (payload: { value: string; iv: string }) => string;
	};
}

/**
 * Core fetcher factory - creates a fetcher with the given baseUrl and apiKey
 * Includes consistent timeout and User-Agent for all requests
 */
const createFetcher = (baseUrl: string, apiKey: string): Fetcher => {
	const cleanBaseUrl = baseUrl.replace(/\/$/, "");

	return async (path: string, init: RequestInit = {}) => {
		const headers: HeadersInit = {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Api-Key": apiKey,
			"User-Agent": API_USER_AGENT,
			...(init.headers ?? {}),
		};

		// Create AbortController for timeout, wired to preserve caller's signal
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

		// Wire caller's signal to our controller so external cancellation works
		const callerSignal = init.signal;
		let callerAbortHandler: (() => void) | undefined;

		if (callerSignal) {
			if (callerSignal.aborted) {
				// Caller's signal already aborted - abort immediately
				controller.abort();
			} else {
				// Listen for caller's abort and propagate to our controller
				callerAbortHandler = () => controller.abort();
				callerSignal.addEventListener("abort", callerAbortHandler);
			}
		}

		try {
			const response = await fetch(`${cleanBaseUrl}${path}`, {
				...init,
				headers,
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				throw new Error(
					`ARR request failed: ${response.status} ${response.statusText} ${errorText}`.trim(),
				);
			}

			return response;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`ARR request timed out after ${API_TIMEOUT_MS / 1000}s`);
			}
			throw error;
		} finally {
			// Clean up to avoid memory leaks
			clearTimeout(timeoutId);
			if (callerSignal && callerAbortHandler) {
				callerSignal.removeEventListener("abort", callerAbortHandler);
			}
		}
	};
};

/**
 * Create a fetcher for a stored service instance (decrypts API key from database)
 */
export const createInstanceFetcher = (app: HasEncryptor, instance: ServiceInstance): Fetcher => {
	const apiKey = app.encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});
	return createFetcher(instance.baseUrl, apiKey);
};

export type InstanceFetcher = ReturnType<typeof createInstanceFetcher>;

/**
 * Create a temporary fetcher for testing connections without database instance
 * Used during service setup to fetch options before saving
 */
export const createTestFetcher = (baseUrl: string, apiKey: string): Fetcher =>
	createFetcher(baseUrl, apiKey);

export type TestFetcher = ReturnType<typeof createTestFetcher>;
