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
 * Tests connection to a service instance
 */
export async function testServiceConnection(
  baseUrl: string,
  apiKey: string,
  service: string,
): Promise<ConnectionTestResult> {
  try {
    const apiPath =
      service === "prowlarr"
        ? "/api/v1/system/status"
        : "/api/v3/system/status";
    const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
    const testUrl = `${normalizedBaseUrl}${apiPath}`;

    // Try ping endpoint first for Prowlarr to verify basic connectivity
    if (service === "prowlarr") {
      const pingResult = await testProwlarrPing(normalizedBaseUrl);
      if (!pingResult.success) {
        return pingResult;
      }
    }

    const response = await fetch(testUrl, {
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type");
      let details = "Check your base URL and API key";

      if (contentType?.includes("text/html")) {
        details =
          "Received HTML instead of JSON. The base URL or API path might be incorrect. Ensure base URL includes the full path (e.g., http://localhost:7878 not http://localhost:7878/radarr)";
      }

      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        details,
      };
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
 * Tests Prowlarr ping endpoint for basic connectivity
 */
async function testProwlarrPing(
  normalizedBaseUrl: string,
): Promise<ConnectionTestResult> {
  const pingUrl = `${normalizedBaseUrl}/ping`;
  try {
    const pingResponse = await fetch(pingUrl, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });

    if (!pingResponse.ok && pingResponse.status !== 404) {
      return {
        success: false,
        error: `Ping failed: HTTP ${pingResponse.status}`,
        details: `Cannot reach ${pingUrl}. Check the base URL is correct.`,
      };
    }

    return { success: true };
  } catch (pingError: unknown) {
    const message =
      pingError && typeof pingError === "object" && "message" in pingError
        ? String(pingError.message)
        : "Check if Prowlarr is running and the base URL is correct.";

    return {
      success: false,
      error: "Cannot reach Prowlarr",
      details: `Ping to ${pingUrl} failed. ${message}`,
    };
  }
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
