/**
 * Validates and sanitizes URLs before opening them in new windows/tabs
 * Prevents potential XSS and open redirect vulnerabilities
 */

const ALLOWED_PROTOCOLS = ["http:", "https:"];

/**
 * Validates if a URL is safe to open
 * @param url - The URL to validate
 * @returns true if the URL is safe, false otherwise
 */
export function isSafeUrl(url: string): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }

  // Trim whitespace
  const trimmedUrl = url.trim();

  // Reject empty strings
  if (trimmedUrl.length === 0) {
    return false;
  }

  // Reject javascript: and data: URLs
  const lowerUrl = trimmedUrl.toLowerCase();
  if (
    lowerUrl.startsWith("javascript:") ||
    lowerUrl.startsWith("data:") ||
    lowerUrl.startsWith("vbscript:")
  ) {
    return false;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);

    // Only allow http and https protocols
    if (!ALLOWED_PROTOCOLS.includes(parsedUrl.protocol)) {
      return false;
    }

    return true;
  } catch (error) {
    // If URL parsing fails, it's not a valid URL
    return false;
  }
}

/**
 * Safely opens a URL in a new tab/window with proper security attributes
 * @param url - The URL to open
 * @returns true if the URL was opened, false if it was rejected
 */
export function safeOpenUrl(url: string): boolean {
  if (!isSafeUrl(url)) {
    console.warn("Attempted to open unsafe URL:", url);
    return false;
  }

  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
