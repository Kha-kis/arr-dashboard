#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_HEADINGS = [
	"Summary",
	"Related issue",
	"Scope",
	"Non-goals",
	"Acceptance criteria",
	"Changes",
	"Risk classification",
	"Validation",
	"Review plan",
	"Finding disposition",
	"Final merge gate",
];

const RISK_TIERS = ["Trivial", "Standard", "Safety-critical"];
const NON_BREAKING_SPACE_PATTERN = /(?:&nbsp;|&#160;|&#xA0;)/gi;
const NARRATIVE_CONTENT_HEADINGS = [
	"Summary",
	"Related issue",
	"Scope",
	"Non-goals",
	"Acceptance criteria",
	"Changes",
];
const EXEMPT_ACTORS = new Set(["dependabot[bot]", "github-actions[bot]"]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_RELATIVE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";

export function normalizeMarkdown(markdown) {
	return markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function stripHtmlCommentsFromLine(line, startsInComment) {
	let output = "";
	let inComment = startsInComment;
	let index = 0;

	while (index < line.length) {
		if (!inComment && line.startsWith("<!--", index)) {
			output += "    ";
			inComment = true;
			index += 4;
			continue;
		}
		if (inComment && line.startsWith("-->", index)) {
			output += "   ";
			inComment = false;
			index += 3;
			continue;
		}

		output += inComment ? " " : line[index];
		index += 1;
	}

	return { line: output, inComment };
}

function markdownLinesOutsideFences(markdown, { includeFenceContent = false } = {}) {
	const lines = normalizeMarkdown(markdown).split("\n");
	const visible = [];
	let fence = null;
	let inComment = false;

	for (const rawLine of lines) {
		if (fence) {
			const marker = rawLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
			if (
				marker &&
				marker[1][0] === fence.character &&
				marker[1].length >= fence.length &&
				marker[2].trim() === ""
			) {
				fence = null;
			} else if (includeFenceContent && rawLine.trim() !== "") {
				// Four spaces keep fenced headings inert while the marker makes any
				// non-empty code, including HTML-like code, visible to content checks.
				visible.push(`    fenced-code ${rawLine}`);
			}
			continue;
		}

		const stripped = stripHtmlCommentsFromLine(rawLine, inComment);
		inComment = stripped.inComment;
		const line = stripped.line;
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (marker) {
			const run = marker[1];
			fence = { character: run[0], length: run.length };
			continue;
		}
		visible.push(line);
	}

	return visible;
}

function levelTwoHeading(line) {
	const match = line.match(/^ {0,3}##(?:[ \t]+|$)(.*)$/);
	if (!match) {
		return null;
	}
	return match[1].trim().replace(/[ \t]+#+[ \t]*$/, "").trim();
}

export function collectLevelTwoHeadings(markdown) {
	if (typeof markdown !== "string") {
		return [];
	}

	const headings = [];
	for (const line of markdownLinesOutsideFences(markdown)) {
		const heading = levelTwoHeading(line);
		if (heading !== null) {
			headings.push(heading);
		}
	}
	return headings;
}

function collectRiskOptions(markdown) {
	if (typeof markdown !== "string") {
		return [];
	}

	const options = [];
	let inRiskClassification = false;
	for (const line of markdownLinesOutsideFences(markdown)) {
		const heading = levelTwoHeading(line);
		if (heading !== null) {
			inRiskClassification = heading === "Risk classification";
			continue;
		}
		if (!inRiskClassification) {
			continue;
		}
		const match = line.match(/^ {0,3}-[ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$/);
		if (match) {
			options.push({ tier: match[2].trim(), selected: match[1].toLowerCase() === "x" });
		}
	}
	return options;
}

export function selectedRiskTier(markdown) {
	const selected = collectRiskOptions(markdown).filter((option) => option.selected);
	return selected.length === 1 ? selected[0].tier : null;
}

function headingErrors(markdown) {
	const headings = collectLevelTwoHeadings(markdown);
	const errors = [];
	for (const required of REQUIRED_HEADINGS) {
		const count = headings.filter((heading) => heading === required).length;
		if (count === 0) {
			errors.push(`Missing required heading: ${required}`);
		} else if (count > 1) {
			errors.push(`Duplicate required heading: ${required}`);
		}
	}
	return errors;
}

function collectSections(markdown) {
	const sections = new Map();
	let currentHeading = null;

	for (const line of markdownLinesOutsideFences(markdown, { includeFenceContent: true })) {
		const heading = levelTwoHeading(line);
		if (heading !== null) {
			currentHeading = heading;
			if (!sections.has(heading)) {
				sections.set(heading, []);
			}
			continue;
		}
		if (currentHeading !== null) {
			sections.get(currentHeading)?.push(line);
		}
	}

	return sections;
}

function isAsciiLetter(character) {
	return (
		character !== undefined &&
		((character >= "A" && character <= "Z") || (character >= "a" && character <= "z"))
	);
}

function isTagNameCharacter(character) {
	return isAsciiLetter(character) || (character !== undefined && character >= "0" && character <= "9") || character === "-";
}

function findUnquotedTerminator(value, start, terminator) {
	let quote = null;
	for (let index = start; index < value.length; index += 1) {
		const character = value[index];
		if (quote !== null) {
			if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (value.startsWith(terminator, index)) {
			return index + terminator.length;
		}
	}
	return null;
}

function rawHtmlConstructEnd(value, start) {
	if (value.startsWith("<!--", start)) {
		const end = value.indexOf("-->", start + 4);
		return end === -1 ? null : end + 3;
	}

	if (value.startsWith("<![CDATA[", start)) {
		const end = value.indexOf("]]>", start + 9);
		return end === -1 ? null : end + 3;
	}

	if (value.slice(start, start + 9).toLowerCase() === "<!doctype") {
		const boundary = value[start + 9];
		if (boundary === ">" || /\s/.test(boundary ?? "")) {
			return findUnquotedTerminator(value, start + 9, ">");
		}
	}

	if (value.startsWith("<?", start)) {
		return findUnquotedTerminator(value, start + 2, "?>");
	}

	let index = start + 1;
	if (value[index] === "/") {
		index += 1;
	}
	if (!isAsciiLetter(value[index])) {
		return null;
	}
	index += 1;
	while (isTagNameCharacter(value[index])) {
		index += 1;
	}

	// Markdown URL and email autolinks remain text because ':' and '@' do not
	// satisfy the whitespace, slash, or closing-angle tag boundary.
	const boundary = value[index];
	if (boundary !== ">" && boundary !== "/" && !/\s/.test(boundary ?? "")) {
		return null;
	}
	return findUnquotedTerminator(value, index, ">");
}

function stripRawHtmlConstructs(value) {
	let output = "";
	let index = 0;
	while (index < value.length) {
		if (value[index] !== "<") {
			output += value[index];
			index += 1;
			continue;
		}

		const end = rawHtmlConstructEnd(value, index);
		if (end === null) {
			output += value[index];
			index += 1;
			continue;
		}
		index = end;
	}
	return output;
}

function hasText(value) {
	const normalized = value.replace(NON_BREAKING_SPACE_PATTERN, " ");
	if (/(`+)([^`\n]*\S[^`\n]*)\1/.test(normalized)) {
		return true;
	}
	return /[\p{L}\p{N}]/u.test(stripRawHtmlConstructs(normalized));
}

function hasNarrativeContent(lines) {
	return hasText(
		lines
			.map((line) => line.replace(/^ {0,3}-[ \t]+\[[ xX]\][ \t]*/, ""))
			.join("\n"),
	);
}

function hasValidationContent(lines) {
	const content = lines.map((line) => {
		const checkbox = line.match(/^ {0,3}-[ \t]+\[([ xX])\][ \t]*(.*)$/);
		if (!checkbox) {
			return line;
		}
		return checkbox[1].toLowerCase() === "x" ? checkbox[2] : "";
	});
	return hasText(content.join("\n"));
}

function hasReviewPlanContent(lines) {
	const values = lines.map((line) => {
		const separator = line.indexOf(":");
		return separator === -1 ? "" : line.slice(separator + 1);
	});
	return hasText(values.join("\n"));
}

function hasFindingDispositionContent(lines) {
	const content = lines.map((line) => {
		if (!line.trim().startsWith("|")) {
			return line;
		}

		const cells = line
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim());
		if (cells.length === 0 || cells[0] === "ID" || cells.every((cell) => /^:?-+:?$/.test(cell))) {
			return "";
		}
		return cells.join(" ");
	});
	return hasText(content.join("\n"));
}

function sectionContentErrors(markdown) {
	const sections = collectSections(markdown);
	const errors = [];
	const requireContent = (heading, predicate) => {
		const lines = sections.get(heading);
		if (lines && !predicate(lines)) {
			errors.push(`Required section has no visible, non-placeholder content: ${heading}`);
		}
	};

	for (const heading of NARRATIVE_CONTENT_HEADINGS) {
		requireContent(heading, hasNarrativeContent);
	}
	requireContent("Validation", hasValidationContent);
	requireContent("Review plan", hasReviewPlanContent);
	requireContent("Finding disposition", hasFindingDispositionContent);
	return errors;
}

export function validateReviewContractBody(markdown) {
	if (typeof markdown !== "string") {
		return { valid: false, errors: ["Pull request body must be Markdown text."], riskTier: null };
	}

	const errors = [...headingErrors(markdown), ...sectionContentErrors(markdown)];
	const options = collectRiskOptions(markdown);
	for (const option of options) {
		if (!RISK_TIERS.includes(option.tier)) {
			errors.push(`Unsupported risk option: ${option.tier}`);
		}
	}
	const selected = options.filter(
		(option) => option.selected && RISK_TIERS.includes(option.tier),
	);
	if (selected.length !== 1) {
		errors.push("Select exactly one risk tier: Trivial, Standard, or Safety-critical.");
	}

	return {
		valid: errors.length === 0,
		errors,
		riskTier: selected.length === 1 ? selected[0].tier : null,
	};
}

export function validateReviewTemplate(markdown) {
	if (typeof markdown !== "string") {
		return { valid: false, errors: ["PR template must be Markdown text."] };
	}

	const errors = headingErrors(markdown);
	const options = collectRiskOptions(markdown);
	for (const option of options) {
		if (!RISK_TIERS.includes(option.tier)) {
			errors.push(`Unsupported risk option: ${option.tier}`);
		}
	}
	for (const tier of RISK_TIERS) {
		const matches = options.filter((option) => option.tier === tier);
		if (matches.length === 0) {
			errors.push(`Missing required risk option: ${tier}`);
		} else if (matches.length > 1) {
			errors.push(`Duplicate required risk option: ${tier}`);
		} else if (matches[0].selected) {
			errors.push(`Repository template risk option must be unchecked: ${tier}`);
		}
	}

	return { valid: errors.length === 0, errors };
}

function invalidEvent(message) {
	return { valid: false, errors: [message], exempt: false, actor: null, body: null };
}

export function parseEventPayload(payload) {
	let event;
	try {
		event = JSON.parse(payload);
	} catch {
		return invalidEvent("GitHub event payload is not valid JSON.");
	}

	if (!event || typeof event !== "object" || !event.pull_request || typeof event.pull_request !== "object") {
		return invalidEvent("GitHub event payload is missing pull_request.");
	}

	const actor = event.pull_request.user?.login;
	if (typeof actor !== "string" || actor.length === 0) {
		return invalidEvent("GitHub event payload is missing pull_request.user.login.");
	}

	if (EXEMPT_ACTORS.has(actor)) {
		return { valid: true, errors: [], exempt: true, actor, body: event.pull_request.body };
	}

	if (typeof event.pull_request.body !== "string") {
		return invalidEvent("GitHub event payload is missing a text pull_request.body.");
	}

	return {
		valid: true,
		errors: [],
		exempt: false,
		actor,
		body: event.pull_request.body,
	};
}

function annotationValue(value) {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function failure(errors) {
	return {
		exitCode: 1,
		stdout: "",
		stderr: `${errors
			.map((message) => `::error title=PR review contract::${annotationValue(message)}`)
			.join("\n")}\n`,
	};
}

function success(message) {
	return { exitCode: 0, stdout: `${message}\n`, stderr: "" };
}

function parseArguments(args) {
	const selections = [];
	let selection = null;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--template") {
			selections.push({ mode: "template" });
			continue;
		}
		if (argument === "--event-path" || argument === "--body-file") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				return { error: `${argument} requires a file path.` };
			}
			selections.push({
				mode: argument === "--event-path" ? "event" : "body",
				path: value,
			});
			index += 1;
			continue;
		}
		return { error: `Unsupported argument: ${argument}` };
	}

	if (selections.length > 1) {
		return { error: "--event-path, --body-file, and --template are mutually exclusive." };
	}
	if (selections.length === 1) {
		[selection] = selections;
	}
	return { selection };
}

export function runCli(
	args = [],
	{ cwd = process.cwd(), env = process.env, readFile = readFileSync } = {},
) {
	const parsed = parseArguments(args);
	if (parsed.error) {
		return failure([parsed.error]);
	}

	let selection = parsed.selection;
	if (!selection) {
		selection = env.GITHUB_EVENT_PATH
			? { mode: "event", path: env.GITHUB_EVENT_PATH }
			: { mode: "template" };
	}

	if (selection.mode === "template") {
		const templatePath = path.resolve(cwd, TEMPLATE_RELATIVE_PATH);
		let markdown;
		try {
			markdown = readFile(templatePath, "utf8");
		} catch {
			return failure([`Unable to read repository PR template at ${TEMPLATE_RELATIVE_PATH}.`]);
		}
		const result = validateReviewTemplate(markdown);
		return result.valid
			? success("PR review contract template is valid.")
			: failure(result.errors);
	}

	let content;
	try {
		content = readFile(path.resolve(cwd, selection.path), "utf8");
	} catch {
		return failure([`Unable to read ${selection.mode === "event" ? "event" : "body"} file.`]);
	}

	if (selection.mode === "event") {
		const event = parseEventPayload(content);
		if (!event.valid) {
			return failure(event.errors);
		}
		if (event.exempt) {
			return success(`PR review contract validation: ${event.actor} is explicitly exempt.`);
		}
		const result = validateReviewContractBody(event.body);
		return result.valid
			? success(`PR review contract is valid (${result.riskTier}).`)
			: failure(result.errors);
	}

	const result = validateReviewContractBody(content);
	return result.valid
		? success(`PR review contract is valid (${result.riskTier}).`)
		: failure(result.errors);
}

const isEntryPoint =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
	const result = runCli(process.argv.slice(2), { cwd: REPO_ROOT });
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	process.exitCode = result.exitCode;
}
