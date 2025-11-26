/**
 * Utilities for cleaning and parsing TRaSH Guides descriptions
 */

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
	let cleaned = rawMarkdown
		.replace(/<!-- markdownlint-.*?-->/gs, '')  // Remove markdown lint comments
		.replace(/\*\*(.*?)\*\*/g, '$1')  // Remove bold **text**
		.replace(/\[([^\]]+)\]\(<.*?>\)\{.*?\}/g, '$1')  // Remove links with angle brackets [text](<url>){attrs}
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Remove regular links [text](url)
		.replace(/\{:.*?\}/g, '')  // Remove standalone markdown attributes {:target="_blank" rel="noopener noreferrer"}
		.replace(/`([^`]+)`/g, '"$1"')  // Replace `code` with "code"
		.replace(/<br\s*\/?>/gi, '')  // Remove <br> tags
		.replace(/<[^>]*>/g, '')  // Remove any other HTML tags
		.replace(/=>/g, '→')  // Replace => with arrow
		.replace(/\\_/g, '_')  // Replace escaped underscores
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
