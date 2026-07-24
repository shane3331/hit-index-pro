import { buildParlays, calculateHitterProjection, clamp, pitcherWeaknessScore, weatherEnvironmentScore } from "./model";
import { shiftIsoDate } from "./date";
import type { GameProjection, HitterProjection, PitcherSnapshot, SlateResponse, WeatherSnapshot } from "./types";

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

async function getTeamSeasonStats(teamId: number, group: "hitting" | "pitching", season: string): Promise<StatLine[]> {
  const params = new URLSearchParams({
    stats: "season",
    group,
    teamId: String(teamId),
    season,
    sportIds: "1",
    hydrate: "person",
  });
  const data = await fetchJson<{ stats?: Array<{ splits?: StatLine[] }> }>(`${MLB_API}/stats?${params.toString()}`);
  return data.stats?.[0]?.splits ?? [];
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
    return data.stats?.[0]?.splits ?? [];
  } catch {
    return [];
  }
}

async function getLineup(gamePk: number): Promise<Map<number, number>> {
  const lineup = new Map<number, number>();
  try {
    const data = await fetchJson<{
      teams?: {
        away?: { players?: Record<string, { person?: { id?: number }; battingOrder?: string }> };
        home?: { players?: Record<string, { person?: { id?: number }; battingOrder?: string }> };
      };
    }>(`${MLB_API}/game/${gamePk}/boxscore`, 30);

    for (const side of [data.teams?.away, data.teams?.home]) {
      for (const player of Object.values(side?.players ?? {})) {
        const playerId = player.person?.id;
        const battingOrder = Number(player.battingOrder);
        if (playerId && battingOrder) lineup.set(playerId, Math.ceil(battingOrder / 100));
      }
    }
  } catch {
    // Pregame lineups are frequently unavailable until near first pitch.
  }
  return lineup;
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
  staffWeakness: number;
  activeRoster: Set<number>;
}): HitterProjection[] {
  const { game, side, seasonLines, recentLines, lineup, staffWeakness, activeRoster } = input;
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
      if (activeRoster.size && !activeRoster.has(playerId)) return null;
      const season = line.stat ?? {};
      const recent = recentByPlayer.get(playerId) ?? {};
      const atBats = numberValue(season.atBats);
      const gamesPlayed = numberValue(season.gamesPlayed);
      const seasonAvg = numberValue(season.avg);
      const recentAvg = numberValue(recent.avg, seasonAvg);
      if (atBats < 35 || gamesPlayed < 12 || seasonAvg <= 0) return null;

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
      warnings: ["No MLB games are scheduled for this date."],
    };
  }

  const season = date.slice(0, 4);
  const oddsContext = await getFeaturedOdds();
  const oddsEventByGame = new Map<number, string>();
  let weatherAvailableCount = 0;
  let propMarketCount = 0;
  const games: GameProjection[] = [];
  const hitters: HitterProjection[] = [];

  for (const rawGame of gamesRaw) {
    const [awayPitcher, homePitcher, weather, lineup] = await Promise.all([
      getPitcherSnapshot(rawGame.teams.away.probablePitcher, season),
      getPitcherSnapshot(rawGame.teams.home.probablePitcher, season),
      getWeather(rawGame.venue?.id, rawGame.gameDate),
      getLineup(rawGame.gamePk),
    ]);

    const marketContext = oddsContext.get(matchupKey(rawGame.teams.away.team.name, rawGame.teams.home.team.name));
    if (marketContext?.eventId) oddsEventByGame.set(rawGame.gamePk, marketContext.eventId);
    if (weather.available) weatherAvailableCount += 1;
    const game = toGameProjection(rawGame, awayPitcher, homePitcher, weather, marketContext?.marketTotal);
    games.push(game);

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

    hitters.push(
      ...buildTeamHitters({
        game,
        side: "away",
        seasonLines: awaySeason,
        recentLines: awayRecent,
        lineup,
        staffWeakness: teamStaffWeakness(homeStaff),
        activeRoster: awayRoster,
      }),
      ...buildTeamHitters({
        game,
        side: "home",
        seasonLines: homeSeason,
        recentLines: homeRecent,
        lineup,
        staffWeakness: teamStaffWeakness(awayStaff),
        activeRoster: homeRoster,
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
  if (hitters.every((hitter) => !hitter.lineupSlot)) {
    warnings.push("Official batting orders are not posted yet; expected plate appearances use neutral lineup estimates.");
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
    warnings,
  };
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
