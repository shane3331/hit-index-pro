import { buildParlays, calculateHitterProjection, clamp, pitcherWeaknessScore, weatherEnvironmentScore } from "./model";
import { isoDateInNewYork, shiftIsoDate } from "./date";
import type { RecentGameLine, GameProjection, HitterProjection, PitcherSnapshot, SlateResponse, WeatherSnapshot } from "./types";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const MLB_LIVE = "https://statsapi.mlb.com/api/v1.1";

const PARK_FACTORS: Record<string, number> = {
  "Coors Field": 1.12,
  "Great American Ball Park": 1.08,
  "Fenway Park": 1.07,
  "Yankee Stadium": 1.05,
  "Citizens Bank Park": 1.05,
  "Globe Life Field": 1.03,
  "Dodger Stadium": 1.02,
  "Wrigley Field": 1.02,
  "Chase Field": 1.01,
  "Kauffman Stadium": 1.01,
  "Oriole Park at Camden Yards": 1,
  "Truist Park": 1,
  "loanDepot park": 0.98,
  "Petco Park": 0.96,
  "T-Mobile Park": 0.95,
  "Oracle Park": 0.95,
};

interface MlbGame {
  gamePk: number;
  gameDate: string;
  status?: { detailedState?: string };
  venue?: { id?: number; name?: string };
  teams: {
    away: { team: { id: number; name: string; abbreviation?: string }; probablePitcher?: { id: number; fullName: string } };
    home: { team: { id: number; name: string; abbreviation?: string }; probablePitcher?: { id: number; fullName: string } };
  };
}

interface StatLine {
  person?: {
    id: number;
    fullName: string;
    batSide?: { code?: string };
  };
  stat?: Record<string, unknown>;
}

interface OddsOutcome {
  name: string;
  description?: string;
  price: number;
  point?: number;
}

interface OddsMarket {
  key: string;
  last_update?: string;
  outcomes?: OddsOutcome[];
}

interface OddsBookmaker {
  key: string;
  title: string;
  last_update?: string;
  markets?: OddsMarket[];
}

interface OddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: OddsBookmaker[];
}

