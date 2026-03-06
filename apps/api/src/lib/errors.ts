/** Thrown when a service instance is not found or user lacks access. Maps to HTTP 404. */
export class InstanceNotFoundError extends Error {
	readonly statusCode = 404;
	constructor(public readonly instanceId: string) {
		super("Instance not found or access denied");
		this.name = "InstanceNotFoundError";
	}
}

/** Thrown when a trash template is not found or user lacks access. Maps to HTTP 404. */
export class TemplateNotFoundError extends Error {
	readonly statusCode = 404;
	constructor(public readonly templateId: string) {
		super("Template not found or access denied");
		this.name = "TemplateNotFoundError";
	}
}

/** Thrown when creating a resource that already exists. Maps to HTTP 409. */
export class ConflictError extends Error {
	readonly statusCode = 409;
	constructor(message: string) {
		super(message);
		this.name = "ConflictError";
	}
}

/** Thrown for application-level validation failures. Maps to HTTP 400. */
export class AppValidationError extends Error {
	readonly statusCode = 400;
	constructor(message: string) {
		super(message);
		this.name = "AppValidationError";
	}
}

/**
 * Thrown when a Seerr API call fails.
 * - `seerrStatus`: the HTTP status returned by the Seerr instance
 * - `retryable`: true for 429 and 5xx; false for 4xx
 * - `retryAfterMs`: parsed Retry-After value (only on 429)
 * - `statusCode`: the HTTP status to return to *our* client
 *   (401/403/404/429 pass-through; 5xx → 502 Bad Gateway; timeout → 504)
 */
export class SeerrApiError extends Error {
	readonly statusCode: number;
	readonly seerrStatus: number;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;

	constructor(
		message: string,
		opts: {
			seerrStatus: number;
			retryAfterMs?: number;
			/** Override the computed client-facing status code */
			statusCodeOverride?: number;
			/** Override the computed retryable flag */
			retryableOverride?: boolean;
		},
	) {
		super(message);
		this.name = "SeerrApiError";
		this.seerrStatus = opts.seerrStatus;
		this.retryAfterMs = opts.retryAfterMs;
		this.retryable = opts.retryableOverride
			?? (opts.seerrStatus === 429 || opts.seerrStatus >= 500);

		// Map Seerr's HTTP status to our client-facing status
		if (opts.statusCodeOverride !== undefined) {
			this.statusCode = opts.statusCodeOverride;
		} else if ([401, 403, 404, 429].includes(opts.seerrStatus)) {
			this.statusCode = opts.seerrStatus;
		} else if (opts.seerrStatus >= 500) {
			this.statusCode = 502; // Bad Gateway
		} else {
			this.statusCode = opts.seerrStatus; // Other 4xx pass-through
		}
	}

	/** Factory for timeout errors (no Seerr status available) */
	static timeout(message: string): SeerrApiError {
		return new SeerrApiError(message, {
			seerrStatus: 0,
			statusCodeOverride: 504,
			retryableOverride: true,
		});
	}

	/** Factory for network errors (no Seerr status available) */
	static network(message: string): SeerrApiError {
		return new SeerrApiError(message, {
			seerrStatus: 0,
			statusCodeOverride: 502,
			retryableOverride: true,
		});
	}
}
