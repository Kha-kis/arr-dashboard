#!/usr/bin/env tsx

/**
 * OIDC Recovery Tool
 *
 * This script is used to recover from OIDC misconfiguration when the user is locked out.
 * It deletes the OIDC provider configuration and sets a recovery password for the admin user.
 *
 * Usage:
 *   pnpm --filter @arr/api run reset-oidc
 *
 * Or in Docker:
 *   docker exec -it arr-dashboard pnpm --filter @arr/api run reset-oidc
 */

import "dotenv/config";
import * as readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password.js";

const prisma = new PrismaClient();

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

const question = (prompt: string): Promise<string> =>
	new Promise((resolve) => rl.question(prompt, resolve));

const validatePassword = (
	password: string,
): { valid: boolean; error?: string } => {
	if (password.length < 8) {
		return { valid: false, error: "Password must be at least 8 characters" };
	}
	if (!/[a-z]/.test(password)) {
		return {
			valid: false,
			error: "Password must contain at least one lowercase letter",
		};
	}
	if (!/[A-Z]/.test(password)) {
		return {
			valid: false,
			error: "Password must contain at least one uppercase letter",
		};
	}
	if (!/[0-9]/.test(password)) {
		return { valid: false, error: "Password must contain at least one number" };
	}
	if (!/[^a-zA-Z0-9]/.test(password)) {
		return {
			valid: false,
			error: "Password must contain at least one special character",
		};
	}
	return { valid: true };
};

/**
 * OIDC Recovery - Deletes OIDC configuration and restores password authentication.
 *
 * This tool is intended for recovery when the user is locked out due to OIDC misconfiguration.
 * It performs the following operations in a transaction:
 * 1. Deletes all OIDC account links
 * 2. Deletes the OIDC provider configuration
 * 3. Sets a recovery password for the admin user
 * 4. Invalidates all existing sessions
 */
async function main() {
	console.log("\n=== OIDC Recovery Tool ===\n");

	// Check if OIDC provider exists
	const provider = await prisma.oIDCProvider.findUnique({
		where: { id: 1 },
	});

	if (!provider) {
		console.log("No OIDC provider is currently configured.");
		console.log("If you're locked out, try the reset-admin-password script instead.\n");
		rl.close();
		await prisma.$disconnect();
		return;
	}

	console.log("Found OIDC provider:");
	console.log(`  Display Name: ${provider.displayName}`);
	console.log(`  Issuer: ${provider.issuer}`);
	console.log(`  Enabled: ${provider.enabled}\n`);

	// Find admin user (single-admin architecture)
	const admin = await prisma.user.findFirst({
		orderBy: { createdAt: "asc" },
	});

	if (!admin) {
		console.error("Error: No user found in the database.");
		console.log("The database appears to be empty.\n");
		process.exit(1);
	}

	console.log("Admin account:");
	console.log(`  Username: ${admin.username}`);
	console.log(`  Has Password: ${admin.hashedPassword ? "Yes" : "No"}\n`);

	// Confirm action
	const confirm = await question(
		"This will delete the OIDC configuration and require a new password.\nType 'yes' to continue: ",
	);

	if (confirm.toLowerCase() !== "yes") {
		console.log("\nOperation cancelled.\n");
		rl.close();
		await prisma.$disconnect();
		return;
	}

	// Get new password
	console.log("\nSet a recovery password for the admin account.\n");
	const password = await question("Enter new password: ");

	// Validate password
	const validation = validatePassword(password);
	if (!validation.valid) {
		console.error(`\nError: ${validation.error}`);
		console.log("\nPassword requirements:");
		console.log("  - At least 8 characters");
		console.log("  - Contains uppercase letter");
		console.log("  - Contains lowercase letter");
		console.log("  - Contains number");
		console.log("  - Contains special character");
		process.exit(1);
	}

	// Confirm password
	const passwordConfirm = await question("Confirm new password: ");

	if (password !== passwordConfirm) {
		console.error("\nError: Passwords do not match.");
		process.exit(1);
	}

	// Execute recovery in transaction
	console.log("\nExecuting OIDC recovery...");

	const hashedPassword = await hashPassword(password);

	await prisma.$transaction(async (tx) => {
		// Delete all OIDC account links
		const deletedAccounts = await tx.oIDCAccount.deleteMany({});
		console.log(`  ✓ Deleted ${deletedAccounts.count} OIDC account link(s)`);

		// Delete OIDC provider
		await tx.oIDCProvider.delete({
			where: { id: 1 },
		});
		console.log("  ✓ Deleted OIDC provider configuration");

		// Set recovery password for admin
		await tx.user.update({
			where: { id: admin.id },
			data: {
				hashedPassword,
				failedLoginAttempts: 0,
				lockedUntil: null,
			},
		});
		console.log("  ✓ Set recovery password for admin account");

		// Invalidate all sessions
		const deletedSessions = await tx.session.deleteMany({});
		console.log(`  ✓ Invalidated ${deletedSessions.count} session(s)`);
	});

	console.log("\n=== Recovery Complete ===\n");
	console.log("OIDC authentication has been disabled.");
	console.log("You can now login with:");
	console.log(`  Username: ${admin.username}`);
	console.log("  Password: (the one you just set)\n");
	console.log("To reconfigure OIDC, go to Settings > Authentication after logging in.\n");

	rl.close();
	await prisma.$disconnect();
}

main().catch(async (error) => {
	console.error("\nFailed to perform OIDC recovery:");
	console.error(error);
	rl.close();
	await prisma.$disconnect();
	process.exit(1);
});
