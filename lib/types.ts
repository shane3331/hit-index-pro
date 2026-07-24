export type DataStatus = "live" | "partial" | "unavailable";

export interface PitcherSnapshot {
  id?: number;
  name: string;
  hand?: string;
  era?: number;
  whip?: number;
  hitsPer9?: number;
  strikeoutsPer9?: number;
  innings?: number;
}

export interface WeatherSnapshot {
  available: boolean;
  temperatureF?: number;
  humidity?: number;
  windMph?: number;
  windDirection?: number;
  description?: string;
}

export interface GameProjection {
  gamePk: number;
  gameDate: string;
  status: string;
  venue: string;
  away: { id: number; name: string; abbreviation: string; pitcher: PitcherSnapshot };
  home: { id: number; name: string; abbreviation: string; pitcher: PitcherSnapshot };
  weather: WeatherSnapshot;
  environmentScore: number;
  marketTotal?: number;
}

export interface PropMarketSnapshot {
  line: number;
  overPrice: number;
  underPrice?: number;
  noVigProbability?: number;
  bookmaker: string;
  lastUpdate?: string;
}

export interface HitterProjection {
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
  hitsPerGame: number;
  multiHitRate: number;
  expectedPlateAppearances: number;
  modelHitProbability: number;
  fairAmericanOdds: number;
  hitIndex: number;
  confidence: "Elite" | "Strong" | "Qualified" | "Pass";
  factors: {
    contact: number;
    recentForm: number;
    starterWeakness: number;
    lineup: number;
    platoon: number;
    environment: number;
    staff: number;
  };
  explanation: string[];
  market?: PropMarketSnapshot;
  marketEdge?: number;
}

export interface ParlayProjection {
  id: string;
  legs: [HitterProjection, HitterProjection];
  combinedProbability: number;
  fairAmericanOdds: number;
  parlayIndex: number;
  sameGame: boolean;
  reason: string[];
  estimatedMarketOdds?: number;
  marketImpliedProbability?: number;
  modelEdge?: number;
}

export interface SlateResponse {
  date: string;
  generatedAt: string;
  source: {
    mlb: DataStatus;
    weather: DataStatus;
    odds: DataStatus;
    persistence: DataStatus;
  };
  games: GameProjection[];
  hitters: HitterProjection[];
  parlays: ParlayProjection[];
  warnings: string[];
}

export interface HistoryResponse {
  enabled: boolean;
  summary?: {
    predictions: number;
    hits: number;
    hitRate: number;
    parlays: number;
    parlayWins: number;
    parlayWinRate: number;
    roi?: number;
  };
  days?: Array<{
    date: string;
    predictions: number;
    hits: number;
    hitRate: number;
    parlays: number;
    parlayWins: number;
  }>;
}
