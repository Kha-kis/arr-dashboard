/**
 * Utilities for cleaning and parsing TRaSH Guides descriptions
 */

import type { CFInclude } from "../../../lib/api-client/trash-guides";

/** Iteratively remove HTML comments until none remain (prevents partial match remnants) */
function stripHtmlComments(text: string): string {
	const pattern = /<!--.*?-->/gs;
	let result = text;
	while (pattern.test(result)) {
		result = result.replace(pattern, '');
		pattern.lastIndex = 0;
	}
	return result;
}

/**
 * Map of include path to content for quick lookup
 */
export type IncludesMap = Map<string, string>;

/**
 * Convert an array of CFInclude objects to a Map for efficient lookup.
 * The map is keyed by the include path (e.g., "includes/cf-descriptions/apply-10000.md")
 */
export function buildIncludesMap(includes: CFInclude[]): IncludesMap {
	const map = new Map<string, string>();
	for (const include of includes) {
		map.set(include.path, include.content);
	}
	return map;
}

/**
 * Resolve MkDocs include directives in markdown text.
 * Replaces --8<-- "path/to/file.md" with the actual content from the includes map.
 *
 * @param markdown - Raw markdown text that may contain include directives
 * @param includesMap - Map of include paths to their content
 * @returns Markdown with includes resolved (replaced with content)
 */
export function resolveIncludes(markdown: string, includesMap: IncludesMap): string {
	if (!includesMap || includesMap.size === 0) {
		// No includes available, just strip the directives
		return markdown.replace(/--8<--\s*"[^"]+"/g, '');
	}

	// Replace inline includes: --8<-- "path/to/file.md"
	let resolved = markdown.replace(/--8<--\s*"([^"]+)"/g, (_match, path) => {
		const content = includesMap.get(path);
		return content || '';
	});

	// Remove any remaining block includes that weren't matched
	resolved = resolved.replace(/--8<--.*?--8<--/gs, '');

	return resolved;
}

/**
 * Clean markdown description for display
 *
 * This function handles the conversion of TRaSH Guides markdown descriptions
 * into clean, plain text suitable for UI display.
 *
 * @param rawMarkdown - The raw markdown description from TRaSH Guides
 * @param titleToRemove - Optional title text to remove from the start of the description
 * @returns Cleaned plain text description
 */
export function cleanDescription(rawMarkdown: string, titleToRemove?: string): string {
	// Remove markdown comment blocks and formatting
	// Order matters: handle multi-char markers before single-char ones
	let cleaned = stripHtmlComments(rawMarkdown)
		// Comments and metadata
		.replace(/\{:.*?\}/g, '')  // Remove standalone markdown attributes {:target="_blank" rel="noopener noreferrer"}

		// MkDocs-specific syntax
		.replace(/--8<--.*?(?:--8<--|$)/gs, '')  // Remove MkDocs include directives (single or multi-line)
		.replace(/^!!!\s*(\w+)(?:\s+"[^"]*")?\s*$/gm, '[$1]')  // Convert admonition headers: !!! note "Title" → [note]
		.replace(/^!!!\s*(\w+)\s*$/gm, '[$1]')  // Convert simple admonitions: !!! note → [note]
		.replace(/^    /gm, '')  // Remove 4-space indentation (admonition content)

		// Fenced code blocks (must be before inline code)
		.replace(/```[\s\S]*?```/g, '')  // Remove fenced code blocks ```...```
		.replace(/~~~[\s\S]*?~~~/g, '')  // Remove fenced code blocks ~~~...~~~

		// Block elements (process before inline to avoid conflicts)
		.replace(/^#{1,6}\s+/gm, '')  // Remove header markers (# ## ### etc.)
		.replace(/^>\s*/gm, '')  // Remove blockquote markers
		.replace(/^[-*+]\s+/gm, '• ')  // Convert unordered list markers to bullet
		.replace(/^\d+\.\s+/gm, '• ')  // Convert ordered list markers to bullet
		.replace(/^---+$/gm, '')  // Remove horizontal rules
		.replace(/^\*\*\*+$/gm, '')  // Remove horizontal rules (asterisk variant)
		.replace(/^___+$/gm, '')  // Remove horizontal rules (underscore variant)

		// Images and links (before text formatting)
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')  // Remove images ![alt](url) -> alt
		.replace(/\[([^\]]+)\]\(<.*?>\)\{.*?\}/g, '$1')  // Remove links with angle brackets [text](<url>){attrs}
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Remove regular links [text](url)

		// Text formatting (order: bold before italic to avoid conflicts)
		.replace(/\*\*(.*?)\*\*/g, '$1')  // Remove bold **text**
		.replace(/__(.*?)__/g, '$1')  // Remove bold __text__
		.replace(/~~(.*?)~~/g, '$1')  // Remove strikethrough ~~text~~
		.replace(/\*([^*]+)\*/g, '$1')  // Remove italic *text*
		.replace(/\b_([^_]+)_\b/g, '$1')  // Remove italic _text_ (word boundaries to avoid partial matches)
		.replace(/`([^`]+)`/g, '"$1"')  // Replace `code` with "code"

		// HTML and escapes
		.replace(/<br\s*\/?>/gi, ' ')  // Replace <br> tags with space
		.replace(/<[^>]*>/g, '')  // Remove complete HTML tags
		.replace(/</g, '')  // Remove any remaining < from incomplete tags (e.g., <script without >)
		.replace(/\\_/g, '_')  // Replace escaped underscores
		.replace(/\\\*/g, '*')  // Replace escaped asterisks
		.replace(/\\`/g, '`')  // Replace escaped backticks
		.replace(/=>/g, '→')  // Replace => with arrow

		// Cleanup
		.replace(/\n+/g, ' ')  // Replace newlines with spaces
		.replace(/\s+/g, ' ')  // Collapse whitespace
		.trim();

	// Remove the title line if provided (using string-based approach to avoid ReDoS)
	if (titleToRemove) {
		const lowerCleaned = cleaned.toLowerCase();
		const lowerTitle = titleToRemove.toLowerCase();
		if (lowerCleaned.startsWith(lowerTitle)) {
			cleaned = cleaned.slice(titleToRemove.length);
			// Also remove optional parenthetical suffix like "(Optional)"
			const parenMatch = cleaned.match(/^\s*\([^)]{1,50}\)/);
			if (parenMatch) {
				cleaned = cleaned.slice(parenMatch[0].length);
			}
			cleaned = cleaned.trim();
		}
	}

	return cleaned;
}

