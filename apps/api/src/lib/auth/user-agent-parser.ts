/**
 * Simple user-agent parser for extracting browser and OS information
 * Designed for display purposes - not a full-featured UA parser
 */

export interface ParsedUserAgent {
	browser: string;
	os: string;
	device: "desktop" | "mobile" | "tablet" | "unknown";
	raw: string;
}

/**
 * Parse a user-agent string into browser, OS, and device type
 */
export function parseUserAgent(userAgent: string | undefined | null): ParsedUserAgent {
	if (!userAgent) {
		return {
			browser: "Unknown",
			os: "Unknown",
			device: "unknown",
			raw: "",
		};
	}

	const browser = detectBrowser(userAgent);
	const os = detectOS(userAgent);
	const device = detectDevice(userAgent);

	return {
		browser,
		os,
		device,
		raw: userAgent,
	};
}

function detectBrowser(ua: string): string {
	// Order matters - more specific checks first

	// Edge (Chromium-based)
	if (/Edg\//.test(ua)) {
		const match = ua.match(/Edg\/(\d+)/);
		return match ? `Edge ${match[1]}` : "Edge";
	}

	// Opera
	if (/OPR\//.test(ua) || /Opera\//.test(ua)) {
		const match = ua.match(/OPR\/(\d+)/) || ua.match(/Opera\/(\d+)/);
		return match ? `Opera ${match[1]}` : "Opera";
	}

	// Samsung Browser
	if (/SamsungBrowser\//.test(ua)) {
		const match = ua.match(/SamsungBrowser\/(\d+)/);
		return match ? `Samsung Browser ${match[1]}` : "Samsung Browser";
	}

	// Chrome (must come after Edge and Opera which include Chrome in UA)
	if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) {
		const match = ua.match(/Chrome\/(\d+)/);
		return match ? `Chrome ${match[1]}` : "Chrome";
	}

	// Chromium
	if (/Chromium\//.test(ua)) {
		const match = ua.match(/Chromium\/(\d+)/);
		return match ? `Chromium ${match[1]}` : "Chromium";
	}

	// Safari (must come after Chrome since Chrome includes Safari in UA)
	if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) {
		const match = ua.match(/Version\/(\d+)/);
		return match ? `Safari ${match[1]}` : "Safari";
	}

	// Firefox
	if (/Firefox\//.test(ua)) {
		const match = ua.match(/Firefox\/(\d+)/);
		return match ? `Firefox ${match[1]}` : "Firefox";
	}

	// Internet Explorer
	if (/MSIE/.test(ua) || /Trident\//.test(ua)) {
		const match = ua.match(/(?:MSIE |rv:)(\d+)/);
		return match ? `IE ${match[1]}` : "Internet Explorer";
	}

	// Generic mobile app WebView
	if (/wv\)/.test(ua)) {
		return "WebView";
	}

	return "Unknown Browser";
}

function detectOS(ua: string): string {
	// Windows
	if (/Windows NT 10\.0/.test(ua)) return "Windows 10/11";
	if (/Windows NT 6\.3/.test(ua)) return "Windows 8.1";
	if (/Windows NT 6\.2/.test(ua)) return "Windows 8";
	if (/Windows NT 6\.1/.test(ua)) return "Windows 7";
	if (/Windows/.test(ua)) return "Windows";

	// iOS (must come before Mac since iPad can contain Mac in UA)
	if (/iPhone/.test(ua)) {
		const match = ua.match(/iPhone OS (\d+)/);
		return match ? `iOS ${match[1]}` : "iOS";
	}
	if (/iPad/.test(ua)) {
		const match = ua.match(/CPU OS (\d+)/) || ua.match(/iPad.*OS (\d+)/);
		return match ? `iPadOS ${match[1]}` : "iPadOS";
	}

	// macOS
	if (/Mac OS X/.test(ua)) {
		const match = ua.match(/Mac OS X (\d+)[_.](\d+)/);
		return match ? `macOS ${match[1]}.${match[2]}` : "macOS";
	}

	// Android
	if (/Android/.test(ua)) {
		const match = ua.match(/Android (\d+)/);
		return match ? `Android ${match[1]}` : "Android";
	}

	// Linux distributions
	if (/Ubuntu/.test(ua)) return "Ubuntu";
	if (/Fedora/.test(ua)) return "Fedora";
	if (/Linux/.test(ua)) return "Linux";

	// Chrome OS
	if (/CrOS/.test(ua)) return "Chrome OS";

	return "Unknown OS";
}

function detectDevice(ua: string): "desktop" | "mobile" | "tablet" | "unknown" {
	// Tablets first (some tablets have "Mobile" in UA)
	if (/iPad/.test(ua)) return "tablet";
	if (/Tablet|Tab/.test(ua)) return "tablet";
	if (/Android/.test(ua) && !/Mobile/.test(ua)) return "tablet";

	// Mobile
	if (/iPhone|iPod/.test(ua)) return "mobile";
	if (/Android.*Mobile/.test(ua)) return "mobile";
	if (/Mobile|webOS|BlackBerry|IEMobile|Opera Mini/.test(ua)) return "mobile";

	// Desktop (default for most cases)
	if (/Windows|Mac OS|Linux|CrOS/.test(ua)) return "desktop";

	return "unknown";
}

/**
 * Get a human-friendly summary of the user agent
 * Format: "Browser on OS" or "Browser on OS (Device)"
 */
export function getUserAgentSummary(userAgent: string | undefined | null): string {
	const parsed = parseUserAgent(userAgent);

	if (parsed.browser === "Unknown" && parsed.os === "Unknown") {
		return "Unknown device";
	}

	return `${parsed.browser} on ${parsed.os}`;
}
