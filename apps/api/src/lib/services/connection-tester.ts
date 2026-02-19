/**
 * Service connection testing utilities
 */

export interface ConnectionTestResult {
	success: boolean;
	message?: string;
	version?: string;
	error?: string;
	details?: string;
}

/**
 * Tests connection to a service instance using the system/status endpoint.
 * This is the standard approach used by most *arr integration tools.
 */
export async function testServiceConnection(
	baseUrl: string,
	apiKey: string,
	service: string,
): Promise<ConnectionTestResult> {
	try {
		// Seerr uses its own status endpoint; Prowlarr/Lidarr/Readarr use v1; Sonarr/Radarr use v3
		const apiPath =
			service === "seerr"
				? "/api/v1/status"
				: ["prowlarr", "lidarr", "readarr"].includes(service)
					? "/api/v1/system/status"
					: "/api/v3/system/status";
		const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
		const testUrl = `${normalizedBaseUrl}${apiPath}`;

		const response = await fetch(testUrl, {
			headers: {
				"X-Api-Key": apiKey,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			return handleHttpError(response, normalizedBaseUrl);
		}

		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return {
				success: false,
				error: "Invalid response format",
				details:
					"Received HTML instead of JSON. Check if the base URL is correct and includes any URL base if configured in the service (e.g., http://localhost:7878 for root, or http://localhost/radarr if using a URL base).",
			};
		}

		const data = (await response.json()) as { version?: string };
		const version = data.version ?? "unknown";

		return {
			success: true,
			message: `Successfully connected to ${service.charAt(0).toUpperCase() + service.slice(1)}`,
			version,
		};
	} catch (error: unknown) {
		return handleConnectionError(error);
	}
}

/**
 * Handles HTTP error responses with specific messages for common status codes
 */
function handleHttpError(response: Response, baseUrl: string): ConnectionTestResult {
	const status = response.status;
	const contentType = response.headers.get("content-type");

	// Authentication errors - API key issue or reverse proxy auth
	if (status === 401) {
		return {
			success: false,
			error: "Authentication failed (401)",
			details:
				"Invalid API key, or a reverse proxy is blocking the request. Verify the API key is correct and check any forward auth settings.",
		};
	}

	if (status === 403) {
		return {
			success: false,
			error: "Access forbidden (403)",
			details:
				"The API key may lack permissions, or a reverse proxy is denying access. Check your reverse proxy configuration if using one.",
		};
	}

	// Server errors
	if (status >= 500) {
		return {
			success: false,
			error: `Server error (${status})`,
			details:
				"The service encountered an internal error. Check the service logs for more details.",
		};
	}

	// Not found - likely wrong URL
	if (status === 404) {
		return {
			success: false,
			error: "Endpoint not found (404)",
			details: `The API endpoint was not found at ${baseUrl}. Check if the base URL is correct and the service is running.`,
		};
	}

	// HTML response usually means wrong URL or proxy issue
	if (contentType?.includes("text/html")) {
		return {
			success: false,
			error: `HTTP ${status}: ${response.statusText}`,
			details:
				"Received HTML instead of JSON. The base URL might be incorrect, or a reverse proxy is returning an error page.",
		};
	}

	// Generic error for other status codes
	return {
		success: false,
		error: `HTTP ${status}: ${response.statusText}`,
		details: "Check your base URL and API key are correct.",
	};
}

/**
 * Handles connection errors and returns appropriate error result
 */
function handleConnectionError(error: unknown): ConnectionTestResult {
	let errorMessage = "Connection failed";
	let details = "Unknown error";

	if (
		error &&
		typeof error === "object" &&
		("name" in error || "code" in error || "message" in error)
	) {
		const err = error as { name?: string; code?: string; message?: string };

		if (err.name === "TimeoutError" || err.code === "ETIMEDOUT") {
			errorMessage = "Connection timeout";
			details =
				"The service did not respond within 5 seconds. Check if the service is running and the base URL is correct.";
		} else if (err.code === "ECONNREFUSED") {
			errorMessage = "Connection refused";
			details =
				"Could not connect to the service. Verify the base URL and that the service is running.";
		} else if (err.message) {
			details = err.message;
		}
	}

	return {
		success: false,
		error: errorMessage,
		details,
	};
}
