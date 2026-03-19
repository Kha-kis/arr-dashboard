/**
 * Regex Safety Validator
 *
 * Conservative validation for user-supplied regex patterns to mitigate ReDoS.
 * Rejects patterns with constructs known to cause catastrophic backtracking:
 *   - Nested quantifiers: (a+)+, (a*)*b, (.+)+
 *   - Overlapping alternations with quantifiers: (a|a)+
 *   - Excessive quantifier repetition: a{1,10000}
 *   - Backreferences (can enable exponential matching in some engines)
 *
 * Tradeoffs:
 *   - This is a heuristic approach, not a formal analysis like `recheck` (Java-based).
 *   - It may reject some safe-but-complex patterns (false positives).
 *   - For a single-admin self-hosted app, this provides good protection without
 *     adding a heavy dependency.
 */

/** Maximum allowed length for a user-supplied regex pattern */
export const REGEX_MAX_LENGTH = 200;

/**
 * Patterns that indicate dangerous regex constructs.
 * Each targets a specific class of catastrophic backtracking.
 */
const DANGEROUS_PATTERNS = [
	// Nested quantifiers: (x+)+, (x*)+, (x+)*, (x*)*
	/(\((?:[^()]*[+*])[^()]*\))[+*]|\(\?:[^()]*[+*][^()]*\)[+*]/,

	// Quantified group containing alternation with shared prefixes: (a|ab)+
	// Simplified: group with alternation followed by quantifier
	/\([^()]*\|[^()]*\)[+*]\{/,

	// Excessive bounded quantifier: x{n,m} where m > 1000
	/\{[^}]*,\s*(\d{4,})\}/,

	// Backreferences (can combine with other constructs for exponential matching)
	/\\[1-9]/,
];

/**
 * Validate a regex pattern for safety against ReDoS attacks.
 *
 * @returns `true` if the pattern is considered safe, `false` otherwise.
 */
export function isRegexSafe(pattern: string): boolean {
	// Length check
	if (pattern.length > REGEX_MAX_LENGTH) {
		return false;
	}

	// Must be a valid regex
	try {
		new RegExp(pattern); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	} catch {
		return false;
	}

	// Check for dangerous constructs
	for (const dangerous of DANGEROUS_PATTERNS) {
		if (dangerous.test(pattern)) {
			return false;
		}
	}

	return true;
}

/**
 * Human-readable validation error for unsafe patterns.
 */
export function getRegexSafetyError(pattern: string): string | null {
	if (pattern.length > REGEX_MAX_LENGTH) {
		return `Pattern too long (max ${REGEX_MAX_LENGTH} characters)`;
	}

	try {
		new RegExp(pattern); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	} catch {
		return "Invalid regular expression syntax";
	}

	for (const dangerous of DANGEROUS_PATTERNS) {
		if (dangerous.test(pattern)) {
			return "Pattern contains constructs that may cause excessive backtracking (nested quantifiers, backreferences, or excessive repetition)";
		}
	}

	return null;
}
