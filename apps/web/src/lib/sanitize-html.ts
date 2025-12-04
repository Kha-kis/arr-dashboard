"use client";

/**
 * HTML Sanitization Utility
 * Provides safe HTML rendering to prevent XSS attacks
 *
 * This module is client-only to ensure consistent hydration.
 * Only import from client components ("use client").
 */

import DOMPurify from "isomorphic-dompurify";

// Track if hooks have been initialized
let hooksInitialized = false;

/**
 * Initialize DOMPurify hooks for link security
 */
function initializeHooks(): void {
	if (hooksInitialized) return;

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
 * Sanitizes HTML content to prevent XSS attacks
 * @param html - The HTML string to sanitize
 * @returns Sanitized HTML string safe for dangerouslySetInnerHTML
 */
export function sanitizeHtml(html: string | undefined | null): string {
	if (!html) return "";

	// Initialize hooks on first use
	initializeHooks();

	return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/**
 * Creates a sanitized HTML object for use with dangerouslySetInnerHTML
 * @param html - The HTML string to sanitize
 * @returns Object suitable for dangerouslySetInnerHTML prop
 */
export function createSanitizedHtml(html: string | undefined | null): { __html: string } {
	return { __html: sanitizeHtml(html) };
}
