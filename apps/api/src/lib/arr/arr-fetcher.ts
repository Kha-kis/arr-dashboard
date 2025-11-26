import type { ServiceInstance } from "@prisma/client";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

interface HasEncryptor {
	encryptor: {
		decrypt: (payload: { value: string; iv: string }) => string;
	};
}

export const createInstanceFetcher = (app: HasEncryptor, instance: ServiceInstance): Fetcher => {
	const apiKey = app.encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});
	const baseUrl = instance.baseUrl.replace(/\/$/, "");

	return async (path: string, init: RequestInit = {}) => {
		const headers: HeadersInit = {
			Accept: "application/json",
			"X-Api-Key": apiKey,
			...(init.headers ?? {}),
		};

		const response = await fetch(`${baseUrl}${path}`, {
			...init,
			headers,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`ARR request failed: ${response.status} ${response.statusText} ${errorText}`.trim(),
			);
		}

		return response;
	};
};

export type InstanceFetcher = ReturnType<typeof createInstanceFetcher>;

/**
 * Create a temporary fetcher for testing connections without database instance
 * Used during service setup to fetch options before saving
 */
export const createTestFetcher = (baseUrl: string, apiKey: string): Fetcher => {
	const cleanBaseUrl = baseUrl.replace(/\/$/, "");

	return async (path: string, init: RequestInit = {}) => {
		const headers: HeadersInit = {
			Accept: "application/json",
			"X-Api-Key": apiKey,
			...(init.headers ?? {}),
		};

		const response = await fetch(`${cleanBaseUrl}${path}`, {
			...init,
			headers,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`ARR request failed: ${response.status} ${response.statusText} ${errorText}`.trim(),
			);
		}

		return response;
	};
};

export type TestFetcher = ReturnType<typeof createTestFetcher>;
