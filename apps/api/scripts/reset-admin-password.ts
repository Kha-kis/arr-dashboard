#!/usr/bin/env tsx

import "dotenv/config";
import * as readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/utils/password.js";

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

async function main() {
  console.log("\n=== Admin Password Reset Tool ===\n");

  // Find user (single-admin architecture - first user is admin)
  const admin = await prisma.user.findFirst({
    orderBy: { createdAt: "asc" },
  });

  if (!admin) {
    console.error("Error: No user found in the database.");
    console.log("Please run the setup flow to create an account.");
    process.exit(1);
  }

  console.log("Found user account:");
  console.log(`  Username: ${admin.username}\n`);

  // Get new password
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
  const confirm = await question("Confirm new password: ");

  if (password !== confirm) {
    console.error("\nError: Passwords do not match.");
    process.exit(1);
  }

  // Hash and update
  console.log("\nUpdating password...");
  const hashedPassword = await hashPassword(password);

  await prisma.user.update({
    where: { id: admin.id },
    data: {
      hashedPassword,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  // Invalidate all sessions
  const deletedSessions = await prisma.session.deleteMany({
    where: { userId: admin.id },
  });

  console.log("\n✓ Password reset successfully");
  console.log(`✓ ${deletedSessions.count} active session(s) invalidated`);
  console.log("✓ Account lockout cleared\n");
  console.log("You can now login with your new password.\n");

  rl.close();
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("\nFailed to reset password:");
  console.error(error);
  process.exit(1);
});
