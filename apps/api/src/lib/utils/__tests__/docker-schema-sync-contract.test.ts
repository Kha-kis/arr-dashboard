import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Docker schema synchronization contract", () => {
	const startupScript = readFileSync(
		resolve(process.cwd(), "../../docker/start-combined.sh"),
		"utf8",
	);

	it("synchronizes the runtime schema without approving data loss", () => {
		expect(startupScript).toContain("prisma db push --schema prisma/schema.prisma");
		expect(startupScript).not.toContain(
			"prisma db push --schema prisma/schema.prisma --accept-data-loss",
		);
	});

	it("keeps an actionable fail-closed message for destructive changes", () => {
		expect(startupScript).toContain(
			"Destructive schema changes are intentionally rejected at startup",
		);
		expect(startupScript).toContain("consult the release notes for an explicit upgrade path");
	});

	it("does not echo any portion of DATABASE_URL on synchronization failure", () => {
		expect(startupScript).not.toContain("Current DATABASE_URL");
		expect(startupScript).not.toContain("DATABASE_URL%%");
		expect(startupScript).toContain("Detected database provider: $DB_PROVIDER");
	});

	it("launches services as the processes tracked by the shutdown trap", () => {
		expect(startupScript).toContain("exec env MALLOC_ARENA_MAX=$MALLOC_ARENA_MAX API_HOST=$HOST");
		expect(startupScript).toContain("exec env API_HOST=http://localhost:$API_PORT PORT=$PORT");
		expect(startupScript).not.toContain(
			'run_as_user sh -c "cd /config/heap-snapshots && MALLOC_ARENA_MAX=',
		);
	});

	it("runs the failed-start diagnostic through timeout without invoking a shell function", () => {
		expect(startupScript).not.toContain("timeout 10 run_as_user");
		expect(startupScript).toContain("timeout 10 sh -c");
		expect(startupScript).toContain("timeout 10 su-exec abc sh -c");
	});

	it("exits the combined container when either tracked service stops", () => {
		expect(startupScript).toContain(
			'while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null',
		);
		expect(startupScript).not.toMatch(/^\s*wait \$API_PID \$WEB_PID\s*$/m);
	});
});
