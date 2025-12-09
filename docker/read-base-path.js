#!/usr/bin/env node
/**
 * Helper script to read system settings from database
 * Used by start-combined.sh to set environment variables before starting services
 *
 * Outputs JSON with all settings: { urlBase, apiPort, webPort }
 * Exit code 0 regardless (missing settings is not an error)
 */

const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();

  try {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { urlBase: true, apiPort: true, webPort: true },
    });

    // Output JSON with settings (or defaults if not found)
    const output = {
      urlBase: settings?.urlBase || '',
      apiPort: settings?.apiPort || 3001,
      webPort: settings?.webPort || 3000,
    };

    process.stdout.write(JSON.stringify(output));
  } catch (error) {
    // Silently ignore errors (table might not exist on first run)
    // Output defaults so startup can continue
    process.stdout.write(JSON.stringify({
      urlBase: '',
      apiPort: 3001,
      webPort: 3000,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  // Ensure we exit cleanly even on unexpected errors
  // Output defaults so startup can continue
  process.stdout.write(JSON.stringify({
    urlBase: '',
    apiPort: 3001,
    webPort: 3000,
  }));
  process.exit(0);
});
