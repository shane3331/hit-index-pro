import { NextResponse, type NextRequest } from "next/server";
import { isoDateInNewYork } from "@/lib/date";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    const key = request.nextUrl.searchParams.get("key");
    if (header !== `Bearer ${secret}` && key !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const date = isoDateInNewYork(0);
  const origin = process.env.URL ?? request.nextUrl.origin;
  const key = process.env.CRON_SECRET ?? "";
  await fetch(
    `${origin}/.netlify/functions/build-slate-background?date=${date}&key=${encodeURIComponent(key)}`,
    { method: "POST" },
  ).catch(() => undefined);

  return NextResponse.json({ ok: true, triggered: date });
}
