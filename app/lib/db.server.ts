import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;

declare global {
  var __db__: PrismaClient | undefined;
}

if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  // Reuse one client across HMR reloads so dev doesn't exhaust connections.
  if (!global.__db__) {
    global.__db__ = new PrismaClient();
    // Connect eagerly, but surface failures instead of leaving an unhandled
    // rejection floating (the previous code never awaited or caught this).
    global.__db__.$connect().catch((error: unknown) => {
      console.error("Failed to connect to the database:", error);
    });
  }
  prisma = global.__db__;
}

export { prisma };
