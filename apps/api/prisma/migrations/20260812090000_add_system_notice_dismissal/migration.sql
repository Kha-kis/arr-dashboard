CREATE TABLE "system_notice_dismissals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "noticeKey" TEXT NOT NULL,
    "dismissedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_notice_dismissals_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "system_notice_dismissals_userId_noticeKey_key"
    ON "system_notice_dismissals"("userId", "noticeKey");

CREATE INDEX "system_notice_dismissals_userId_idx"
    ON "system_notice_dismissals"("userId");