interface GameOddsContext {
  eventId: string;
  marketTotal?: number;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/gi, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function matchupKey(away: string, home: string): string {
  return `${normalizeText(away)}::${normalizeText(home)}`;
}

function impliedProbability(americanOdds: number): number {
  return americanOdds > 0 ? 100 / (americanOdds + 100) : Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function fetchJson<T>(url: string, revalidate = 300): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const requestInit: RequestInit & { next: { revalidate: number } } = {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: revalidate <= 60 ? "no-store" : "force-cache",
      next: { revalidate },
    };
    const response = await fetch(url, requestInit);
    if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getSchedule(date: string): Promise<MlbGame[]> {
  const params = new URLSearchParams({
    sportId: "1",
    date,
    hydrate: "probablePitcher,team,venue",
  });
  const data = await fetchJson<{ dates?: Array<{ games?: MlbGame[] }> }>(`${MLB_API}/schedule?${params.toString()}`);
  return data.dates?.[0]?.games ?? [];
}

async function getPitcherSnapshot(pitcher: { id: number; fullName: string } | undefined, season: string): Promise<PitcherSnapshot> {
  if (!pitcher) return { name: "TBD" };
  try {
    const data = await fetchJson<{
      people?: Array<{ pitchHand?: { code?: string } }>;
    }>(`${MLB_API}/people/${pitcher.id}`);
    const stats = await fetchJson<{
      stats?: Array<{ splits?: Array<{ stat?: Record<string, unknown> }> }>;
    }>(`${MLB_API}/people/${pitcher.id}/stats?stats=season&group=pitching&season=${season}`);
    const line = stats.stats?.[0]?.splits?.[0]?.stat ?? {};
    return {
      id: pitcher.id,
      name: pitcher.fullName,
      hand: data.people?.[0]?.pitchHand?.code,
      era: optionalNumber(line.era),
      whip: optionalNumber(line.whip),
      hitsPer9: optionalNumber(line.hitsPer9Inn),
      strikeoutsPer9: optionalNumber(line.strikeoutsPer9Inn),
      innings: numberValue(line.inningsPitched, 0),
    };
  } catch {
    return { id: pitcher.id, name: pitcher.fullName };
  }
}

async function getActiveRosterIds(teamId: number, date: string): Promise<Set<number>> {
  try {
    const params = new URLSearchParams({ rosterType: "active", date });
    const data = await fetchJson<{ roster?: Array<{ person?: { id?: number } }> }>(
      `${MLB_API}/teams/${teamId}/roster?${params.toString()}`,
      300,
    );
    return new Set((data.roster ?? []).map((row) => row.person?.id).filter((id): id is number => Boolean(id)));
  } catch {
    return new Set<number>();
  }
}

interface RosterStatsPayload {
  roster?: Array<{
    person?: {
      id?: number;
      fullName?: string;
      batSide?: { code?: string };
      stats?: Array<{ splits?: Array<{ stat?: Record<string, unknown> }> }>;
    };
  }>;
}

/** A traded player returns one split per team; combine them into a single season line. */
function aggregateHittingSplits(splits: Array<Record<string, unknown>>): Record<string, unknown> {
  if (splits.length === 1) return splits[0];
  const sum = (key: string) => splits.reduce((total, split) => total + numberValue(split[key]), 0);
  const atBats = sum("atBats");
  const hits = sum("hits");
  const plateAppearances = sum("plateAppearances");
  const onBaseWeighted = splits.reduce(
    (total, split) => total + numberValue(split.obp) * numberValue(split.plateAppearances),
    0,
  );
  return {
    gamesPlayed: sum("gamesPlayed"),
    atBats,
    hits,
    plateAppearances,
    strikeOuts: sum("strikeOuts"),
    doubles: sum("doubles"),
    triples: sum("triples"),
    homeRuns: sum("homeRuns"),
    avg: atBats > 0 ? hits / atBats : 0,
    obp: plateAppearances > 0 ? onBaseWeighted / plateAppearances : 0.31,
  };
}

function linesFromStatsPayload(data: { stats?: Array<{ splits?: StatLine[] }> }): StatLine[] {
  return (data.stats?.[0]?.splits ?? []).filter((split) => Boolean(split.person?.id && split.person?.fullName));
}

/**
 * Season hitting lines, per player. The /stats endpoint filtered by teamId returns the
 * team aggregate rather than one row per hitter, so the roster hydrate is tried first and
 * the leaderboard shapes act as fallbacks.
 */
async function getTeamSeasonStats(
  teamId: number,
  group: "hitting" | "pitching",
  season: string,
): Promise<{ lines: StatLine[]; strategy: string }> {
  try {
    const url =
      `${MLB_API}/teams/${teamId}/roster?rosterType=active` +
      `&hydrate=person(stats(type=season,season=${season},group=${group}))`;
    const data = await fetchJson<RosterStatsPayload>(url, 600);
    const lines: StatLine[] = [];
    for (const row of data.roster ?? []) {
      const person = row.person;
      const splits = (person?.stats?.[0]?.splits ?? [])
        .map((split) => split.stat)
        .filter((stat): stat is Record<string, unknown> => Boolean(stat));
      if (!person?.id || !person.fullName || !splits.length) continue;
      lines.push({
        person: { id: person.id, fullName: person.fullName, batSide: person.batSide },
        stat: aggregateHittingSplits(splits),
      });
    }
    if (lines.length) return { lines, strategy: "roster-hydrate" };
  } catch {
    // Fall through to the leaderboard shapes below.
  }

  for (const [strategy, params] of [
    ["stats-sportId", new URLSearchParams({ stats: "season", group, teamId: String(teamId), season, sportId: "1", limit: "200", hydrate: "person" })],
    ["stats-sportIds", new URLSearchParams({ stats: "season", group, teamId: String(teamId), season, sportIds: "1", hydrate: "person" })],
  ] as const) {
    try {
      const data = await fetchJson<{ stats?: Array<{ splits?: StatLine[] }> }>(`${MLB_API}/stats?${params.toString()}`, 600);
      const lines = linesFromStatsPayload(data);
      if (lines.length) return { lines, strategy };
    } catch {
      // Try the next shape.
    }
  }

  return { lines: [], strategy: "none" };
}

async function getTeamAggregatePitchingStats(teamId: number, season: string): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    stats: "season",
    group: "pitching",
    season,
  });
  try {
    const data = await fetchJson<{ stats?: Array<{ splits?: Array<{ stat?: Record<string, unknown> }> }> }>(
      `${MLB_API}/teams/${teamId}/stats?${params.toString()}`,
      900,
    );
    return data.stats?.[0]?.splits?.[0]?.stat ?? {};
  } catch {
    return {};
  }
}

async function getTeamRecentHittingStats(teamId: number, date: string): Promise<StatLine[]> {
  const params = new URLSearchParams({
    stats: "byDateRange",
    group: "hitting",
    teamId: String(teamId),
    startDate: shiftIsoDate(date, -14),
    endDate: date,
    sportIds: "1",
    hydrate: "person",
  });
  try {
    const data = await fetchJson<{ stats?: Array<{ splits?: StatLine[] }> }>(`${MLB_API}/stats?${params.toString()}`, 600);
    return linesFromStatsPayload(data);
  } catch {
    return [];
  }
}

interface BoxscoreSide {
  team?: { id?: number };
  players?: Record<
    string,
    {
      person?: { id?: number };
      battingOrder?: string;
      stats?: { batting?: { hits?: number; atBats?: number } };
    }
  >;
}

