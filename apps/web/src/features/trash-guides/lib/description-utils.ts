/**
 * Utilities for cleaning and parsing TRaSH Guides descriptions
 */

/** Iteratively remove HTML comments until none remain (prevents partial match remnants) */
function stripHtmlComments(text: string): string {
	const pattern = /<!--.*?-->/gs;
	let result = text;
	while (pattern.test(result)) {
		result = result.replace(pattern, "");
		pattern.lastIndex = 0;
	}
	return result;
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
		.replace(/\{:.*?\}/g, "") // Remove standalone markdown attributes {:target="_blank" rel="noopener noreferrer"}

		// MkDocs-specific syntax
		.replace(/--8<--.*?(?:--8<--|$)/gs, "") // Remove MkDocs include directives (single or multi-line)
		.replace(/^!!!\s*(\w+)(?:\s+"[^"]*")?\s*$/gm, "[$1]") // Convert admonition headers: !!! note "Title" → [note]
		.replace(/^!!!\s*(\w+)\s*$/gm, "[$1]") // Convert simple admonitions: !!! note → [note]
		.replace(/^ {4}/gm, "") // Remove 4-space indentation (admonition content)

		// Fenced code blocks (must be before inline code)
		.replace(/```[\s\S]*?```/g, "") // Remove fenced code blocks ```...```
		.replace(/~~~[\s\S]*?~~~/g, "") // Remove fenced code blocks ~~~...~~~

		// Block elements (process before inline to avoid conflicts)
		.replace(/^#{1,6}\s+/gm, "") // Remove header markers (# ## ### etc.)
		.replace(/^>\s*/gm, "") // Remove blockquote markers
		.replace(/^[-*+]\s+/gm, "• ") // Convert unordered list markers to bullet
		.replace(/^\d+\.\s+/gm, "• ") // Convert ordered list markers to bullet
		.replace(/^---+$/gm, "") // Remove horizontal rules
		.replace(/^\*\*\*+$/gm, "") // Remove horizontal rules (asterisk variant)
		.replace(/^___+$/gm, "") // Remove horizontal rules (underscore variant)

		// Images and links (before text formatting)
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1") // Remove images ![alt](url) -> alt
		.replace(/\[([^\]]+)\]\(<.*?>\)\{.*?\}/g, "$1") // Remove links with angle brackets [text](<url>){attrs}
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove regular links [text](url)

		// Text formatting (order: bold before italic to avoid conflicts)
		.replace(/\*\*(.*?)\*\*/g, "$1") // Remove bold **text**
		.replace(/__(.*?)__/g, "$1") // Remove bold __text__
		.replace(/~~(.*?)~~/g, "$1") // Remove strikethrough ~~text~~
		.replace(/\*([^*]+)\*/g, "$1") // Remove italic *text*
		.replace(/\b_([^_]+)_\b/g, "$1") // Remove italic _text_ (word boundaries to avoid partial matches)
		.replace(/`([^`]+)`/g, '"$1"') // Replace `code` with "code"

		// HTML and escapes
		.replace(/<br\s*\/?>/gi, " ") // Replace <br> tags with space
		.replace(/<[^>]*>/g, "") // Remove complete HTML tags
		.replace(/</g, "") // Remove any remaining < from incomplete tags (e.g., <script without >)
		.replace(/\\_/g, "_") // Replace escaped underscores
		.replace(/\\\*/g, "*") // Replace escaped asterisks
		.replace(/\\`/g, "`") // Replace escaped backticks
		.replace(/=>/g, "→") // Replace => with arrow

		// Cleanup
		.replace(/\n+/g, " ") // Replace newlines with spaces
		.replace(/\s+/g, " ") // Collapse whitespace
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
