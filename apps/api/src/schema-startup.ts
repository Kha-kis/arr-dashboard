#!/usr/bin/env node

/** Pre-launch native schema/settings actor. It never starts application services. */
import {
	RuntimeSchemaStartupError,
	synchronizeRuntimeSchema,
} from "./lib/backup/runtime-schema-startup.js";

try {
	// This actor accepts no reset, force, ownership or data-loss override flags.
	if (process.argv.length !== 2) throw new RuntimeSchemaStartupError();
	const settings = await synchronizeRuntimeSchema(process.env.DATABASE_URL ?? "");
	// The native writer has proved closure before this positive result is visible.
	process.stdout.write(`${JSON.stringify(settings)}\n`);
} catch (error) {
	const category =
		error instanceof RuntimeSchemaStartupError ? error.category : "startup-unavailable";
	process.stderr.write(`ERROR: Database schema startup is unavailable (${category}).\n`);
	process.exitCode = 1;
}
