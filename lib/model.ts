import type { HitterProjection, ParlayProjection } from "./types";

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function americanOddsFromProbability(probability: number): number {
  const p = clamp(probability, 0.01, 0.99);
  return p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

export function decimalOddsFromAmerican(odds: number): number {
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

export function americanOddsFromDecimal(decimal: number): number {
  if (decimal <= 1) return -10000;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export function expectedPlateAppearances(lineupSlot?: number): number {
  const bySlot = [4.82, 4.72, 4.62, 4.52, 4.42, 4.3, 4.18, 4.06, 3.94];
  return lineupSlot && lineupSlot >= 1 && lineupSlot <= 9 ? bySlot[lineupSlot - 1] : 4.12;
}

export function pitcherWeaknessScore(input: {
  era?: number;
  whip?: number;
  hitsPer9?: number;
  strikeoutsPer9?: number;
  innings?: number;
}): number {
  const era = input.era ?? 4.25;
  const whip = input.whip ?? 1.3;
  const hitsPer9 = input.hitsPer9 ?? 8.7;
  const strikeoutsPer9 = input.strikeoutsPer9 ?? 8.5;
  const sample = clamp((input.innings ?? 0) / 60, 0.3, 1);

  const raw =
    50 +
    (era - 4.15) * 8.5 +
    (whip - 1.28) * 30 +
    (hitsPer9 - 8.6) * 4.6 -
    (strikeoutsPer9 - 8.5) * 2.4;

  return clamp(50 + (raw - 50) * sample, 12, 95);
}

export function platoonScore(batSide?: string, pitcherHand?: string): number {
  if (!batSide || !pitcherHand) return 50;
  if (batSide === "S") return 59;
  return batSide !== pitcherHand ? 63 : 45;
}

export function weatherEnvironmentScore(input: {
  temperatureF?: number;
  windMph?: number;
  humidity?: number;
  parkFactor?: number;
}): number {
  const park = input.parkFactor ?? 1;
  const temperature = input.temperatureF ?? 72;
  const wind = input.windMph ?? 5;
  const humidity = input.humidity ?? 55;

  return clamp(
    50 + (park - 1) * 120 + (temperature - 72) * 0.45 + wind * 0.35 + (humidity - 55) * 0.08,
    20,
    90,
  );
}

export function calculateHitterProjection(input: {
  playerId: number;
  name: string;
  teamId: number;
  team: string;
  opponent: string;
  gamePk: number;
  gameDate: string;
  lineupSlot?: number;
  batSide?: string;
  starterHand?: string;
  starterName: string;
  seasonAvg: number;
  recentAvg: number;
  seasonObp: number;
  strikeoutRate: number;
  gamesPlayed: number;
  hits: number;
  multiHitGames: number;
  starterWeakness: number;
  environment: number;
  staffWeakness: number;
}): HitterProjection {
  const expectedPa = expectedPlateAppearances(input.lineupSlot);
  const contactScore = clamp((input.seasonAvg - 0.19) * 235 + (0.24 - input.strikeoutRate) * 85 + 46, 10, 96);
  const recentForm = clamp((input.recentAvg - 0.18) * 220 + 48, 10, 96);
  const lineup = input.lineupSlot ? clamp(100 - (input.lineupSlot - 1) * 8.2, 34, 100) : 54;
  const platoon = platoonScore(input.batSide, input.starterHand);
  const hitsPerGame = input.gamesPlayed > 0 ? input.hits / input.gamesPlayed : input.seasonAvg * 3.7;
  const multiHitRate = input.gamesPlayed > 0 ? input.multiHitGames / input.gamesPlayed : 0;

  const perAtBat = clamp(
    input.seasonAvg * 0.5 +
      input.recentAvg * 0.22 +
      (input.starterWeakness - 50) * 0.00105 +
      (input.staffWeakness - 50) * 0.00045 +
      (platoon - 50) * 0.00042 +
      (input.environment - 50) * 0.00038 -
      Math.max(0, input.strikeoutRate - 0.22) * 0.11,
    0.15,
    0.39,
  );

  const estimatedAtBats = expectedPa * clamp(0.91 - input.seasonObp * 0.08, 0.82, 0.91);
  const probability = clamp(1 - Math.pow(1 - perAtBat, estimatedAtBats), 0.35, 0.84);

  const hitIndex = Math.round(
    clamp(
      contactScore * 0.24 +
        recentForm * 0.18 +
        input.starterWeakness * 0.2 +
        lineup * 0.14 +
        platoon * 0.1 +
        input.environment * 0.08 +
        input.staffWeakness * 0.06,
      0,
      99,
    ),
  );

  const confidence: HitterProjection["confidence"] =
    hitIndex >= 86 && probability >= 0.7
      ? "Elite"
      : hitIndex >= 79 && probability >= 0.64
        ? "Strong"
        : hitIndex >= 72
          ? "Qualified"
          : "Pass";

  const explanation = [
    `${Math.round(probability * 100)}% model estimate for 1+ hit`,
    input.lineupSlot ? `Projected batting slot ${input.lineupSlot} (${expectedPa.toFixed(1)} expected PA)` : `${expectedPa.toFixed(1)} expected PA while lineup is pending`,
    `Season AVG ${input.seasonAvg.toFixed(3)} · recent AVG ${input.recentAvg.toFixed(3)}`,
    `Opposing starter weakness ${Math.round(input.starterWeakness)}/100`,
  ];

  if (platoon >= 58) explanation.push("Favorable or switch-hitter platoon setup");
  if (input.environment >= 60) explanation.push("Above-average run and contact environment");
  if (input.strikeoutRate <= 0.19) explanation.push("Low strikeout profile keeps more balls in play");

  return {
    playerId: input.playerId,
    name: input.name,
    teamId: input.teamId,
    team: input.team,
    opponent: input.opponent,
    gamePk: input.gamePk,
    gameDate: input.gameDate,
    lineupSlot: input.lineupSlot,
    batSide: input.batSide,
    starterHand: input.starterHand,
    starterName: input.starterName,
    seasonAvg: input.seasonAvg,
    recentAvg: input.recentAvg,
    seasonObp: input.seasonObp,
    strikeoutRate: input.strikeoutRate,
    gamesPlayed: input.gamesPlayed,
    hitsPerGame,
    multiHitRate,
    expectedPlateAppearances: expectedPa,
    modelHitProbability: probability,
    fairAmericanOdds: americanOddsFromProbability(probability),
    hitIndex,
    confidence,
    factors: {
      contact: Math.round(contactScore),
      recentForm: Math.round(recentForm),
      starterWeakness: Math.round(input.starterWeakness),
      lineup: Math.round(lineup),
      platoon: Math.round(platoon),
      environment: Math.round(input.environment),
      staff: Math.round(input.staffWeakness),
    },
    explanation,
  };
}

export function buildParlays(hitters: HitterProjection[]): ParlayProjection[] {
  const pool = hitters.filter((h) => h.confidence !== "Pass").slice(0, 26);
  const candidates: ParlayProjection[] = [];

  for (let first = 0; first < pool.length; first += 1) {
    for (let second = first + 1; second < pool.length; second += 1) {
      const a = pool[first];
      const b = pool[second];
      const sameGame = a.gamePk === b.gamePk;
      const sameTeam = a.teamId === b.teamId;
      const correlationPenalty = sameGame ? 0.965 : 0.995;
      const combinedProbability = clamp(a.modelHitProbability * b.modelHitProbability * correlationPenalty, 0.12, 0.76);
      const diversityBonus = !sameGame ? 5 : 0;
      const teamBonus = !sameTeam ? 2 : 0;
      const parlayIndex = Math.round(
        clamp((a.hitIndex + b.hitIndex) / 2 + diversityBonus + teamBonus + (combinedProbability - 0.48) * 18, 0, 99),
      );

      const reason = [
        sameGame ? "Same-game offensive environment" : "Cross-game diversification",
        `${a.name}: ${Math.round(a.modelHitProbability * 100)}% model estimate`,
        `${b.name}: ${Math.round(b.modelHitProbability * 100)}% model estimate`,
      ];

      let estimatedMarketOdds: number | undefined;
      let marketImpliedProbability: number | undefined;
      let modelEdge: number | undefined;
      if (a.market?.overPrice != null && b.market?.overPrice != null && !sameGame) {
        const decimal = decimalOddsFromAmerican(a.market.overPrice) * decimalOddsFromAmerican(b.market.overPrice);
        estimatedMarketOdds = americanOddsFromDecimal(decimal);
        marketImpliedProbability = 1 / decimal;
        modelEdge = combinedProbability - marketImpliedProbability;
        reason.push(`Estimated cross-game market price ${estimatedMarketOdds > 0 ? "+" : ""}${estimatedMarketOdds}`);
      }

      candidates.push({
        id: `${a.playerId}-${b.playerId}`,
        legs: [a, b],
        combinedProbability,
        fairAmericanOdds: americanOddsFromProbability(combinedProbability),
        parlayIndex: Math.round(clamp(parlayIndex + (modelEdge ?? 0) * 80, 0, 99)),
        sameGame,
        reason,
        estimatedMarketOdds,
        marketImpliedProbability,
        modelEdge,
      });
    }
  }

  candidates.sort((a, b) => b.parlayIndex - a.parlayIndex || b.combinedProbability - a.combinedProbability);

  const selected: ParlayProjection[] = [];
  const playerUsage = new Map<number, number>();
  for (const candidate of candidates) {
    const [a, b] = candidate.legs;
    if ((playerUsage.get(a.playerId) ?? 0) >= 3 || (playerUsage.get(b.playerId) ?? 0) >= 3) continue;
    selected.push(candidate);
    playerUsage.set(a.playerId, (playerUsage.get(a.playerId) ?? 0) + 1);
    playerUsage.set(b.playerId, (playerUsage.get(b.playerId) ?? 0) + 1);
    if (selected.length === 18) break;
  }

  return selected;
}