interface BoxscorePayload {
  teams?: { away?: BoxscoreSide; home?: BoxscoreSide };
}

function readBattingOrder(side: BoxscoreSide | undefined, startersOnly: boolean): Map<number, number> {
  const slots = new Map<number, number>();
  for (const player of Object.values(side?.players ?? {})) {
    const playerId = player.person?.id;
    const order = Number(player.battingOrder);
    if (!playerId || !Number.isFinite(order) || order <= 0) continue;
    if (startersOnly && order % 100 !== 0) continue;
    const slot = Math.floor(order / 100);
    if (slot < 1 || slot > 9) continue;
    if (!slots.has(playerId)) slots.set(playerId, slot);
  }
  return slots;
}

async function getOfficialLineups(gamePk: number): Promise<{ away: Map<number, number>; home: Map<number, number> }> {
  try {
    const data = await fetchJson<BoxscorePayload>(`${MLB_API}/game/${gamePk}/boxscore`, 30);
    return {
      away: readBattingOrder(data.teams?.away, true),
      home: readBattingOrder(data.teams?.home, true),
    };
  } catch {
    // Pregame lineups are frequently unavailable until near first pitch.
    return { away: new Map(), home: new Map() };
  }
}

async function getRecentFinalGames(
  teamId: number,
  date: string,
  limit: number,
): Promise<Array<{ gamePk: number; date: string }>> {
  const params = new URLSearchParams({
    sportId: "1",
    teamId: String(teamId),
    startDate: shiftIsoDate(date, -30),
    endDate: shiftIsoDate(date, -1),
    gameType: "R",
  });
  try {
    const data = await fetchJson<{ dates?: Array<{ games?: MlbGame[] }> }>(
      `${MLB_API}/schedule?${params.toString()}`,
      900,
    );
    return (data.dates ?? [])
      .flatMap((day) => day.games ?? [])
      .filter((game) => (game.status?.detailedState ?? "").toLowerCase().includes("final"))
      .sort((a, b) => b.gameDate.localeCompare(a.gameDate))
      .slice(0, limit)
      .map((game) => ({ gamePk: game.gamePk, date: game.gameDate.slice(0, 10) }));
  } catch {
    return [];
  }
}

const RECENT_GAME_WINDOW = 10;
const LINEUP_EVIDENCE_GAMES = 3;
const BOXSCORE_FIELDS =
  "fields=teams,away,home,team,id,players,person,id,battingOrder,stats,batting,hits,atBats";

interface TeamRecentForm {
  lineup: Map<number, number>;
  hitLog: Map<number, RecentGameLine[]>;
}

/**
 * One pass over a team's recent finals. The newest few games drive the projected batting
 * order; all of them build each hitter's game-by-game hit log.
 */
async function getTeamRecentForm(teamId: number, date: string): Promise<TeamRecentForm> {
  const games = await getRecentFinalGames(teamId, date, RECENT_GAME_WINDOW);
  const weightBySlot = new Map<number, Map<number, number>>();
  const hitLog = new Map<number, RecentGameLine[]>();
  if (!games.length) return { lineup: new Map(), hitLog };

  const boxscores = await Promise.all(
    games.map((game) =>
      fetchJson<BoxscorePayload>(`${MLB_API}/game/${game.gamePk}/boxscore?${BOXSCORE_FIELDS}`, 3600).catch(
        () => null,
      ),
    ),
  );

  boxscores.forEach((data, index) => {
    if (!data) return;
    for (const side of [data.teams?.away, data.teams?.home]) {
      if (side?.team?.id !== teamId) continue;
      for (const player of Object.values(side?.players ?? {})) {
        const playerId = player.person?.id;
        if (!playerId) continue;

        const batting = player.stats?.batting;
        if (batting && (batting.atBats != null || batting.hits != null)) {
          const log = hitLog.get(playerId) ?? [];
          log.push({
            date: games[index].date,
            hits: numberValue(batting.hits, 0),
            atBats: numberValue(batting.atBats, 0),
          });
          hitLog.set(playerId, log);
        }

        if (index < LINEUP_EVIDENCE_GAMES) {
          const order = Number(player.battingOrder);
          if (!Number.isFinite(order) || order <= 0 || order % 100 !== 0) continue;
          const slot = Math.floor(order / 100);
          if (slot < 1 || slot > 9) continue;
          const slots = weightBySlot.get(playerId) ?? new Map<number, number>();
          slots.set(slot, (slots.get(slot) ?? 0) + (LINEUP_EVIDENCE_GAMES - index));
          weightBySlot.set(playerId, slots);
        }
      }
    }
  });

  for (const log of hitLog.values()) log.sort((a, b) => b.date.localeCompare(a.date));

  const lineup = new Map<number, number>();
  const used = new Set<number>();
  for (let slot = 1; slot <= 9; slot += 1) {
    let bestPlayer: number | undefined;
    let bestWeight = 0;
    for (const [playerId, slots] of weightBySlot) {
      if (used.has(playerId)) continue;
      const weight = slots.get(slot) ?? 0;
      if (weight > bestWeight) {
        bestWeight = weight;
        bestPlayer = playerId;
      }
    }
    if (bestPlayer != null) {
      lineup.set(bestPlayer, slot);
      used.add(bestPlayer);
    }
  }

  return { lineup, hitLog };
}

