import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { HistoryResponse, SlateResponse } from "./types";
import { getPlayerHitsForGame } from "./mlb";

function adminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) return null;
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function saveSlate(slate: SlateResponse): Promise<boolean> {
  const supabase = adminClient();
  if (!supabase) return false;

  const { data: slateRow, error: slateError } = await supabase
    .from("slates")
    .upsert(
      {
        slate_date: slate.date,
        generated_at: slate.generatedAt,
        source_status: slate.source,
        warnings: slate.warnings,
      },
      { onConflict: "slate_date" },
    )
    .select("id")
    .single();
  if (slateError) throw slateError;

  const predictionRows = slate.hitters.slice(0, 80).map((hitter) => ({
    slate_id: slateRow.id,
    slate_date: slate.date,
    game_pk: hitter.gamePk,
    player_id: hitter.playerId,
    player_name: hitter.name,
    team: hitter.team,
    opponent: hitter.opponent,
    lineup_slot: hitter.lineupSlot ?? null,
    hit_index: hitter.hitIndex,
    probability: hitter.modelHitProbability,
    fair_american_odds: hitter.fairAmericanOdds,
    confidence: hitter.confidence,
    factors: hitter.factors,
    explanation: hitter.explanation,
    market_bookmaker: hitter.market?.bookmaker ?? null,
    market_line: hitter.market?.line ?? null,
    market_over_price: hitter.market?.overPrice ?? null,
    market_no_vig_probability: hitter.market?.noVigProbability ?? null,
    market_edge: hitter.marketEdge ?? null,
  }));

  const { error: predictionsError } = await supabase
    .from("predictions")
    .upsert(predictionRows, { onConflict: "slate_date,game_pk,player_id" });
  if (predictionsError) throw predictionsError;

  const parlayRows = slate.parlays.map((parlay, index) => ({
    slate_id: slateRow.id,
    slate_date: slate.date,
    rank: index + 1,
    parlay_key: parlay.id,
    legs: parlay.legs.map((leg) => ({
      playerId: leg.playerId,
      playerName: leg.name,
      gamePk: leg.gamePk,
      probability: leg.modelHitProbability,
    })),
    probability: parlay.combinedProbability,
    fair_american_odds: parlay.fairAmericanOdds,
    parlay_index: parlay.parlayIndex,
    same_game: parlay.sameGame,
    estimated_market_odds: parlay.estimatedMarketOdds ?? null,
    market_implied_probability: parlay.marketImpliedProbability ?? null,
    model_edge: parlay.modelEdge ?? null,
  }));

  const { error: parlaysError } = await supabase
    .from("parlays")
    .upsert(parlayRows, { onConflict: "slate_date,parlay_key" });
  if (parlaysError) throw parlaysError;
  return true;
}

export async function settleDate(date: string): Promise<{ settled: number }> {
  const supabase = adminClient();
  if (!supabase) return { settled: 0 };

  const { data: predictions, error } = await supabase
    .from("predictions")
    .select("id,game_pk,player_id")
    .eq("slate_date", date)
    .is("result", null);
  if (error) throw error;
  if (!predictions?.length) return { settled: 0 };

  const byGame = new Map<number, Array<{ id: number; player_id: number }>>();
  for (const prediction of predictions) {
    const rows = byGame.get(prediction.game_pk) ?? [];
    rows.push(prediction);
    byGame.set(prediction.game_pk, rows);
  }

  let settled = 0;
  for (const [gamePk, rows] of byGame) {
    try {
      const hits = await getPlayerHitsForGame(gamePk);
      for (const row of rows) {
        if (!hits.has(row.player_id)) continue;
        const actualHits = hits.get(row.player_id) ?? 0;
        const { error: updateError } = await supabase
          .from("predictions")
          .update({ actual_hits: actualHits, result: actualHits > 0 ? "hit" : "miss", settled_at: new Date().toISOString() })
          .eq("id", row.id);
        if (!updateError) settled += 1;
      }
    } catch {
      // Game may not be final or feed may still be incomplete.
    }
  }

  const { data: parlays } = await supabase
    .from("parlays")
    .select("id,legs")
    .eq("slate_date", date)
    .is("result", null);

  for (const parlay of parlays ?? []) {
    const legs = (parlay.legs ?? []) as Array<{ playerId: number; gamePk: number }>;
    const legResults: string[] = [];
    for (const leg of legs) {
      const { data } = await supabase
        .from("predictions")
        .select("result")
        .eq("slate_date", date)
        .eq("game_pk", leg.gamePk)
        .eq("player_id", leg.playerId)
        .maybeSingle();
      if (data?.result) legResults.push(data.result);
    }
    if (legResults.length === legs.length) {
      await supabase
        .from("parlays")
        .update({ result: legResults.every((result) => result === "hit") ? "win" : "loss", settled_at: new Date().toISOString() })
        .eq("id", parlay.id);
    }
  }

  return { settled };
}

