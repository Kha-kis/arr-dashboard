#!/usr/bin/env npx tsx

/**
 * List Templates - Helper Script
 *
 * Lists all TRaSH Guides templates with their current version info
 *
 * Usage: npx tsx scripts/list-templates.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listTemplates() {
  try {
    console.log('📋 TRaSH Guides Templates\n');

    const templates = await prisma.trashTemplate.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        serviceType: true,
        trashGuidesCommitHash: true,
        trashGuidesVersion: true,
        sourceQualityProfileName: true,
        sourceQualityProfileTrashId: true,
        syncStrategy: true,
        hasUserModifications: true,
        lastSyncedAt: true,
        importedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    if (templates.length === 0) {
      console.log('No templates found');
      process.exit(0);
    }

    console.log(`Found ${templates.length} template(s):\n`);
    console.log('─'.repeat(80) + '\n');

    templates.forEach((template, idx) => {
      console.log(`${idx + 1}. ${template.name}`);
      console.log(`   ID: ${template.id}`);
      console.log(`   Service: ${template.serviceType}`);
      if (template.sourceQualityProfileName) {
        console.log(`   Source Profile: ${template.sourceQualityProfileName}`);
      }
      console.log(`   Sync Strategy: ${template.syncStrategy}`);
      console.log(`   Modified: ${template.hasUserModifications ? 'Yes ⚠️' : 'No'}`);
      console.log(`   Current Commit: ${template.trashGuidesCommitHash?.substring(0, 8) || 'N/A'}`);
      if (template.lastSyncedAt) {
        console.log(`   Last Synced: ${template.lastSyncedAt.toLocaleDateString()}`);
      }
      console.log(`   Imported: ${template.importedAt.toLocaleDateString()}`);
      console.log(`   Updated: ${template.updatedAt.toLocaleDateString()}`);
      console.log('');
    });

    console.log('─'.repeat(80) + '\n');
    console.log('💡 To simulate an outdated template:');
    console.log('   npx tsx scripts/simulate-outdated-template.ts <templateId>\n');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

listTemplates();