async function getFeaturedOdds(): Promise<Map<string, GameOddsContext>> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  const context = new Map<string, GameOddsContext>();
  if (!apiKey) return context;
  try {
    const params = new URLSearchParams({
      apiKey,
      regions: "us",
      markets: "h2h,totals",
      oddsFormat: "american",
      dateFormat: "iso",
    });
    const events = await fetchJson<OddsEvent[]>(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?${params.toString()}`,
      120,
    );
    for (const event of events) {
      const totals: number[] = [];
      for (const bookmaker of event.bookmakers ?? []) {
        const market = bookmaker.markets?.find((item) => item.key === "totals");
        const over = market?.outcomes?.find((outcome) => outcome.name.toLowerCase() === "over");
        if (over?.point != null) totals.push(over.point);
      }
      context.set(matchupKey(event.away_team, event.home_team), {
        eventId: event.id,
        marketTotal: median(totals),
      });
    }
  } catch {
    return context;
  }
  return context;
}

async function getBatterHitMarkets(eventId: string): Promise<Map<string, {
  line: number;
  overPrice: number;
  underPrice?: number;
  noVigProbability?: number;
  bookmaker: string;
  lastUpdate?: string;
}>> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  const markets = new Map<string, {
    line: number; overPrice: number; underPrice?: number; noVigProbability?: number; bookmaker: string; lastUpdate?: string;
  }>();
  if (!apiKey) return markets;
  try {
    const preferred = process.env.PREFERRED_BOOKMAKER?.toLowerCase();
    const params = new URLSearchParams({
      apiKey,
      regions: "us",
      markets: "batter_hits",
      oddsFormat: "american",
      dateFormat: "iso",
    });
    const event = await fetchJson<OddsEvent>(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds?${params.toString()}`,
      90,
    );

    const candidates = new Map<string, Array<{
      line: number; overPrice: number; underPrice?: number; noVigProbability?: number; bookmaker: string; lastUpdate?: string; preferred: boolean;
    }>>();

    for (const bookmaker of event.bookmakers ?? []) {
      const market = bookmaker.markets?.find((item) => item.key === "batter_hits");
      if (!market) continue;
      const descriptions = new Set((market.outcomes ?? []).map((outcome) => outcome.description).filter(Boolean) as string[]);
      for (const description of descriptions) {
        const playerOutcomes = (market.outcomes ?? []).filter((outcome) => outcome.description === description);
        const over = playerOutcomes.find((outcome) => outcome.name.toLowerCase() === "over" && (outcome.point ?? 0.5) === 0.5);
        const under = playerOutcomes.find((outcome) => outcome.name.toLowerCase() === "under" && (outcome.point ?? 0.5) === (over?.point ?? 0.5));
        if (!over) continue;
        const overImplied = impliedProbability(over.price);
        const underImplied = under ? impliedProbability(under.price) : undefined;
        const noVigProbability = underImplied ? overImplied / (overImplied + underImplied) : undefined;
        const key = normalizeText(description);
        const rows = candidates.get(key) ?? [];
        rows.push({
          line: over.point ?? 0.5,
          overPrice: over.price,
          underPrice: under?.price,
          noVigProbability,
          bookmaker: bookmaker.title,
          lastUpdate: market.last_update ?? bookmaker.last_update,
          preferred: preferred ? bookmaker.key.toLowerCase() === preferred : false,
        });
        candidates.set(key, rows);
      }
    }

    for (const [player, rows] of candidates) {
      rows.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.overPrice - a.overPrice);
      const best = rows[0];
      markets.set(player, {
        line: best.line,
        overPrice: best.overPrice,
        underPrice: best.underPrice,
        noVigProbability: best.noVigProbability,
        bookmaker: best.bookmaker,
        lastUpdate: best.lastUpdate,
      });
    }
  } catch {
    return markets;
  }
  return markets;
}

async function getVenueCoordinates(venueId?: number): Promise<{ lat?: number; lon?: number }> {
  if (!venueId) return {};
  try {
    const data = await fetchJson<{
      venues?: Array<{ location?: { defaultCoordinates?: { latitude?: number; longitude?: number } } }>;
    }>(`${MLB_API}/venues/${venueId}`, 86_400);
    return {
      lat: data.venues?.[0]?.location?.defaultCoordinates?.latitude,
      lon: data.venues?.[0]?.location?.defaultCoordinates?.longitude,
    };
  } catch {
    return {};
  }
}

