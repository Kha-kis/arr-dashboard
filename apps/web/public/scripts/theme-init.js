/**
 * Color Theme Initialization Script
 *
 * This script runs BEFORE React hydration to prevent theme flash (FOIT).
 * It reads the user's color theme preference from localStorage and applies
 * the data-theme attribute to the <html> element immediately.
 *
 * The script must be synchronous and execute before first paint.
 *
 * Valid themes: blue (default), purple, green, orange, rose, slate
 * Storage key: arr-color-theme
 */
(function () {
	try {
		var STORAGE_KEY = "arr-color-theme";
		var VALID_THEMES = ["blue", "purple", "green", "orange", "rose", "slate"];
		var DEFAULT_THEME = "blue";

		var theme = localStorage.getItem(STORAGE_KEY);

		// Validate the stored theme
		if (theme && VALID_THEMES.indexOf(theme) !== -1) {
			// Only set data-theme for non-default themes
			// Blue is the default, so it doesn't need the attribute
			if (theme !== DEFAULT_THEME) {
				document.documentElement.setAttribute("data-theme", theme);
			}
		}
	} catch (e) {
		// Silently fail if localStorage is not available (e.g., private browsing)
	}
})();
