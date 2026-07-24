import { NextResponse, type NextRequest } from "next/server";
import { buildSlate } from "@/lib/mlb";
import {
  getCachedSlate,
  markSlateBuilding,
  supabaseConfigured,
} from "@/lib/database";
import { isoDateInNewYork } from "@/lib/date";

export const dynamic = "force-dynamic";

const TEN_MINUTES = 10 * 60 * 1000;

function triggerBackgroundBuild(origin: string, date: string): Promise<unknown> {
  const key = process.env.CRON_SECRET ?? "";
  const url = `${origin}/.netlify/functions/build-slate-background?date=${date}&key=${encodeURIComponent(key)}`;
  return fetch(url, { method: "POST" }).catch(() => undefined);
}

export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("date");
  const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : isoDateInNewYork(0);
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";
  const origin = process.env.URL ?? request.nextUrl.origin;

  // Without Supabase, fall back to building inline (fine locally, may hit host time limits on big slates).
  if (!supabaseConfigured()) {
    try {
      const slate = await buildSlate(date);
      slate.warnings.push("Supabase is not connected, so this slate was built inline and nothing is being tracked.");
      return NextResponse.json(slate);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error building the slate.";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  try {
    const cached = await getCachedSlate(date);
    const recentlyBuilding =
      cached?.building && Date.now() - new Date(cached.updatedAt).getTime() < TEN_MINUTES;

    if (cached?.payload && !refresh) {
      return NextResponse.json({ ...cached.payload, building: Boolean(recentlyBuilding) });
    }

    if (recentlyBuilding && !refresh) {
      return NextResponse.json({ building: true, date });
    }

    if (cached?.error && !refresh && !cached.payload) {
      return NextResponse.json({ error: cached.error }, { status: 502 });
    }

    await markSlateBuilding(date);
    await triggerBackgroundBuild(origin, date);

    if (cached?.payload) {
      return NextResponse.json({ ...cached.payload, building: true });
    }
    return NextResponse.json({ building: true, date });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error reading the slate cache.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
