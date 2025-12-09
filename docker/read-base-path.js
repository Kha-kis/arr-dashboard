#!/usr/bin/env node
/**
 * Helper script to read BASE_PATH from database
 * Used by start-combined.sh to set environment variable before starting web server
 *
 * Outputs the urlBase value if set, otherwise outputs nothing
 * Exit code 0 regardless (missing setting is not an error)
 */

const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();

  try {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { urlBase: true },
    });

    if (settings?.urlBase) {
      // Output the value without newline so it can be captured by shell
      process.stdout.write(settings.urlBase);
    }
  } catch (error) {
    // Silently ignore errors (table might not exist on first run)
    // The startup will continue with default empty BASE_PATH
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // Ensure we exit cleanly even on unexpected errors
  process.exit(0);
});