async function getWeather(venueId: number | undefined, gameDate: string): Promise<WeatherSnapshot> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return { available: false };
  const coordinates = await getVenueCoordinates(venueId);
  if (coordinates.lat == null || coordinates.lon == null) return { available: false };

  try {
    const params = new URLSearchParams({
      lat: String(coordinates.lat),
      lon: String(coordinates.lon),
      appid: apiKey,
      units: "imperial",
    });
    type ForecastRow = {
      dt?: number;
      main?: { temp?: number; humidity?: number };
      wind?: { speed?: number; deg?: number };
      weather?: Array<{ description?: string }>;
    };
    const data = await fetchJson<{ list?: ForecastRow[] }>(
      `https://api.openweathermap.org/data/2.5/forecast?${params.toString()}`,
      600,
    );
    const target = new Date(gameDate).getTime() / 1000;
    const closest = (data.list ?? []).reduce<ForecastRow | undefined>((best, row) => {
      if (!row.dt) return best;
      if (!best?.dt) return row;
      return Math.abs(row.dt - target) < Math.abs(best.dt - target) ? row : best;
    }, undefined);
    if (!closest) return { available: false };
    return {
      available: true,
      temperatureF: closest.main?.temp,
      humidity: closest.main?.humidity,
      windMph: closest.wind?.speed,
      windDirection: closest.wind?.deg,
      description: closest.weather?.[0]?.description,
    };
  } catch {
    return { available: false };
  }
}

function teamStaffWeakness(line: Record<string, unknown>): number {
  const era = numberValue(line.era, 4.25);
  const whip = numberValue(line.whip, 1.3);
  const hitsPer9 = numberValue(line.hitsPer9Inn, 8.7);
  const strikeoutsPer9 = numberValue(line.strikeoutsPer9Inn, 8.5);
  return pitcherWeaknessScore({ era, whip, hitsPer9, strikeoutsPer9, innings: 200 });
}

function abbreviation(team: { name: string; abbreviation?: string }): string {
  return team.abbreviation ?? team.name.split(" ").map((word) => word[0]).join("").slice(0, 3).toUpperCase();
}

function toGameProjection(
  game: MlbGame,
  awayPitcher: PitcherSnapshot,
  homePitcher: PitcherSnapshot,
  weather: WeatherSnapshot,
  marketTotal?: number,
): GameProjection {
  const parkFactor = PARK_FACTORS[game.venue?.name ?? ""] ?? 1;
  const environmentScore = Math.round(
    clamp(
      weatherEnvironmentScore({
        temperatureF: weather.temperatureF,
        humidity: weather.humidity,
        windMph: weather.windMph,
        parkFactor,
      }) + (marketTotal != null ? (marketTotal - 8.5) * 4.5 : 0),
      15,
      95,
    ),
  );

  return {
    gamePk: game.gamePk,
    gameDate: game.gameDate,
    status: game.status?.detailedState ?? "Scheduled",
    venue: game.venue?.name ?? "TBD",
    away: {
      id: game.teams.away.team.id,
      name: game.teams.away.team.name,
      abbreviation: abbreviation(game.teams.away.team),
      pitcher: awayPitcher,
    },
    home: {
      id: game.teams.home.team.id,
      name: game.teams.home.team.name,
      abbreviation: abbreviation(game.teams.home.team),
      pitcher: homePitcher,
    },
    weather,
    environmentScore,
    marketTotal,
  };
}

