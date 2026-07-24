import { buildSlate } from "../../lib/mlb";
import {
  markSlateBuilding,
  markSlateFailed,
  saveSlate,
  settleDate,
  storeSlateCache,
} from "../../lib/database";
import { isoDateInNewYork, shiftIsoDate } from "../../lib/date";

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret && url.searchParams.get("key") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const requested = url.searchParams.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : isoDateInNewYork(0);

  try {
    await markSlateBuilding(date);

    // Settle the two prior days against final box scores before building today.
    for (const offset of [-1, -2]) {
      try {
        await settleDate(shiftIsoDate(date, offset));
      } catch {
        // Settlement retries on the next run if a feed was incomplete.
      }
    }

    const slate = await buildSlate(date);
    try {
      await saveSlate(slate);
      slate.source.persistence = "live";
    } catch {
      slate.source.persistence = "partial";
      slate.warnings.push("Prediction tracking write failed on this run; the slate itself is complete.");
    }
    await storeSlateCache(date, slate);
    return new Response("ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slate build failed.";
    try {
      await markSlateFailed(date, message);
    } catch {
      // Nothing else to do; the next trigger will retry.
    }
    return new Response(message, { status: 500 });
  }
};