/**
 * Convert markdown description to formatted HTML for detailed display
 *
 * Unlike cleanDescription which produces compact plain text,
 * this preserves structure (paragraphs, lists) for modal/detail views.
 *
 * @param rawMarkdown - The raw markdown description from TRaSH Guides
 * @param titleToRemove - Optional title text to remove from the start
 * @returns HTML string with preserved formatting
 */
export function markdownToFormattedHtml(rawMarkdown: string, titleToRemove?: string): string {
	let text = stripHtmlComments(rawMarkdown)
		// Comments and metadata
		.replace(/\{:.*?\}/g, '')

		// Fenced code blocks → styled code blocks
		.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
		.replace(/~~~(\w*)\n?([\s\S]*?)~~~/g, '<pre><code>$2</code></pre>')

		// Headers → bold text with line break
		.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong><br>')

		// Blockquotes
		.replace(/^>\s*(.+)$/gm, '<blockquote>$1</blockquote>')

		// Horizontal rules
		.replace(/^[-*_]{3,}$/gm, '<hr>')

		// Images and links
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
		.replace(/\[([^\]]+)\]\(<([^>]+)>\)\{[^}]*\}/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

		// Text formatting
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/__(.+?)__/g, '<strong>$1</strong>')
		.replace(/~~(.+?)~~/g, '<del>$1</del>')
		.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
		.replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>')
		.replace(/`([^`]+)`/g, '<code>$1</code>')

		// Escape sequences
		.replace(/\\_/g, '_')
		.replace(/\\\*/g, '*')
		.replace(/\\`/g, '`')
		.replace(/=>/g, '→');

	// Remove title if provided
	if (titleToRemove) {
		const titlePattern = new RegExp(`^\\s*${escapeRegExp(titleToRemove)}\\s*(\\([^)]{1,50}\\))?\\s*`, 'i');
		text = text.replace(titlePattern, '');
	}

	// Process lists - convert consecutive list items into proper lists
	text = text
		// Unordered lists
		.replace(/(?:^[-*+]\s+.+$\n?)+/gm, (match) => {
			const items = match.trim().split('\n')
				.map(line => line.replace(/^[-*+]\s+/, '').trim())
				.filter(Boolean)
				.map(item => `<li>${item}</li>`)
				.join('');
			return `<ul>${items}</ul>`;
		})
		// Ordered lists
		.replace(/(?:^\d+\.\s+.+$\n?)+/gm, (match) => {
			const items = match.trim().split('\n')
				.map(line => line.replace(/^\d+\.\s+/, '').trim())
				.filter(Boolean)
				.map(item => `<li>${item}</li>`)
				.join('');
			return `<ol>${items}</ol>`;
		});

	// Convert paragraphs (double newlines)
	text = text
		.split(/\n{2,}/)
		.map(para => para.trim())
		.filter(Boolean)
		.map(para => {
			// Don't wrap block elements in <p>
			if (para.startsWith('<ul>') || para.startsWith('<ol>') ||
				para.startsWith('<pre>') || para.startsWith('<blockquote>') ||
				para.startsWith('<hr')) {
				return para;
			}
			// Convert single newlines to <br> within paragraphs
			return `<p>${para.replace(/\n/g, '<br>')}</p>`;
		})
		.join('');

	return text.trim();
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert HTML description to plain text for textarea inputs
 *
 * Used when populating form fields with existing descriptions
 *
 * @param htmlDescription - HTML description string
 * @returns Plain text with newlines
 */
export function htmlToPlainText(htmlDescription: string): string {
	return htmlDescription.replace(/<br>/g, "\n");
}
