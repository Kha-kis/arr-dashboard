import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	parseEventPayload,
	runCli,
	validateReviewContractBody,
	validateReviewTemplate,
} from "./check-pr-review-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RISK_TIERS = ["Trivial", "Standard", "Safety-critical"];

function riskOptions(selectedTier) {
	return RISK_TIERS.map(
		(tier) => `- [${tier === selectedTier ? "x" : " "}] ${tier}`,
	).join("\n");
}

function body(selectedTier = "Standard") {
	return `## Summary

Adds a finite review contract.

## Related issue

Related to #1

## Scope

- Review tooling

## Non-goals

- Application behavior

## Acceptance criteria

- The checker accepts this body.

## Changes

- Adds deterministic validation.

## Risk classification

${riskOptions(selectedTier)}

## Validation

- Focused tests pass.

## Review plan

- Initial broad-reviewed head: pending

## Finding disposition

| ID | Severity | Classification | Reproduced evidence | Disposition | Follow-up |
| --- | --- | --- | --- | --- | --- |
| — | — | — | No findings yet | Pending review | — |

## Final merge gate

- [ ] Maintainer approved
`;
}

function template() {
	return body(null);
}

function omitSection(markdown, heading) {
	const lines = markdown.split("\n");
	const start = lines.indexOf(`## ${heading}`);
	assert.notEqual(start, -1, `fixture contains ${heading}`);
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith("## ")) {
		end += 1;
	}
	lines.splice(start, end - start);
	return lines.join("\n");
}

function assertFailure(result, messagePart) {
	assert.equal(result.valid, false);
	assert.ok(
		result.errors.some((message) => message.includes(messagePart)),
		`expected an error containing ${JSON.stringify(messagePart)}; got ${JSON.stringify(result.errors)}`,
	);
}