function buildTeamHitters(input: {
  game: GameProjection;
  side: "away" | "home";
  seasonLines: StatLine[];
  recentLines: StatLine[];
  lineup: Map<number, number>;
  lineupSource: "official" | "projected" | null;
  hitLog: Map<number, RecentGameLine[]>;
  staffWeakness: number;
  activeRoster: Set<number>;
  debug: { seasonLines: number; droppedByRoster: number; droppedByThreshold: number };
}): HitterProjection[] {
  const { game, side, seasonLines, recentLines, lineup, lineupSource, hitLog, staffWeakness, activeRoster, debug } = input;
  debug.seasonLines += seasonLines.length;
  const team = game[side];
  const opponent = side === "away" ? game.home : game.away;
  const recentByPlayer = new Map<number, Record<string, unknown>>();
  for (const recent of recentLines) {
    if (recent.person?.id) recentByPlayer.set(recent.person.id, recent.stat ?? {});
  }

  const starterWeakness = pitcherWeaknessScore(opponent.pitcher);

  return seasonLines
    .map((line) => {
      const playerId = line.person?.id;
      if (!playerId || !line.person?.fullName) return null;
      if (activeRoster.size && !activeRoster.has(playerId)) {
        debug.droppedByRoster += 1;
        return null;
      }
      const season = line.stat ?? {};
      const recent = recentByPlayer.get(playerId) ?? {};
      const atBats = numberValue(season.atBats);
      const gamesPlayed = numberValue(season.gamesPlayed);
      const seasonAvg = numberValue(season.avg);
      const recentAvg = numberValue(recent.avg, seasonAvg);
      if (atBats < 20 || gamesPlayed < 8 || seasonAvg <= 0) {
        debug.droppedByThreshold += 1;
        return null;
      }

      const plateAppearances = numberValue(season.plateAppearances, atBats);
      const strikeouts = numberValue(season.strikeOuts);
      const strikeoutRate = plateAppearances > 0 ? strikeouts / plateAppearances : 0.22;
      const hits = numberValue(season.hits);
      const doubles = numberValue(season.doubles);
      const triples = numberValue(season.triples);
      const homeRuns = numberValue(season.homeRuns);
      const extraBaseHits = doubles + triples + homeRuns;
      const estimatedMultiHitGames = clamp(Math.round(Math.max(0, hits - gamesPlayed * 0.55 - extraBaseHits * 0.08)), 0, gamesPlayed);

      return calculateHitterProjection({
        playerId,
        name: line.person.fullName,
        teamId: team.id,
        team: team.abbreviation,
        opponent: opponent.abbreviation,
        gamePk: game.gamePk,
        gameDate: game.gameDate,
        lineupSlot: lineup.get(playerId),
        lineupSource: lineup.get(playerId) ? lineupSource ?? undefined : undefined,
        batSide: line.person.batSide?.code,
        starterHand: opponent.pitcher.hand,
        starterName: opponent.pitcher.name,
        seasonAvg,
        recentAvg,
        seasonObp: numberValue(season.obp, 0.31),
        strikeoutRate,
        gamesPlayed,
        hits,
        multiHitGames: estimatedMultiHitGames,
        starterWeakness,
        environment: game.environmentScore,
        staffWeakness,
        recentGames: (hitLog.get(playerId) ?? []).slice(0, 10),
      });
    })
    .filter((value): value is HitterProjection => Boolean(value));
}

