import { describe, expect, it } from "vitest";
import { createSanitizedHtml, sanitizeHtml } from "./sanitize-html";

describe("HTML sanitization with the runtime DOMPurify dependency", () => {
	it("preserves supported prose and safe links", () => {
		const html = '<p>A <strong>description</strong> <a href="https://example.com">link</a></p>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	it("removes executable elements, event handlers and unsafe link schemes", () => {
		const html = sanitizeHtml(
			'<script>alert(1)</script><p onclick="alert(1)">Description</p>' +
				'<a href="javascript:alert(1)">link</a><img src="x" onerror="alert(1)">',
		);
		expect(html).toBe("<p>Description</p><a>link</a>");
	});

	it("retains safe attributes while protecting links that open a new tab", () => {
		const template = document.createElement("template");
		template.innerHTML = sanitizeHtml(
			'<a href="https://example.com" target="_blank" rel="nofollow">link</a>',
		);
		const link = template.content.querySelector("a");
		expect(link?.getAttribute("href")).toBe("https://example.com");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(new Set(link?.getAttribute("rel")?.split(/\s+/))).toEqual(
			new Set(["nofollow", "noopener", "noreferrer"]),
		);
	});

	it("returns the same sanitized contract for the rendering helper", () => {
		expect(createSanitizedHtml('<p onmouseover="alert(1)">Description</p>')).toEqual({
			__html: "<p>Description</p>",
		});
	});

	it("handles absent descriptions without fabricating content", () => {
		expect(sanitizeHtml(undefined)).toBe("");
		expect(sanitizeHtml(null)).toBe("");
		expect(sanitizeHtml("")).toBe("");
	});
});
