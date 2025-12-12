/**
 * Copy text to clipboard with fallback for non-HTTPS environments.
 *
 * Tries navigator.clipboard.writeText first (requires secure context),
 * falls back to execCommand('copy') for HTTP environments.
 *
 * @param text - The text to copy to clipboard
 * @returns Promise that resolves on success, rejects with error message on failure
 */
export async function copyToClipboard(text: string): Promise<void> {
	// Try modern Clipboard API first (requires secure context: HTTPS or localhost)
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// Clipboard API failed (likely not in secure context), try fallback
		}
	}

	// Fallback: Use execCommand (works on HTTP but deprecated)
	const textarea = document.createElement("textarea");
	textarea.value = text;

	// Prevent scrolling to bottom of page on iOS
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	textarea.setAttribute("readonly", "");

	document.body.appendChild(textarea);

	try {
		textarea.select();
		textarea.setSelectionRange(0, text.length); // For mobile devices

		const success = document.execCommand("copy");
		if (!success) {
			throw new Error("execCommand copy failed");
		}
	} finally {
		document.body.removeChild(textarea);
	}
}
