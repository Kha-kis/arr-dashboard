import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Docker schema synchronization contract", () => {
	const startupScript = readFileSync(
		resolve(process.cwd(), "../../docker/start-combined.sh"),
		"utf8",
	);

	it("synchronizes the runtime schema without approving data loss", () => {
		const schemaSyncCommand = startupScript
			.split("\n")
			.find((line) => line.includes("prisma db push"));

		expect(schemaSyncCommand).toContain("prisma db push --schema prisma/schema.prisma");
		expect(schemaSyncCommand).not.toContain("--accept-data-loss");
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
});
