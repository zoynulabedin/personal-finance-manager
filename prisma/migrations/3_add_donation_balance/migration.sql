-- CreateTable DonationBalance
CREATE TABLE "DonationBalance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "allocated" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "spent" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DonationBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DonationBalance_userId_key" ON "DonationBalance"("userId");

-- AddForeignKey
ALTER TABLE "DonationBalance" ADD CONSTRAINT "DonationBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