export async function buildSlate(date: string): Promise<SlateResponse> {
  const warnings: string[] = [];
  const gamesRaw = await getSchedule(date);
  if (!gamesRaw.length) {
    return {
      date,
      generatedAt: new Date().toISOString(),
      source: {
        mlb: "live",
        weather: process.env.OPENWEATHER_API_KEY ? "partial" : "unavailable",
        odds: process.env.THE_ODDS_API_KEY ? "partial" : "unavailable",
        persistence: process.env.NEXT_PUBLIC_SUPABASE_URL ? "live" : "unavailable",
      },
      games: [],
      hitters: [],
      parlays: [],
      lineupStatus: "none",
      warnings: ["No MLB games are scheduled for this date."],
    };
  }

  const season = date.slice(0, 4);
  const oddsContext = await getFeaturedOdds();
  const oddsEventByGame = new Map<number, string>();
  let weatherAvailableCount = 0;
  let propMarketCount = 0;
  let officialLineupCount = 0;
  let projectedLineupCount = 0;
  const hitterDebug = { seasonLines: 0, droppedByRoster: 0, droppedByThreshold: 0 };
  const statStrategies = new Set<string>();
  const games: GameProjection[] = [];
  const hitters: HitterProjection[] = [];

  for (const rawGame of gamesRaw) {
    const [awayPitcher, homePitcher, weather, officialLineups] = await Promise.all([
      getPitcherSnapshot(rawGame.teams.away.probablePitcher, season),
      getPitcherSnapshot(rawGame.teams.home.probablePitcher, season),
      getWeather(rawGame.venue?.id, rawGame.gameDate),
      getOfficialLineups(rawGame.gamePk),
    ]);

    const marketContext = oddsContext.get(matchupKey(rawGame.teams.away.team.name, rawGame.teams.home.team.name));
    if (marketContext?.eventId) oddsEventByGame.set(rawGame.gamePk, marketContext.eventId);
    if (weather.available) weatherAvailableCount += 1;
    const game = toGameProjection(rawGame, awayPitcher, homePitcher, weather, marketContext?.marketTotal);
    games.push(game);

    const awayOfficial = officialLineups.away.size >= 8;
    const homeOfficial = officialLineups.home.size >= 8;
    const [awayForm, homeForm] = await Promise.all([
      getTeamRecentForm(rawGame.teams.away.team.id, date),
      getTeamRecentForm(rawGame.teams.home.team.id, date),
    ]);
    const awayLineup = awayOfficial ? officialLineups.away : awayForm.lineup;
    const homeLineup = homeOfficial ? officialLineups.home : homeForm.lineup;
    const awaySource: "official" | "projected" | null = awayOfficial ? "official" : awayLineup.size ? "projected" : null;
    const homeSource: "official" | "projected" | null = homeOfficial ? "official" : homeLineup.size ? "projected" : null;
    if (awaySource === "official") officialLineupCount += 1;
    else if (awaySource === "projected") projectedLineupCount += 1;
    if (homeSource === "official") officialLineupCount += 1;
    else if (homeSource === "projected") projectedLineupCount += 1;

    const [awaySeason, homeSeason, awayRecent, homeRecent, awayStaff, homeStaff, awayRoster, homeRoster] = await Promise.all([
      getTeamSeasonStats(game.away.id, "hitting", season),
      getTeamSeasonStats(game.home.id, "hitting", season),
      getTeamRecentHittingStats(game.away.id, date),
      getTeamRecentHittingStats(game.home.id, date),
      getTeamAggregatePitchingStats(game.away.id, season),
      getTeamAggregatePitchingStats(game.home.id, season),
      getActiveRosterIds(game.away.id, date),
      getActiveRosterIds(game.home.id, date),
    ]);

    statStrategies.add(awaySeason.strategy);
    statStrategies.add(homeSeason.strategy);

    hitters.push(
      ...buildTeamHitters({
        game,
        side: "away",
        seasonLines: awaySeason.lines,
        recentLines: awayRecent,
        lineup: awayLineup,
        lineupSource: awaySource,
        hitLog: awayForm.hitLog,
        staffWeakness: teamStaffWeakness(homeStaff),
        activeRoster: awayRoster,
        debug: hitterDebug,
      }),
      ...buildTeamHitters({
        game,
        side: "home",
        seasonLines: homeSeason.lines,
        recentLines: homeRecent,
        lineup: homeLineup,
        lineupSource: homeSource,
        hitLog: homeForm.hitLog,
        staffWeakness: teamStaffWeakness(awayStaff),
        activeRoster: homeRoster,
        debug: hitterDebug,
      }),
    );
  }

  if (process.env.THE_ODDS_API_KEY && oddsEventByGame.size) {
    const priorityGames = [...new Set(
      [...hitters]
        .sort((a, b) => b.hitIndex - a.hitIndex)
        .slice(0, 36)
        .map((hitter) => hitter.gamePk),
    )].slice(0, 10);

    const marketsByGame = new Map<number, Awaited<ReturnType<typeof getBatterHitMarkets>>>();
    await Promise.all(priorityGames.map(async (gamePk) => {
      const eventId = oddsEventByGame.get(gamePk);
      if (!eventId) return;
      const markets = await getBatterHitMarkets(eventId);
      marketsByGame.set(gamePk, markets);
    }));

    for (const hitter of hitters) {
      const market = marketsByGame.get(hitter.gamePk)?.get(normalizeText(hitter.name));
      if (!market) continue;
      hitter.market = market;
      if (market.noVigProbability != null) hitter.marketEdge = hitter.modelHitProbability - market.noVigProbability;
      propMarketCount += 1;
    }
  }

  hitters.sort((a, b) => b.hitIndex - a.hitIndex || (b.marketEdge ?? -1) - (a.marketEdge ?? -1) || b.modelHitProbability - a.modelHitProbability);

  if (!process.env.OPENWEATHER_API_KEY) {
    warnings.push("Weather is using neutral defaults until OPENWEATHER_API_KEY is configured.");
  } else if (!weatherAvailableCount) {
    warnings.push("The weather forecast feed returned no usable game-time observations for this slate.");
  }
  if (!process.env.THE_ODDS_API_KEY) {
    warnings.push("Sportsbook prices are not fabricated. Configure The Odds API before calculating market edge or estimated cross-game parlay prices.");
  } else if (!propMarketCount) {
    warnings.push("The odds feed returned no 0.5-hit markets yet. Player props are often posted closer to first pitch.");
  }
  if (!hitters.length) {
    warnings.push(
      `No hitters were produced from the MLB feed. Season stat rows seen: ${hitterDebug.seasonLines}, ` +
      `dropped by roster filter: ${hitterDebug.droppedByRoster}, dropped by playing-time thresholds: ${hitterDebug.droppedByThreshold}, ` +
      `stat strategies used: ${[...statStrategies].join(", ") || "none"}.`,
    );
  }

  const lineupStatus: SlateResponse["lineupStatus"] =
    officialLineupCount && projectedLineupCount
      ? "mixed"
      : officialLineupCount
        ? "official"
        : projectedLineupCount
          ? "projected"
          : "none";

  if (lineupStatus === "projected") {
    warnings.push("Official lineups are not posted yet. Batting orders are projected from each team's recent starts and refresh automatically once real lineups drop.");
  } else if (lineupStatus === "mixed") {
    warnings.push("Some teams have posted official lineups. The rest use projected batting orders until theirs drop.");
  } else if (lineupStatus === "none") {
    warnings.push("No batting order history was available, so expected plate appearances use neutral lineup estimates.");
  }

  return {
    date,
    generatedAt: new Date().toISOString(),
    source: {
      mlb: "live",
      weather: weatherAvailableCount > 0 ? "live" : process.env.OPENWEATHER_API_KEY ? "partial" : "unavailable",
      odds: propMarketCount > 0 ? "live" : oddsContext.size > 0 ? "partial" : "unavailable",
      persistence: process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? "live" : "unavailable",
    },
    games,
    hitters,
    parlays: buildParlays(hitters),
    lineupStatus,
    warnings,
    debug: {
      seasonStatRows: hitterDebug.seasonLines,
      droppedByRoster: hitterDebug.droppedByRoster,
      droppedByThreshold: hitterDebug.droppedByThreshold,
      statStrategies: [...statStrategies],
    },
  };
}

