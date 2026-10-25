import type { Route } from "./+types/settings-export";
import { prisma } from "../lib/db.server";
import { requireUserId } from "../lib/auth.server";
import {
  backupDayKey,
  backupFilename,
  buildBackupPayload,
} from "../lib/backup.server";

/**
 * Backup download, split out of /settings so that route's loader returns a
 * single plain object instead of a `{ user } | Response` union (which forced
 * an `as any` cast in the component).
 *
 * Everything here is scoped to the signed-in user.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const backupData = await buildBackupPayload(prisma, userId);

  return new Response(JSON.stringify(backupData, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${backupFilename(backupDayKey())}"`,
      "Cache-Control": "no-store",
    },
  });
}
