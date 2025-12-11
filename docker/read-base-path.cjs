#!/usr/bin/env node
/**
 * Helper script to read system settings from database
 * Used by start-combined.sh to set environment variables before starting services
 *
 * Outputs JSON with settings: { apiPort, webPort, listenAddress }
 * Exit code 0 regardless (missing settings is not an error)
 */

const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();

  try {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { apiPort: true, webPort: true, listenAddress: true },
    });

    // Output JSON with settings (or defaults if not found)
    const output = {
      apiPort: settings?.apiPort || 3001,
      webPort: settings?.webPort || 3000,
      listenAddress: settings?.listenAddress || '0.0.0.0',
    };

    process.stdout.write(JSON.stringify(output));
  } catch (error) {
    // Silently ignore errors (table might not exist on first run)
    // Output defaults so startup can continue
    process.stdout.write(JSON.stringify({
      apiPort: 3001,
      webPort: 3000,
      listenAddress: '0.0.0.0',
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // Ensure we exit cleanly even on unexpected errors
  // Output defaults so startup can continue
  process.stdout.write(JSON.stringify({
    apiPort: 3001,
    webPort: 3000,
    listenAddress: '0.0.0.0',
  }));
  process.exit(0);
});
