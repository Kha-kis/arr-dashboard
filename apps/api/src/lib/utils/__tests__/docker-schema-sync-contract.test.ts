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

	it("hands the runtime schema to a remapped PUID before synchronization", () => {
		const ownershipHandoff = startupScript.indexOf(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This must match the literal shell expansion in the startup script.
			'chown "${PUID}:${PGID}" /app/api/prisma/schema.prisma',
		);
		const schemaSync = startupScript.indexOf("prisma db push --schema prisma/schema.prisma");

		expect(ownershipHandoff).toBeGreaterThan(-1);
		expect(schemaSync).toBeGreaterThan(ownershipHandoff);
	});

	it("restores schema ownership before regenerating for a provider switch", () => {
		const providerSwitch = startupScript.indexOf('echo "  - Schema updated successfully"');
		const ownershipHandoff = startupScript.indexOf(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: This must match the literal shell expansion in the startup script.
			'chown "${PUID}:${PGID}" /app/api/prisma/schema.prisma',
			providerSwitch,
		);
		const clientGeneration = startupScript.indexOf(
			"run_as_user ./node_modules/.bin/prisma generate --schema prisma/schema.prisma",
			providerSwitch,
		);

		expect(providerSwitch).toBeGreaterThan(-1);
		expect(ownershipHandoff).toBeGreaterThan(providerSwitch);
		expect(clientGeneration).toBeGreaterThan(ownershipHandoff);
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