export async function resolveSlateDate(): Promise<string> {
  const today = isoDateInNewYork(0);
  try {
    const games = await getSchedule(today);
    const upcoming = games.some((game) => {
      const state = (game.status?.detailedState ?? "").toLowerCase();
      return !state.includes("final") && !state.includes("completed") && !state.includes("postponed");
    });
    if (upcoming) return today;
  } catch {
    return today;
  }
  return isoDateInNewYork(1);
}

export async function getPlayerHitsForGame(gamePk: number): Promise<Map<number, number>> {
  const results = new Map<number, number>();
  const data = await fetchJson<{
    liveData?: {
      boxscore?: {
        teams?: {
          away?: { players?: Record<string, { person?: { id?: number }; stats?: { batting?: { hits?: number } } }> };
          home?: { players?: Record<string, { person?: { id?: number }; stats?: { batting?: { hits?: number } } }> };
        };
      };
    };
  }>(`${MLB_LIVE}/game/${gamePk}/feed/live`, 30);

  for (const side of [data.liveData?.boxscore?.teams?.away, data.liveData?.boxscore?.teams?.home]) {
    for (const player of Object.values(side?.players ?? {})) {
      if (player.person?.id) results.set(player.person.id, player.stats?.batting?.hits ?? 0);
    }
  }
  return results;
}


export interface LivePlayerHit {
  playerId: number;
  hits: number;
  atBats: number;
}

export interface LiveGameStatus {
  gamePk: number;
  state: "preview" | "live" | "final";
  detailedState: string;
  inning?: number;
  inningHalf?: string;
  awayScore?: number;
  homeScore?: number;
  players: LivePlayerHit[];
}

/** Live per-game state and each hitter's running hit total, for the in-game bet tracker. */
export async function getLiveGameStatuses(gamePks: number[]): Promise<LiveGameStatus[]> {
  const unique = [...new Set(gamePks)].filter((pk) => Number.isFinite(pk));
  const results = await Promise.all(
    unique.map(async (gamePk): Promise<LiveGameStatus | null> => {
      try {
        const data = await fetchJson<{
          gameData?: { status?: { abstractGameState?: string; detailedState?: string } };
          liveData?: {
            linescore?: {
              currentInning?: number;
              inningHalf?: string;
              teams?: { away?: { runs?: number }; home?: { runs?: number } };
            };
            boxscore?: {
              teams?: {
                away?: { players?: Record<string, { person?: { id?: number }; stats?: { batting?: { hits?: number; atBats?: number } } }> };
                home?: { players?: Record<string, { person?: { id?: number }; stats?: { batting?: { hits?: number; atBats?: number } } }> };
              };
            };
          };
        }>(`${MLB_LIVE}/game/${gamePk}/feed/live`, 20);

        const abstract = (data.gameData?.status?.abstractGameState ?? "").toLowerCase();
        const state: LiveGameStatus["state"] =
          abstract === "live" ? "live" : abstract === "final" ? "final" : "preview";

        const players: LivePlayerHit[] = [];
        for (const side of [data.liveData?.boxscore?.teams?.away, data.liveData?.boxscore?.teams?.home]) {
          for (const player of Object.values(side?.players ?? {})) {
            const id = player.person?.id;
            if (!id) continue;
            const batting = player.stats?.batting;
            if (!batting) continue;
            players.push({ playerId: id, hits: batting.hits ?? 0, atBats: batting.atBats ?? 0 });
          }
        }

        return {
          gamePk,
          state,
          detailedState: data.gameData?.status?.detailedState ?? "",
          inning: data.liveData?.linescore?.currentInning,
          inningHalf: data.liveData?.linescore?.inningHalf,
          awayScore: data.liveData?.linescore?.teams?.away?.runs,
          homeScore: data.liveData?.linescore?.teams?.home?.runs,
          players,
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((row): row is LiveGameStatus => row !== null);
}
