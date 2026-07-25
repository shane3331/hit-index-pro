import { NextResponse, type NextRequest } from "next/server";
import { getLiveGameStatuses } from "@/lib/mlb";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("games") ?? "";
  const gamePks = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!gamePks.length) {
    return NextResponse.json({ statuses: [], updatedAt: new Date().toISOString() });
  }

  try {
    const statuses = await getLiveGameStatuses(gamePks);
    return NextResponse.json({ statuses, updatedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live status request failed.";
    return NextResponse.json({ statuses: [], error: message, updatedAt: new Date().toISOString() }, { status: 200 });
  }
}
