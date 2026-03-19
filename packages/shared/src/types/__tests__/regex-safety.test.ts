import { describe, expect, it } from "vitest";
import { isRegexSafe, getRegexSafetyError, REGEX_MAX_LENGTH } from "../regex-safety.js";

describe("isRegexSafe", () => {
	describe("valid safe patterns", () => {
		it.each([
			["simple literal", "hello"],
			["case-insensitive word", "Movie\\.2024"],
			["character class", "[a-z]+"],
			["alternation", "foo|bar|baz"],
			["path-like pattern", "/media/movies/.*\\.mkv"],
			["bounded quantifier", "a{1,10}"],
			["optional group", "(release)?-group"],
			["non-capturing group", "(?:720p|1080p)"],
			["anchors", "^start.*end$"],
			["dot-star", ".*some-text.*"],
			["escaped special chars", "file\\.name\\(1\\)"],
		])("accepts %s: %s", (_label, pattern) => {
			expect(isRegexSafe(pattern)).toBe(true);
			expect(getRegexSafetyError(pattern)).toBeNull();
		});
	});

	describe("rejects dangerous patterns", () => {
		it.each([
			["nested quantifier (a+)+", "(a+)+"],
			["nested quantifier (.*)+", "(.*)+"],
			["nested quantifier (a*)*", "(a*)*"],
			["nested quantifier with non-capturing group", "(?:a+)+"],
			["backreference", "(a)\\1+"],
		])("rejects %s: %s", (_label, pattern) => {
			expect(isRegexSafe(pattern)).toBe(false);
			expect(getRegexSafetyError(pattern)).not.toBeNull();
		});
	});

	describe("rejects invalid regex", () => {
		it("rejects unclosed group", () => {
			expect(isRegexSafe("(unclosed")).toBe(false);
			expect(getRegexSafetyError("(unclosed")).toBe("Invalid regular expression syntax");
		});

		it("rejects unclosed character class", () => {
			expect(isRegexSafe("[unclosed")).toBe(false);
		});
	});

	describe("rejects overly long patterns", () => {
		it(`rejects patterns longer than ${REGEX_MAX_LENGTH} characters`, () => {
			const long = "a".repeat(REGEX_MAX_LENGTH + 1);
			expect(isRegexSafe(long)).toBe(false);
			expect(getRegexSafetyError(long)).toContain("too long");
		});

		it(`accepts patterns exactly ${REGEX_MAX_LENGTH} characters`, () => {
			const exact = "a".repeat(REGEX_MAX_LENGTH);
			expect(isRegexSafe(exact)).toBe(true);
		});
	});

	describe("getRegexSafetyError provides descriptive messages", () => {
		it("returns null for safe patterns", () => {
			expect(getRegexSafetyError("simple")).toBeNull();
		});

		it("returns length error for long patterns", () => {
			const msg = getRegexSafetyError("a".repeat(300));
			expect(msg).toContain("too long");
			expect(msg).toContain(String(REGEX_MAX_LENGTH));
		});

		it("returns syntax error for invalid regex", () => {
			expect(getRegexSafetyError("(unclosed")).toBe("Invalid regular expression syntax");
		});

		it("returns backtracking error for nested quantifiers", () => {
			const msg = getRegexSafetyError("(a+)+");
			expect(msg).toContain("backtracking");
		});
	});
});
