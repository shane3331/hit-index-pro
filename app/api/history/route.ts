import { NextResponse } from "next/server";
import { getHistory } from "@/lib/database";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const history = await getHistory();
    return NextResponse.json(history);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error loading history.";
    return NextResponse.json({ enabled: false, error: message }, { status: 200 });
  }
}
