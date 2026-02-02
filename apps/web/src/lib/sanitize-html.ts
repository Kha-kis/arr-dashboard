"use client";

/**
 * HTML Sanitization Utility
 * Provides safe HTML rendering to prevent XSS attacks
 *
 * This module is client-only to ensure consistent hydration.
 * Only import from client components ("use client").
 *
 * Note: We use dompurify (browser-only) instead of isomorphic-dompurify
 * to avoid jsdom bundling issues in Next.js standalone mode.
 * During SSR, we return an empty string which gets hydrated client-side.
 */

// Lazy-loaded DOMPurify instance (browser-only)
let DOMPurify: typeof import("dompurify").default | null = null;
let hooksInitialized = false;

// Sanitization config - defined once for consistency
const SANITIZE_CONFIG = {
	// Allow common HTML tags for descriptions
	ALLOWED_TAGS: [
		"p", "br", "b", "i", "strong", "em", "a", "ul", "ol", "li",
		"code", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
		"span", "div", "table", "thead", "tbody", "tr", "th", "td",
	],
	// Allow common attributes
	ALLOWED_ATTR: [
		"href", "target", "rel", "class", "id", "title",
	],
};

/**
 * Initialize DOMPurify (browser-only)
 */
function getDOMPurify(): typeof import("dompurify").default | null {
	if (typeof window === "undefined") {
		// Server-side: return null, sanitization happens client-side
		return null;
	}

	if (!DOMPurify) {
		try {
			// Dynamic require for browser-only usage (synchronous loading needed here)
			// DOMPurify v3 CJS exports the instance directly (not as .default)
			// Use fallback pattern to support both CJS and ESM interop
			const mod = require("dompurify");
			const instance = mod.default || mod;

			// Validate the loaded module has the expected API
			if (typeof instance?.sanitize !== "function") {
				console.error("[sanitize-html] DOMPurify loaded but sanitize() not found");
				return null;
			}

			DOMPurify = instance;
		} catch (error) {
			console.error("[sanitize-html] Failed to load DOMPurify:", error);
			return null;
		}

		// Initialize hooks on first load
		if (DOMPurify && !hooksInitialized) {
			// Add hook to enforce noopener noreferrer on external links to prevent reverse tabnapping
			DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
				// Check if this is an anchor element with target="_blank"
				if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
					const existingRel = node.getAttribute("rel") || "";
					const relParts = existingRel.split(/\s+/).filter(Boolean);

					// Ensure noopener and noreferrer are present
					if (!relParts.includes("noopener")) {
						relParts.push("noopener");
					}
					if (!relParts.includes("noreferrer")) {
						relParts.push("noreferrer");
					}

					node.setAttribute("rel", relParts.join(" "));
				}
			});
			hooksInitialized = true;
		}
	}

	return DOMPurify;
}

/**
 * Sanitizes HTML content to prevent XSS attacks
 * @param html - The HTML string to sanitize
 * @returns Sanitized HTML string safe for dangerouslySetInnerHTML
 *
 * Note: Returns empty string during SSR; content is sanitized on client hydration
 */
export function sanitizeHtml(html: string | undefined | null): string {
	if (!html) return "";

	const purify = getDOMPurify();

	// During SSR, return empty string - will be hydrated client-side
	if (!purify) {
		return "";
	}

	return purify.sanitize(html, SANITIZE_CONFIG);
}

/**
 * Creates a sanitized HTML object for use with dangerouslySetInnerHTML
 * @param html - The HTML string to sanitize
 * @returns Object suitable for dangerouslySetInnerHTML prop
 */
export function createSanitizedHtml(html: string | undefined | null): { __html: string } {
	return { __html: sanitizeHtml(html) };
}
