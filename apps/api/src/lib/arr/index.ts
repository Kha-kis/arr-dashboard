/**
 * ARR SDK Integration
 *
 * This module provides type-safe, request-scoped clients for
 * Sonarr, Radarr, and Prowlarr APIs.
 *
 * @example
 * ```typescript
 * // In route handlers, use the factory directly:
 * const client = app.arrClientFactory.createSonarrClient(instance);
 * const series = await client.series.getAll();
 *
 * // Or use helpers for common patterns:
 * const results = await executeOnSonarrInstances(app, userId, async (client) => {
 *   return client.series.getAll();
 * });
 * ```
 */

// Factory and core types
export {
	ArrClientFactory,
	type ArrClient,
	type ClientForService,
	type ClientFactoryOptions,
	type ClientInstanceData,
} from "./client-factory.js";

// Error types and utilities
export {
	ArrError,
	NotFoundError,
	UnauthorizedError,
	ValidationError,
	TimeoutError,
	NetworkError,
	isArrError,
	isNotFoundError,
	isUnauthorizedError,
	isValidationError,
	isTimeoutError,
	isNetworkError,
	arrErrorToHttpStatus,
	arrErrorToResponse,
} from "./client-factory.js";

// Helper utilities
export {
	toServiceLabel,
	executeOnInstances,
	executeOnSonarrInstances,
	executeOnRadarrInstances,
	executeOnProwlarrInstances,
	getClientForInstance,
	getSonarrClientForInstance,
	getRadarrClientForInstance,
	getProwlarrClientForInstance,
	isSonarrClient,
	isRadarrClient,
	isProwlarrClient,
	type InstanceResult,
	type InstanceError,
	type InstanceOperationResult,
	type MultiInstanceResponse,
	type MultiInstanceOptions,
} from "./client-helpers.js";

// Re-export SDK client types for convenience
export { SonarrClient, RadarrClient, ProwlarrClient } from "arr-sdk";