export async function getHistory(): Promise<HistoryResponse> {
  const supabase = adminClient();
  if (!supabase) return { enabled: false };

  const { data: predictions, error: predictionError } = await supabase
    .from("predictions")
    .select("slate_date,result")
    .not("result", "is", null)
    .order("slate_date", { ascending: false })
    .limit(3000);
  if (predictionError) throw predictionError;

  const { data: parlays, error: parlayError } = await supabase
    .from("parlays")
    .select("slate_date,result")
    .not("result", "is", null)
    .order("slate_date", { ascending: false })
    .limit(1000);
  if (parlayError) throw parlayError;

  const dayMap = new Map<string, { predictions: number; hits: number; parlays: number; parlayWins: number }>();
  for (const prediction of predictions ?? []) {
    const day = dayMap.get(prediction.slate_date) ?? { predictions: 0, hits: 0, parlays: 0, parlayWins: 0 };
    day.predictions += 1;
    if (prediction.result === "hit") day.hits += 1;
    dayMap.set(prediction.slate_date, day);
  }
  for (const parlay of parlays ?? []) {
    const day = dayMap.get(parlay.slate_date) ?? { predictions: 0, hits: 0, parlays: 0, parlayWins: 0 };
    day.parlays += 1;
    if (parlay.result === "win") day.parlayWins += 1;
    dayMap.set(parlay.slate_date, day);
  }

  const days = [...dayMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 30)
    .map(([date, day]) => ({
      date,
      ...day,
      hitRate: day.predictions ? day.hits / day.predictions : 0,
    }));

  const predictionCount = predictions?.length ?? 0;
  const hitCount = predictions?.filter((prediction: { result?: string }) => prediction.result === "hit").length ?? 0;
  const parlayCount = parlays?.length ?? 0;
  const parlayWins = parlays?.filter((parlay: { result?: string }) => parlay.result === "win").length ?? 0;

  return {
    enabled: true,
    summary: {
      predictions: predictionCount,
      hits: hitCount,
      hitRate: predictionCount ? hitCount / predictionCount : 0,
      parlays: parlayCount,
      parlayWins,
      parlayWinRate: parlayCount ? parlayWins / parlayCount : 0,
    },
    days,
  };
}

export interface CachedSlate {
  payload: SlateResponse | null;
  building: boolean;
  error: string | null;
  updatedAt: string;
}

export function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function getCachedSlate(date: string): Promise<CachedSlate | null> {
  const supabase = adminClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("slate_cache")
    .select("payload,building,error,updated_at")
    .eq("slate_date", date)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    payload: (data.payload as SlateResponse | null) ?? null,
    building: Boolean(data.building),
    error: data.error ?? null,
    updatedAt: data.updated_at,
  };
}

export async function markSlateBuilding(date: string): Promise<void> {
  const supabase = adminClient();
  if (!supabase) return;
  await supabase
    .from("slate_cache")
    .upsert(
      { slate_date: date, building: true, error: null, updated_at: new Date().toISOString() },
      { onConflict: "slate_date" },
    );
}

export async function storeSlateCache(date: string, slate: SlateResponse): Promise<void> {
  const supabase = adminClient();
  if (!supabase) return;
  const { error } = await supabase
    .from("slate_cache")
    .upsert(
      { slate_date: date, payload: slate, building: false, error: null, updated_at: new Date().toISOString() },
      { onConflict: "slate_date" },
    );
  if (error) throw error;
}

export async function markSlateFailed(date: string, message: string): Promise<void> {
  const supabase = adminClient();
  if (!supabase) return;
  await supabase
    .from("slate_cache")
    .upsert(
      { slate_date: date, building: false, error: message, updated_at: new Date().toISOString() },
      { onConflict: "slate_date" },
    );
}