function withEventFile(payload, callback) {
	const root = mkdtempSync(path.join(tmpdir(), "pr-review-contract-"));
	try {
		const eventPath = path.join(root, "event.json");
		writeFileSync(eventPath, payload);
		return callback(eventPath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("valid standard PR body passes", () => {
	assert.deepEqual(validateReviewContractBody(body("Standard")), {
		valid: true,
		errors: [],
		riskTier: "Standard",
	});
});

test("valid safety-critical PR body passes", () => {
	assert.equal(validateReviewContractBody(body("Safety-critical")).valid, true);
});

test("valid trivial PR body passes", () => {
	assert.equal(validateReviewContractBody(body("Trivial")).valid, true);
});

test("missing Scope fails", () => {
	assertFailure(validateReviewContractBody(omitSection(body(), "Scope")), "Scope");
});

test("missing Non-goals fails", () => {
	assertFailure(validateReviewContractBody(omitSection(body(), "Non-goals")), "Non-goals");
});

test("missing Finding disposition fails", () => {
	assertFailure(
		validateReviewContractBody(omitSection(body(), "Finding disposition")),
		"Finding disposition",
	);
});

test("missing Final merge gate fails", () => {
	assertFailure(
		validateReviewContractBody(omitSection(body(), "Final merge gate")),
		"Final merge gate",
	);
});

test("duplicate required heading fails", () => {
	const duplicate = body().replace("## Scope\n", "## Scope\n\n## Scope\n");
	assertFailure(validateReviewContractBody(duplicate), "Duplicate required heading: Scope");
});

test("no risk tier selected fails", () => {
	assertFailure(validateReviewContractBody(body(null)), "Select exactly one risk tier");
});

test("two risk tiers selected fail", () => {
	const two = body("Standard").replace("- [ ] Trivial", "- [x] Trivial");
	assertFailure(validateReviewContractBody(two), "Select exactly one risk tier");
});

test("three risk tiers selected fail", () => {
	const three = body("Standard")
		.replace("- [ ] Trivial", "- [x] Trivial")
		.replace("- [ ] Safety-critical", "- [x] Safety-critical");
	assertFailure(validateReviewContractBody(three), "Select exactly one risk tier");
});

test("uppercase selected checkbox is accepted", () => {
	const uppercase = body("Standard").replace("- [x] Standard", "- [X] Standard");
	assert.equal(validateReviewContractBody(uppercase).valid, true);
});

test("CRLF body passes", () => {
	assert.equal(validateReviewContractBody(body().replaceAll("\n", "\r\n")).valid, true);
});

test("lone-CR body passes", () => {
	assert.equal(validateReviewContractBody(body().replaceAll("\n", "\r")).valid, true);
});

test("headings inside fenced code blocks do not satisfy the contract", () => {
	const missingScope = omitSection(body(), "Scope");
	const fenced = missingScope.replace(
		"## Changes\n",
		"## Changes\n\n```markdown\n## Scope\n\nNot a real section.\n```\n",
	);
	assertFailure(validateReviewContractBody(fenced), "Scope");
});

test("fence-like content with trailing text does not close a fenced block", () => {
	const missingScope = omitSection(body(), "Scope");
	const fenced = missingScope.replace(
		"## Changes\n",
		"## Changes\n\n```text\n```not-a-closing-fence\n## Scope\n```\n",
	);
	assertFailure(validateReviewContractBody(fenced), "Scope");
});

test("selected risk checkbox outside Risk classification does not count", () => {
	const misplaced = body(null).replace(
		"Adds a finite review contract.",
		"Adds a finite review contract.\n\n- [x] Standard",
	);
	assertFailure(validateReviewContractBody(misplaced), "Select exactly one risk tier");
});

test("malformed event JSON fails", () => {
	assertFailure(parseEventPayload("{not-json"), "valid JSON");
});

test("event without pull_request fails", () => {
	assertFailure(parseEventPayload(JSON.stringify({ sender: { login: "Kha-kis" } })), "pull_request");
});

test("event with null PR body fails", () => {
	assertFailure(
		parseEventPayload(
			JSON.stringify({ pull_request: { body: null, user: { login: "Kha-kis" } } }),
		),
		"body",
	);
});

test("Dependabot actor is explicitly exempt", () => {
	withEventFile(
		JSON.stringify({
			pull_request: { body: null, user: { login: "dependabot[bot]" } },
		}),
		(eventPath) => {
			const result = runCli(["--event-path", eventPath]);
			assert.equal(result.exitCode, 0);
			assert.match(result.stdout, /dependabot\[bot\].*exempt/i);
		},
	);
});

test("arbitrary bot-suffixed actor is not exempt", () => {
	withEventFile(
		JSON.stringify({
			pull_request: { body: body(null), user: { login: "something[bot]" } },
		}),
		(eventPath) => {
			const result = runCli(["--event-path", eventPath]);
			assert.equal(result.exitCode, 1);
			assert.match(result.stderr, /Select exactly one risk tier/);
		},
	);
});

test("blank repository template passes template validation", () => {
	assert.equal(validateReviewTemplate(template()).valid, true);
});

test("template missing a required heading fails", () => {
	assertFailure(validateReviewTemplate(omitSection(template(), "Acceptance criteria")), "Acceptance criteria");
});

test("template missing a required risk option fails", () => {
	assertFailure(
		validateReviewTemplate(template().replace("- [ ] Safety-critical\n", "")),
		"Safety-critical",
	);
});

test("template with an additional risk option fails", () => {
	assertFailure(
		validateReviewTemplate(template().replace("- [ ] Standard", "- [ ] Standard\n- [ ] Emergency")),
		"Emergency",
	);
});

test("contract hidden inside an HTML comment fails", () => {
	assertFailure(validateReviewContractBody(`<!--\n${body()}\n-->`), "Summary");
});

test("HTML comment marker inside a fenced block remains inert", () => {
	const fencedLiteral = body().replace(
		"## Related issue",
		"```text\n<!-- literal comment marker inside a fenced example\n```\n\n## Related issue",
	);
	assert.equal(validateReviewContractBody(fencedLiteral).valid, true);
});

test("CLI options are mutually exclusive", () => {
	const result = runCli(["--template", "--body-file", "body.md"]);
	assert.equal(result.exitCode, 1);
	assert.match(result.stderr, /mutually exclusive/i);
});

test("no-argument local mode validates the real repository template", () => {
	const result = runCli([], { cwd: REPO_ROOT, env: {} });
	assert.equal(result.exitCode, 0, result.stderr);
	assert.match(result.stdout, /template.*valid/i);
});

test("body content resembling shell syntax is treated only as text", () => {
	const root = mkdtempSync(path.join(tmpdir(), "pr-review-contract-inert-"));
	try {
		const marker = path.join(root, "must-not-exist");
		const shellLikeBody = `${body()}\n$(touch ${marker})\n\`touch ${marker}\`\n`;
		assert.equal(validateReviewContractBody(shellLikeBody).valid, true);
		assert.equal(existsSync(marker), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
