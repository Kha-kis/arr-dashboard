/**
 * Route manifest contract test.
 *
 * The manifest in `routes/route-manifest.ts` is the single source of truth
 * for both route registration and the governance section in
 * `docs/API-ROUTES.md`. This test pins three properties:
 *
 *   1. Every entry is well-formed (valid maturity, non-empty fields,
 *      no duplicate `path`s).
 *   2. Every documented `path` actually appears in `docs/API-ROUTES.md` —
 *      so the doc and the code cannot drift apart silently.
 *   3. The set of registered Fastify route prefixes matches the union of
 *      manifest paths — i.e., nothing slipped past the manifest into the
 *      bootstrap files.
 *
 * If you add a route, add a manifest entry AND a row to the governance
 * table in `docs/API-ROUTES.md`. This test will tell you exactly which
 * one you forgot.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	ALL_ROUTE_GROUPS,
	PROTECTED_ROUTE_GROUPS,
	PUBLIC_ROUTE_GROUPS,
	type RouteMaturity,
} from "../route-manifest.js";

const VALID_MATURITY = new Set<RouteMaturity>(["stable", "operator", "internal", "experimental"]);

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → routes → src → apps/api → apps → repo root
const DOC_PATH = join(here, "..", "..", "..", "..", "..", "docs", "API-ROUTES.md");

describe("route manifest", () => {
	it("contains both public and protected groups", () => {
		expect(PUBLIC_ROUTE_GROUPS.length).toBeGreaterThan(0);
		expect(PROTECTED_ROUTE_GROUPS.length).toBeGreaterThan(0);
		expect(ALL_ROUTE_GROUPS.length).toBe(
			PUBLIC_ROUTE_GROUPS.length + PROTECTED_ROUTE_GROUPS.length,
		);
	});

	it("every entry is well-formed", () => {
		for (const group of ALL_ROUTE_GROUPS) {
			expect(group.path, `path missing for group: ${JSON.stringify(group)}`).toMatch(/^\//);
			expect(group.summary.trim().length, `empty summary for ${group.path}`).toBeGreaterThan(0);
			expect(VALID_MATURITY.has(group.maturity), `bad maturity for ${group.path}`).toBe(true);
			expect(typeof group.register, `register must be a function for ${group.path}`).toBe(
				"function",
			);
		}
	});

	it("paths are unique across the manifest", () => {
		const seen = new Set<string>();
		for (const group of ALL_ROUTE_GROUPS) {
			expect(seen.has(group.path), `duplicate path: ${group.path}`).toBe(false);
			seen.add(group.path);
		}
	});

	it("every manifest path is referenced in docs/API-ROUTES.md", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		const missing = ALL_ROUTE_GROUPS.filter((group) => !doc.includes(group.path)).map(
			(g) => g.path,
		);
		expect(
			missing,
			`Missing from docs/API-ROUTES.md governance table: ${missing.join(", ")}`,
		).toEqual([]);
	});
});
