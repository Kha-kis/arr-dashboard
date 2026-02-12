"use client";

import type { CSSProperties } from "react";
// Security: createSanitizedHtml wraps DOMPurify for XSS protection
import { createSanitizedHtml } from "../../../lib/sanitize-html";

interface SanitizedHtmlProps {
	html: string | undefined | null;
	className?: string;
	style?: CSSProperties;
}

/**
 * Renders pre-sanitized HTML content.
 * Security: All HTML is sanitized via DOMPurify before rendering.
 */
export const SanitizedHtml = ({ html, className, style }: SanitizedHtmlProps) => (
	// Security: Content is sanitized via DOMPurify wrapper (createSanitizedHtml)
	<div
		className={className}
		style={style}
		dangerouslySetInnerHTML={createSanitizedHtml(html)}
	/>
);
