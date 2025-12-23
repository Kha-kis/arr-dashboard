/**
 * ARR SDK Client Factory
 *
 * Provides type-safe, request-scoped client creation for Sonarr, Radarr, and Prowlarr.
 * Follows security best practices:
 * - Decrypts API keys on-demand (not cached)
 * - Clients are garbage collected after request completes
 * - Centralized error logging without exposing secrets
 */

import {
	SonarrClient,
	RadarrClient,
	ProwlarrClient,
	type ClientConfig,
	ArrError,
	NotFoundError,
	UnauthorizedError,
	ValidationError,
	TimeoutError,
	NetworkError,
} from "arr-sdk";
import type { ServiceInstance, ServiceType } from "@prisma/client";
import type { Encryptor } from "../auth/encryption.js";

// Re-export error types for convenience
export {
	ArrError,
	NotFoundError,
	UnauthorizedError,
	ValidationError,
	TimeoutError,
	NetworkError,
};

// ============================================================================
// Types
// ============================================================================

/**
 * Union type of all ARR SDK clients
 */
export type ArrClient = SonarrClient | RadarrClient | ProwlarrClient;

/**
 * Map service type to its corresponding SDK client type
 */
export type ClientForService<T extends ServiceType> = T extends "SONARR"
	? SonarrClient
	: T extends "RADARR"
		? RadarrClient
		: T extends "PROWLARR"
			? ProwlarrClient
			: never;

/**
 * Options for client creation
 */
export interface ClientFactoryOptions {
	/** Request timeout in milliseconds (default: 30000) */
	timeout?: number;
	/** Optional callback for error logging */
	onError?: (error: ArrError, instance: ServiceInstance) => void;
	/** Optional callback before each request */
	onRequest?: (config: { url: URL; method: string }) => void;
}

/**
 * Instance data required for client creation
 * Can be a full ServiceInstance or minimal required fields
 */
export interface ClientInstanceData {
	id: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	service: ServiceType;
	label?: string;
}

// ============================================================================
// Factory Implementation
// ============================================================================

/**
 * Factory for creating ARR SDK clients with encrypted API key handling.
 *
 * This factory is stateless and creates fresh clients on each call.
 * Clients are request-scoped and should be garbage collected after use.
 *
 * @example
 * ```typescript
 * // In Fastify plugin
 * app.decorate('arrClientFactory', new ArrClientFactory(app.encryptor));
 *
 * // In route handler
 * const client = app.arrClientFactory.createSonarrClient(instance);
 * const series = await client.series.getAll();
 * ```
 */
export class ArrClientFactory {
	private readonly encryptor: Encryptor;
	private readonly defaultTimeout: number;

	constructor(encryptor: Encryptor, defaultTimeout = 30_000) {
		this.encryptor = encryptor;
		this.defaultTimeout = defaultTimeout;
	}

	/**
	 * Create a type-safe client for the given service instance.
	 * Automatically returns the correct client type based on service type.
	 */
	create<T extends ServiceType>(
		instance: ClientInstanceData & { service: T },
		options?: ClientFactoryOptions,
	): ClientForService<T> {
		const config = this.buildConfig(instance, options);

		switch (instance.service) {
			case "SONARR":
				return new SonarrClient(config) as ClientForService<T>;
			case "RADARR":
				return new RadarrClient(config) as ClientForService<T>;
			case "PROWLARR":
				return new ProwlarrClient(config) as ClientForService<T>;
			default: {
				const exhaustiveCheck: never = instance.service;
				throw new Error(`Unknown service type: ${exhaustiveCheck}`);
			}
		}
	}

	/**
	 * Create a Sonarr client (explicit typing)
	 */
	createSonarrClient(
		instance: ClientInstanceData,
		options?: ClientFactoryOptions,
	): SonarrClient {
		if (instance.service !== "SONARR") {
			throw new Error(
				`Expected SONARR instance, got ${instance.service}`,
			);
		}
		return new SonarrClient(this.buildConfig(instance, options));
	}

	/**
	 * Create a Radarr client (explicit typing)
	 */
	createRadarrClient(
		instance: ClientInstanceData,
		options?: ClientFactoryOptions,
	): RadarrClient {
		if (instance.service !== "RADARR") {
			throw new Error(
				`Expected RADARR instance, got ${instance.service}`,
			);
		}
		return new RadarrClient(this.buildConfig(instance, options));
	}

	/**
	 * Create a Prowlarr client (explicit typing)
	 */
	createProwlarrClient(
		instance: ClientInstanceData,
		options?: ClientFactoryOptions,
	): ProwlarrClient {
		if (instance.service !== "PROWLARR") {
			throw new Error(
				`Expected PROWLARR instance, got ${instance.service}`,
			);
		}
		return new ProwlarrClient(this.buildConfig(instance, options));
	}

	/**
	 * Create any ARR client (when service type is dynamic)
	 */
	createAnyClient(
		instance: ClientInstanceData,
		options?: ClientFactoryOptions,
	): ArrClient {
		return this.create(instance, options);
	}

	/**
	 * Build client configuration with decrypted API key
	 */
	private buildConfig(
		instance: ClientInstanceData,
		options?: ClientFactoryOptions,
	): ClientConfig {
		// Decrypt API key on-demand (not cached)
		const apiKey = this.encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});

		const config: ClientConfig = {
			baseUrl: instance.baseUrl.replace(/\/$/, ""),
			apiKey,
			timeout: options?.timeout ?? this.defaultTimeout,
		};

		// Add error callback if provided
		if (options?.onError) {
			config.onError = (error: Error) => {
				if (error instanceof ArrError) {
					options.onError?.(error, instance as ServiceInstance);
				}
			};
		}

		// Add request callback if provided
		if (options?.onRequest) {
			config.onRequest = options.onRequest;
		}

		return config;
	}
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Type guard to check if an error is an ARR SDK error
 */
export function isArrError(error: unknown): error is ArrError {
	return error instanceof ArrError;
}

/**
 * Type guard for not found errors (404)
 */
export function isNotFoundError(error: unknown): error is NotFoundError {
	return error instanceof NotFoundError;
}

/**
 * Type guard for unauthorized errors (401)
 */
export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
	return error instanceof UnauthorizedError;
}

/**
 * Type guard for validation errors (400)
 */
export function isValidationError(error: unknown): error is ValidationError {
	return error instanceof ValidationError;
}

/**
 * Type guard for timeout errors
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
	return error instanceof TimeoutError;
}

/**
 * Type guard for network errors
 */
export function isNetworkError(error: unknown): error is NetworkError {
	return error instanceof NetworkError;
}

/**
 * Convert ARR SDK error to HTTP status code
 */
export function arrErrorToHttpStatus(error: ArrError): number {
	if (error instanceof NotFoundError) return 404;
	if (error instanceof UnauthorizedError) return 401;
	if (error instanceof ValidationError) return 400;
	if (error instanceof TimeoutError) return 504;
	if (error instanceof NetworkError) return 502;
	return error.statusCode || 500;
}

/**
 * Create a standardized error response from ARR SDK error
 */
export function arrErrorToResponse(error: ArrError): {
	success: false;
	error: string;
	code: string;
	details?: unknown;
} {
	return {
		success: false,
		error: error.message,
		code: error.constructor.name,
		details: error instanceof ValidationError ? error.validationErrors : undefined,
	};
}
