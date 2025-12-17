-- CreateTable
CREATE TABLE "standalone_cf_deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "cfTrashId" TEXT NOT NULL,
    "cfName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "commitHash" TEXT NOT NULL,
    "deployedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standalone_cf_deployments_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "standalone_cf_deployments_userId_idx" ON "standalone_cf_deployments"("userId");

-- CreateIndex
CREATE INDEX "standalone_cf_deployments_instanceId_idx" ON "standalone_cf_deployments"("instanceId");

-- CreateIndex
CREATE INDEX "standalone_cf_deployments_commitHash_idx" ON "standalone_cf_deployments"("commitHash");

-- CreateIndex
CREATE UNIQUE INDEX "standalone_cf_deployments_instanceId_cfTrashId_key" ON "standalone_cf_deployments"("instanceId", "cfTrashId");
