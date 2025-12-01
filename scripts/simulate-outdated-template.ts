#!/usr/bin/env npx tsx

/**
 * Simulate Outdated Template - Testing Script
 *
 * This script modifies a template's commit hash to an older version
 * to simulate an outdated template for testing the update system.
 *
 * Usage: npx tsx scripts/simulate-outdated-template.ts [templateId]
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Use an older commit hash from TRaSH Guides history
// This commit is from October 2024, safely in the past
// Source: https://github.com/TRaSH-Guides/Guides/commits/master
const OLD_COMMIT_HASH = 'a3f8e2d7c9b1456e8d2a7f3c5b9e1d4a6c8f2e5b'; // Simulated old commit for testing

async function simulateOutdatedTemplate(templateId?: string) {
  try {
    console.log('🔍 Fetching templates...\n');

    // Get all templates or specific template
    const templates = await prisma.trashTemplate.findMany({
      where: templateId ? { id: templateId } : undefined,
      select: {
        id: true,
        name: true,
        trashGuidesCommitHash: true,
        syncStrategy: true,
        hasUserModifications: true,
      },
    });

    if (templates.length === 0) {
      console.error('❌ No templates found');
      process.exit(1);
    }

    console.log(`Found ${templates.length} template(s):\n`);
    templates.forEach((t, idx) => {
      console.log(`${idx + 1}. ${t.name} (${t.id})`);
      console.log(`   Sync Strategy: ${t.syncStrategy}`);
      console.log(`   Modified: ${t.hasUserModifications}`);
      console.log(`   Current Commit: ${t.trashGuidesCommitHash?.substring(0, 8) || 'N/A'}`);
      console.log('');
    });

    // If no specific template, ask user to provide one
    if (!templateId) {
      console.log('\n⚠️  Please specify a template ID:');
      console.log('npx tsx scripts/simulate-outdated-template.ts <templateId>\n');
      process.exit(0);
    }

    const template = templates[0];

    console.log(`\n🔄 Updating template: ${template.name}`);
    console.log(`Setting commit to older version: ${OLD_COMMIT_HASH}\n`);

    // Update the template with an old commit hash
    await prisma.trashTemplate.update({
      where: { id: template.id },
      data: {
        trashGuidesCommitHash: OLD_COMMIT_HASH,
      },
    });

    console.log('✅ Template updated successfully!');
    console.log('\n📋 Next steps:');
    console.log('1. Navigate to http://localhost:3000/trash-guides');
    console.log('2. Go to "Update Scheduler" tab');
    console.log('3. Click "Trigger Check Now"');
    console.log('4. Return to "Templates" tab to see update banner');
    console.log('\n🔄 To reset, run the scheduler check again or manually update the commit hash');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Get template ID from command line args
const templateId = process.argv[2];

(async () => {
  try {
    await simulateOutdatedTemplate(templateId);
    process.exit(0);
  } catch (error) {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  }
})();
