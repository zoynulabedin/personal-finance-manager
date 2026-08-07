-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN "transferId" TEXT;

-- CreateIndex
CREATE INDEX "LedgerEntry_transferId_idx" ON "LedgerEntry"("transferId");
