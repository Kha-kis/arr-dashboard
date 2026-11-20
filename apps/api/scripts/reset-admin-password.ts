#!/usr/bin/env tsx
// Development compatibility entrypoint; uses the same offline owner-fenced actor.
// Production containers use the installed reset-admin-password wrapper.
import { runAdminRecoveryCli } from "../src/reset-admin-password.js";

void runAdminRecoveryCli()
	.then((code) => {
		process.exitCode = code;
	})
	.catch(() => {
		process.exitCode = 1;
	});
