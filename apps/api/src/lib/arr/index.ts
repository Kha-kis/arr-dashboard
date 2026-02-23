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

// Re-export SDK client types for convenience
export { ProwlarrClient, RadarrClient, SonarrClient } from "arr-sdk";
// Factory and core types
// Error types and utilities
export {
	type ArrClient,
	ArrClientFactory,
	ArrError,
	arrErrorToHttpStatus,
	arrErrorToResponse,
	type ClientFactoryOptions,
	type ClientForService,
	type ClientInstanceData,
	isArrError,
	isNetworkError,
	isNotFoundError,
	isTimeoutError,
	isUnauthorizedError,
	isValidationError,
	NetworkError,
	NotFoundError,
	TimeoutError,
	UnauthorizedError,
	ValidationError,
} from "./client-factory.js";
// Helper utilities
export {
	executeOnInstances,
	executeOnProwlarrInstances,
	executeOnRadarrInstances,
	executeOnSonarrInstances,
	getClientForInstance,
	getProwlarrClientForInstance,
	getRadarrClientForInstance,
	getSonarrClientForInstance,
	type InstanceError,
	type InstanceOperationResult,
	type InstanceResult,
	isProwlarrClient,
	isRadarrClient,
	isSonarrClient,
	type MultiInstanceOptions,
	type MultiInstanceResponse,
	toServiceLabel,
} from "./client-helpers.js";
