-- CreateTable
CREATE TABLE "BackupSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "autoDay" TEXT,
    "data" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupSnapshot_userId_kind_createdAt_idx" ON "BackupSnapshot"("userId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupSnapshot_userId_autoDay_key" ON "BackupSnapshot"("userId", "autoDay");

-- AddForeignKey
ALTER TABLE "BackupSnapshot" ADD CONSTRAINT "BackupSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
