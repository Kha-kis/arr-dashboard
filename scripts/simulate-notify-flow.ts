/**
 * Simulate Notify Strategy Flow
 *
 * This script simulates the notify sync strategy by:
 * 1. Setting a template's mapping to "notify" strategy
 * 2. Making the template "outdated" by setting an old commit hash
 * 3. Shows what would happen when the scheduler runs
 *
 * Run with: npx tsx scripts/simulate-notify-flow.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TRASH_GUIDES_REPO = "TRaSH-Guides/Guides";
const GITHUB_API = "https://api.github.com";

// An old commit hash to simulate outdated template
const OLD_COMMIT_HASH = "0000000000000000000000000000000000000000";

async function getLatestCommitHash(): Promise<string | null> {
  try {
    const response = await fetch(
      `${GITHUB_API}/repos/${TRASH_GUIDES_REPO}/commits/master`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "arr-dashboard",
        },
      }
    );

    if (!response.ok) {
      console.error(`GitHub API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    return data.sha;
  } catch (error) {
    console.error("Failed to fetch latest commit:", error);
    return null;
  }
}

async function main() {
  console.log("=== Simulate Notify Strategy Flow ===\n");

  // Get latest commit for reference
  const latestCommit = await getLatestCommitHash();
  console.log(`Latest TRaSH Guides commit: ${latestCommit?.substring(0, 8) || "unknown"}\n`);

  // Find templates with mappings
  const templates = await prisma.trashTemplate.findMany({
    where: {
      deletedAt: null,
    },
    include: {
      qualityProfileMappings: {
        include: {
          instance: true,
        },
      },
    },
  });

  if (templates.length === 0) {
    console.log("No templates found. Please create a template first.");
    return;
  }

  console.log("Found templates:");
  templates.forEach((t, i) => {
    const mappings = t.qualityProfileMappings.length;
    const strategies = t.qualityProfileMappings.map(m => m.syncStrategy).join(", ") || "none";
    console.log(`  ${i + 1}. ${t.name}`);
    console.log(`     - ID: ${t.id}`);
    console.log(`     - Commit: ${t.trashGuidesCommitHash?.substring(0, 8) || "none"}`);
    console.log(`     - Mappings: ${mappings} (strategies: ${strategies})`);
  });

  // Find a template with at least one mapping
  const templateWithMapping = templates.find(t => t.qualityProfileMappings.length > 0);

  if (!templateWithMapping) {
    console.log("\n❌ No templates with instance mappings found.");
    console.log("   To test notify, you need to deploy a template first.\n");

    // Still show what would happen
    console.log("--- What Notify Strategy Does ---\n");
    console.log("1. When you DEPLOY a template to an instance, you choose a sync strategy:");
    console.log("   - Auto: Updates are automatically synced and deployed");
    console.log("   - Notify: You get notified of updates but must manually sync");
    console.log("   - Manual: No automatic actions at all\n");

    console.log("2. The strategy is stored per instance mapping in TemplateQualityProfileMapping\n");

    console.log("3. When the scheduler detects an outdated template:");
    console.log("   - Auto strategy: Template is synced and deployed automatically");
    console.log("   - Notify strategy: Notification is added to template's changeLog");
    console.log("   - Manual strategy: No action taken\n");

    console.log("4. For notify, the notification appears as:");
    console.log('   { type: "update_available", reason: "notify_strategy", dismissed: false }');
    console.log("   This triggers the TemplateUpdateBanner in the UI.\n");
    return;
  }

  console.log(`\n=== Simulating with template: ${templateWithMapping.name} ===\n`);

  // Ask user what to do
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("What would you like to do?\n");
  console.log("1. Change first mapping to 'notify' strategy");
  console.log("2. Make template 'outdated' (set old commit hash)");
  console.log("3. Add a test notification to template's changeLog");
  console.log("4. Show current state only");
  console.log("5. Reset to latest commit (remove outdated status)");
  console.log("6. Exit\n");

  const choice = await question("Enter choice (1-6): ");
  rl.close();

  switch (choice) {
    case "1": {
      // Change first mapping to notify
      const firstMapping = templateWithMapping.qualityProfileMappings[0];
      if (!firstMapping) {
        console.log("No mappings found.");
        break;
      }

      console.log(`\nChanging mapping ${firstMapping.id} from '${firstMapping.syncStrategy}' to 'notify'...`);

      await prisma.templateQualityProfileMapping.update({
        where: { id: firstMapping.id },
        data: { syncStrategy: "notify" },
      });

      console.log("✅ Updated sync strategy to 'notify'");
      console.log("\nNow when the scheduler runs and finds this template outdated,");
      console.log("it will create a notification instead of auto-syncing.");
      break;
    }

    case "2": {
      // Make template outdated
      console.log(`\nSetting template commit hash to old value...`);
      console.log(`  Current: ${templateWithMapping.trashGuidesCommitHash?.substring(0, 8) || "none"}`);
      console.log(`  Setting to: ${OLD_COMMIT_HASH.substring(0, 8)}`);

      await prisma.trashTemplate.update({
        where: { id: templateWithMapping.id },
        data: { trashGuidesCommitHash: OLD_COMMIT_HASH },
      });

      console.log("✅ Template is now 'outdated'");
      console.log("\nTrigger a scheduler check to see the notify flow in action.");
      console.log("Use the 'Trigger Check Now' button in the Scheduler Status Dashboard.");
      break;
    }

    case "3": {
      // Add test notification
      console.log(`\nAdding test notification to changeLog...`);

      let changeLog: any[] = [];
      if (templateWithMapping.changeLog) {
        try {
          changeLog = JSON.parse(templateWithMapping.changeLog as string);
        } catch {
          changeLog = [];
        }
      }

      changeLog.push({
        type: "update_available",
        timestamp: new Date().toISOString(),
        currentCommit: templateWithMapping.trashGuidesCommitHash || "unknown",
        latestCommit: latestCommit || "unknown",
        reason: "notify_strategy",
        dismissed: false,
      });

      await prisma.trashTemplate.update({
        where: { id: templateWithMapping.id },
        data: { changeLog: JSON.stringify(changeLog) },
      });

      console.log("✅ Added test notification");
      console.log("\nThis simulates what the scheduler creates when a notify-strategy");
      console.log("template has an update available. Check the template in the UI.");
      break;
    }

    case "4": {
      // Show current state
      console.log("\n--- Current Template State ---\n");
      console.log(`Name: ${templateWithMapping.name}`);
      console.log(`ID: ${templateWithMapping.id}`);
      console.log(`Commit: ${templateWithMapping.trashGuidesCommitHash?.substring(0, 8) || "none"}`);
      console.log(`Latest: ${latestCommit?.substring(0, 8) || "unknown"}`);
      console.log(`Outdated: ${templateWithMapping.trashGuidesCommitHash !== latestCommit ? "YES" : "NO"}`);
      console.log(`User Modifications: ${templateWithMapping.hasUserModifications}`);

      console.log("\nMappings:");
      templateWithMapping.qualityProfileMappings.forEach((m, i) => {
        console.log(`  ${i + 1}. Instance: ${m.instance?.name || m.instanceId}`);
        console.log(`     Strategy: ${m.syncStrategy}`);
        console.log(`     Profile ID: ${m.profileId}`);
      });

      if (templateWithMapping.changeLog) {
        try {
          const log = JSON.parse(templateWithMapping.changeLog as string);
          const notifications = log.filter((e: any) => e.type === "update_available" && !e.dismissed);
          console.log(`\nPending Notifications: ${notifications.length}`);
          notifications.forEach((n: any, i: number) => {
            console.log(`  ${i + 1}. Reason: ${n.reason}, Date: ${n.timestamp}`);
          });
        } catch {
          console.log("\nChangeLog: (unparseable)");
        }
      }
      break;
    }

    case "5": {
      // Reset to latest commit
      if (!latestCommit) {
        console.log("Could not fetch latest commit.");
        break;
      }

      console.log(`\nResetting template to latest commit: ${latestCommit.substring(0, 8)}...`);

      await prisma.trashTemplate.update({
        where: { id: templateWithMapping.id },
        data: {
          trashGuidesCommitHash: latestCommit,
          lastSyncedAt: new Date(),
        },
      });

      console.log("✅ Template is now up-to-date");
      break;
    }

    case "6":
    default:
      console.log("Exiting.");
      break;
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
