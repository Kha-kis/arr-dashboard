import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const templates = await prisma.trashTemplate.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      serviceType: true,
      trashGuidesCommitHash: true,
      hasUserModifications: true,
      lastSyncedAt: true,
      qualityProfileMappings: {
        select: {
          syncStrategy: true,
          instanceId: true,
          qualityProfileName: true,
        },
      },
    },
  });

  console.log("=== Templates Status ===\n");

  for (const t of templates) {
    const autoCount = t.qualityProfileMappings.filter(m => m.syncStrategy === "auto").length;
    const notifyCount = t.qualityProfileMappings.filter(m => m.syncStrategy === "notify").length;
    const manualCount = t.qualityProfileMappings.filter(m => m.syncStrategy === "manual").length;

    console.log(`📋 ${t.name} (${t.serviceType})`);
    console.log(`   ID: ${t.id}`);
    console.log(`   Commit Hash: ${t.trashGuidesCommitHash || "N/A"}`);
    console.log(`   Last Synced: ${t.lastSyncedAt ? t.lastSyncedAt.toISOString() : "Never"}`);
    console.log(`   User Modifications: ${t.hasUserModifications}`);
    console.log(`   Deployments: auto=${autoCount}, notify=${notifyCount}, manual=${manualCount}`);
    console.log("");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
