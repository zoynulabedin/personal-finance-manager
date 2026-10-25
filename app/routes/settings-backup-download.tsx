import type { Route } from "./+types/settings-backup-download";
import { requireUserId } from "../lib/auth.server";
import { backupFilename, readSnapshot } from "../lib/backup.server";

/**
 * Download one stored snapshot as the same JSON file /settings/export
 * produces, so it can be kept off the server and imported again later.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const snapshot = await readSnapshot(userId, params.backupId);

  // Someone else's id and a missing one look the same from outside.
  if (!snapshot) {
    throw new Response("Backup not found", { status: 404 });
  }

  const filename = backupFilename(snapshot.day, snapshot.kind.toLowerCase());

  return new Response(JSON.stringify(snapshot.payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
