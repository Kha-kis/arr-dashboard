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
    console.error("Failed to get latest commit hash. Aborting.");
    process.exit(1);
  }

  console.log(`Latest commit hash: ${latestCommitHash}\n`);

  // Find templates without commit hash
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

  console.log("\nUpdating templates...\n");

  const now = new Date();
  let successfulUpdates = 0;

  for (const template of templatesWithoutHash) {
    try {
      // Get current changeLog
      const fullTemplate = await prisma.trashTemplate.findUnique({
        where: { id: template.id },
        select: { changeLog: true },
      });

      let changeLog: Array<{
        timestamp: string;
        userId?: string;
        changeType: string;
        description: string;
        commitHash?: string;
      }> = [];

      if (fullTemplate?.changeLog) {
        try {
          changeLog = JSON.parse(fullTemplate.changeLog as string);
        } catch {
          changeLog = [];
        }
      }

      // Add migration entry to changelog
      changeLog.push({
        timestamp: now.toISOString(),
        changeType: "migration",
        description: "Backfilled commit hash for version tracking",
        commitHash: latestCommitHash,
      });

      await prisma.trashTemplate.update({
        where: { id: template.id },
        data: {
          trashGuidesCommitHash: latestCommitHash,
          lastSyncedAt: now,
          changeLog: JSON.stringify(changeLog),
        },
      });

      successfulUpdates++;
      console.log(`  ✅ Updated: ${template.name}`);
    } catch (error) {
      console.error(`  ❌ Failed to update ${template.name}:`, error);
    }
  }

  console.log("\n=== Migration Complete ===");
  console.log(`Updated ${successfulUpdates} templates with commit hash: ${latestCommitHash.substring(0, 7)}`);
  if (successfulUpdates < templatesWithoutHash.length) {
    console.log(`  ⚠️ ${templatesWithoutHash.length - successfulUpdates} templates failed to update`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
