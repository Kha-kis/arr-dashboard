/**
 * Fix Template Commit Hashes
 *
 * This script updates existing templates that are missing trashGuidesCommitHash
 * by setting it to the latest TRaSH Guides commit hash and marking lastSyncedAt.
 *
 * Run with: npx tsx scripts/fix-template-commit-hashes.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TRASH_GUIDES_REPO = "TRaSH-Guides/Guides";
const GITHUB_API = "https://api.github.com";

// Support GitHub token from environment to avoid rate limiting
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function getLatestCommitHash(): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "arr-dashboard",
    };

    // Add authorization header if token is available
    if (GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${TRASH_GUIDES_REPO}/commits/master`,
      { headers, signal: controller.signal }
    );

    if (!response.ok) {
      console.error(`GitHub API error: ${response.status} ${response.statusText}`);
      if (response.status === 403) {
        console.error("Rate limited. Set GITHUB_TOKEN environment variable to increase rate limit.");
      }
      return null;
    }

    const data = await response.json();
    return data.sha;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("GitHub API request timed out after 10 seconds");
      return null;
    }
    console.error("Failed to fetch latest commit:", error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main() {
  console.log("=== Fix Template Commit Hashes ===\n");

  // Get latest commit hash
  console.log("Fetching latest TRaSH Guides commit hash...");
  const latestCommitHash = await getLatestCommitHash();

  if (!latestCommitHash) {
    throw new Error("Failed to get latest commit hash. Aborting.");
  }

  console.log(`Latest commit hash: ${latestCommitHash}\n`);

  // Find templates without commit hash (need backfilling)
  const templatesWithoutHash = await prisma.trashTemplate.findMany({
    where: {
      deletedAt: null,
      trashGuidesCommitHash: null,
    },
    select: {
      id: true,
      name: true,
      serviceType: true,
      createdAt: true,
      trashGuidesCommitHash: true,
      changeLog: true,
    },
  });

  if (templatesWithoutHash.length === 0) {
    console.log("No templates found without commit hash. All templates are up to date!");
    return;
  }

  console.log(`Found ${templatesWithoutHash.length} templates without commit hash:\n`);

  for (const template of templatesWithoutHash) {
    console.log(`  - ${template.name} (${template.serviceType}) - ID: ${template.id}`);
  }

  console.log("\nPreparing updates...\n");

  const now = new Date();

  // Build array of update operations for atomic transaction
  type UpdateOperation = {
    templateId: string;
    templateName: string;
    data: {
      trashGuidesCommitHash: string;
      lastSyncedAt: Date;
      changeLog?: string;
    };
    updateType: "hash_only" | "full";
  };

  const updateOperations: UpdateOperation[] = [];

  for (const template of templatesWithoutHash) {
    // Parse changeLog from initial query (avoids N+1 queries)
    let changeLog: Array<{
      timestamp: string;
      userId?: string;
      changeType: string;
      description: string;
      commitHash?: string;
    }> = [];

    if (template.changeLog == null) {
      changeLog = [];
    } else if (typeof template.changeLog === "string") {
      try {
        changeLog = JSON.parse(template.changeLog);
      } catch {
        changeLog = [];
      }
    } else if (Array.isArray(template.changeLog)) {
      changeLog = template.changeLog as typeof changeLog;
    } else {
      // Unexpected type, reset to empty array
      changeLog = [];
    }

    // Check if migration entry with this commit hash already exists
    const existingMigrationEntry = changeLog.find(
      (entry) =>
        entry.changeType === "migration" && entry.commitHash === latestCommitHash
    );

    if (existingMigrationEntry) {
      // Update only trashGuidesCommitHash since changelog entry already exists
      updateOperations.push({
        templateId: template.id,
        templateName: template.name,
        data: {
          trashGuidesCommitHash: latestCommitHash,
          lastSyncedAt: now,
        },
        updateType: "hash_only",
      });
      continue;
    }

    // Add migration entry to changelog
    changeLog.push({
      timestamp: now.toISOString(),
      changeType: "migration",
      description: "Backfilled commit hash for version tracking",
      commitHash: latestCommitHash,
    });

    updateOperations.push({
      templateId: template.id,
      templateName: template.name,
      data: {
        trashGuidesCommitHash: latestCommitHash,
        lastSyncedAt: now,
        changeLog: JSON.stringify(changeLog),
      },
      updateType: "full",
    });
  }

  if (updateOperations.length === 0) {
    console.log("No templates need updating.");
    console.log("\n=== Migration Complete ===");
    return;
  }

  console.log(`\nExecuting ${updateOperations.length} updates in a single transaction...\n`);

  // Execute all updates atomically in a single transaction
  try {
    await prisma.$transaction(
      updateOperations.map((op) =>
        prisma.trashTemplate.update({
          where: { id: op.templateId },
          data: op.data,
        })
      )
    );

    // Log success for each operation after transaction commits
    for (const op of updateOperations) {
      if (op.updateType === "hash_only") {
        console.log(`  ✅ Updated hash only: ${op.templateName} (changelog entry already exists)`);
      } else {
        console.log(`  ✅ Updated: ${op.templateName}`);
      }
    }

    console.log("\n=== Migration Complete ===");
    console.log(`Updated ${updateOperations.length} templates with commit hash: ${latestCommitHash.substring(0, 7)}`);
  } catch (error) {
    console.error("\n❌ Transaction failed - no templates were updated.");
    console.error("Error:", error instanceof Error ? error.message : error);
    throw new Error("Failed to update templates. Database remains unchanged.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
