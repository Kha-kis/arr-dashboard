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

function markdownLinesOutsideFences(markdown) {
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

export function validateReviewContractBody(markdown) {
	if (typeof markdown !== "string") {
		return { valid: false, errors: ["Pull request body must be Markdown text."], riskTier: null };
	}

	const errors = headingErrors(markdown);
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
