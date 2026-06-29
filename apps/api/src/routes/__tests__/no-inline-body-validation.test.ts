/**
 * Charter §7 L1 — `no-inline-Body-without-validateRequest` (CI gate).
 *
 * A Fastify route that declares a CONCRETE `Body:` type in its generic and
 * then trusts `request.body` as that type is the same validation-bypass hole
 * as `request.body as Type`, just different syntax (CLAUDE.md rule 5). Bucket
 * A6 (#510) migrated the known offenders to `validateRequest()`; this guard
 * turns that one-time cleanup into a permanent gate so the bypass can't creep
 * back in.
 *
 * Why a test and not an ESLint rule: `apps/api` is linted by Biome, which has
 * no custom-AST-rule mechanism (no plugins / no-restricted-syntax). The
 * codebase already enforces an API-side governance invariant this exact way —
 * see `pulse-collector-label.test.ts` (charter §7 L2). This mirrors it.
 *
 * Granularity: file-level. A route file that declares any non-`unknown`
 * `Body:` generic must call `validateRequest` somewhere in the file. This is
 * deliberately coarse (matches L2's pragmatism) — it catches the gross
 * "type Body concretely and trust it" bypass without a full TS-AST walk.
 * `Body: unknown` is the safe canonical (unusable without narrowing) and is
 * exempt. A genuine carve-out can add a `// l1-guard-exempt: <reason>`
 * comment to the file.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function walkRouteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "__tests__") continue;
			out.push(...walkRouteFiles(full));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

// Capture the type text after a `Body:` generic key, up to the next type
// boundary (`;`, `,`, `}`, `>`, newline). Coarse, but enough to decide the
// only thing that matters here: is the declared Body `unknown` (safe) or
// something concrete (must be validated)?
const BODY_DECL = /Body:\s*([^;\n},>]+)/g;

function declaresConcreteBody(source: string): boolean {
	for (const match of source.matchAll(BODY_DECL)) {
		const type = match[1]?.trim();
		if (type && type !== "unknown") return true;
	}
	return false;
}

describe("charter §7 L1 — no inline Body: typing without validateRequest", () => {
	const files = walkRouteFiles(ROUTES_DIR);

	it("scans the route tree (sanity: the walker found route files)", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it("every route file with a concrete Body: generic also calls validateRequest", () => {
		const offenders: string[] = [];

		for (const file of files) {
			const source = readFileSync(file, "utf8");
			if (source.includes("l1-guard-exempt")) continue;
			if (declaresConcreteBody(source) && !source.includes("validateRequest(")) {
				offenders.push(relative(ROUTES_DIR, file));
			}
		}

		expect(
			offenders,
			`These route files declare a concrete Body: generic but never call validateRequest() — ` +
				`parse the body with validateRequest() (lib/utils/validate.ts) instead of trusting the ` +
				`typed generic, or use 'Body: unknown'. Offending files:\n  ${offenders.join("\n  ")}`,
		).toEqual([]);
	});
});
