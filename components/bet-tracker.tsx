"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HitterProjection, SlateResponse } from "@/lib/types";

const MONO = '"DM Mono", ui-monospace, SFMono-Regular, monospace';

interface LivePlayerHit {
  playerId: number;
  hits: number;
  atBats: number;
}

interface LiveGameStatus {
  gamePk: number;
  state: "preview" | "live" | "final";
  detailedState: string;
  inning?: number;
  inningHalf?: string;
  awayScore?: number;
  homeScore?: number;
  players: LivePlayerHit[];
}

interface Leg {
  playerId: number;
  name: string;
  team: string;
  opponent: string;
  gamePk: number;
  gameDate: string;
}

interface Bet {
  id: string;
  createdAt: string;
  stake: number;
  odds: number; // American
  legs: Leg[];
}

type LegState = "pending" | "hit" | "live-none" | "miss";

const STORAGE_KEY = "hitindex_live_bets_v1";

function decimalFromAmerican(odds: number): number {
  if (!odds) return 1;
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function loadBets(): Bet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Bet[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBets(bets: Bet[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bets));
  } catch {
    // Storage may be unavailable; the tracker still works for the session.
  }
}

export function BetTracker({ slate }: { slate: SlateResponse | null }) {
  const [bets, setBets] = useState<Bet[]>([]);
  const [statuses, setStatuses] = useState<Map<number, LiveGameStatus>>(new Map());
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Builder state
  const [search, setSearch] = useState("");
  const [draftLegs, setDraftLegs] = useState<Leg[]>([]);
  const [stake, setStake] = useState("");
  const [odds, setOdds] = useState("");

  useEffect(() => {
    setBets(loadBets());
  }, []);

  const persist = useCallback((next: Bet[]) => {
    setBets(next);
    saveBets(next);
  }, []);

  const trackedGamePks = useMemo(() => {
    const set = new Set<number>();
    for (const bet of bets) for (const leg of bet.legs) set.add(leg.gamePk);
    return [...set];
  }, [bets]);

  const fetchLive = useCallback(async () => {
    if (!trackedGamePks.length) {
      setStatuses(new Map());
      return;
    }
    setBuilding(true);
    try {
      const response = await fetch(`/api/live?games=${trackedGamePks.join(",")}`, { cache: "no-store" });
      const payload = (await response.json()) as { statuses: LiveGameStatus[]; updatedAt: string };
      const map = new Map<number, LiveGameStatus>();
      for (const status of payload.statuses ?? []) map.set(status.gamePk, status);
      setStatuses(map);
      setLastUpdated(payload.updatedAt ?? new Date().toISOString());
    } catch {
      // Keep the last known state on a failed poll.
    } finally {
      setBuilding(false);
    }
  }, [trackedGamePks]);

  useEffect(() => {
    fetchLive();
    if (pollRef.current) clearInterval(pollRef.current);
    if (trackedGamePks.length) {
      pollRef.current = setInterval(fetchLive, 60000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchLive, trackedGamePks.length]);

  const legState = useCallback(
    (leg: Leg): { state: LegState; hits: number; game?: LiveGameStatus } => {
      const game = statuses.get(leg.gamePk);
      if (!game) return { state: "pending", hits: 0 };
      const line = game.players.find((player) => player.playerId === leg.playerId);
      const hits = line?.hits ?? 0;
      if (hits > 0) return { state: "hit", hits, game };
      if (game.state === "final") return { state: "miss", hits, game };
      if (game.state === "live") return { state: "live-none", hits, game };
      return { state: "pending", hits, game };
    },
    [statuses],
  );

  const betOutcome = useCallback(
    (bet: Bet) => {
      const legInfos = bet.legs.map((leg) => legState(leg));
      const anyMiss = legInfos.some((info) => info.state === "miss");
      const allHit = legInfos.every((info) => info.state === "hit");
      const decimal = decimalFromAmerican(bet.odds);
      const potentialPayout = bet.stake * decimal;
      const profit = potentialPayout - bet.stake;
      const hitCount = legInfos.filter((info) => info.state === "hit").length;
      const started = legInfos.some((info) => info.game && info.game.state !== "preview");
      const status: "won" | "lost" | "live" | "pending" = anyMiss
        ? "lost"
        : allHit
          ? "won"
          : started
            ? "live"
            : "pending";
      return { legInfos, status, potentialPayout, profit, hitCount, decimal };
    },
    [legState],
  );

  // Builder helpers
  const availableHitters = useMemo(() => {
    const hitters = slate?.hitters ?? [];
    const chosen = new Set(draftLegs.map((leg) => leg.playerId));
    const query = search.trim().toLowerCase();
    return hitters
      .filter((hitter) => !chosen.has(hitter.playerId))
      .filter((hitter) => (query ? hitter.name.toLowerCase().includes(query) || hitter.team.toLowerCase().includes(query) : true))
      .slice(0, query ? 12 : 8);
  }, [slate, draftLegs, search]);

  const addLeg = (hitter: HitterProjection) => {
    setDraftLegs((prev) => [
      ...prev,
      {
        playerId: hitter.playerId,
        name: hitter.name,
        team: hitter.team,
        opponent: hitter.opponent,
        gamePk: hitter.gamePk,
        gameDate: hitter.gameDate,
      },
    ]);
    setSearch("");
  };

  const removeDraftLeg = (playerId: number) => {
    setDraftLegs((prev) => prev.filter((leg) => leg.playerId !== playerId));
  };

  const draftDecimal = useMemo(() => {
    const parsed = Number(odds);
    return Number.isFinite(parsed) && parsed !== 0 ? decimalFromAmerican(parsed) : null;
  }, [odds]);

  const draftPayout = useMemo(() => {
    const stakeValue = Number(stake);
    if (!draftDecimal || !Number.isFinite(stakeValue) || stakeValue <= 0) return null;
    return stakeValue * draftDecimal;
  }, [stake, draftDecimal]);

  const canSubmit = draftLegs.length >= 1 && Number(stake) > 0 && Number(odds) !== 0 && Number.isFinite(Number(odds));

  const submitBet = () => {
    if (!canSubmit) return;
    const bet: Bet = {
      id: `${Date.now()}`,
      createdAt: new Date().toISOString(),
      stake: Number(stake),
      odds: Math.round(Number(odds)),
      legs: draftLegs,
    };
    persist([bet, ...bets]);
    setDraftLegs([]);
    setStake("");
    setOdds("");
    setSearch("");
  };

  const removeBet = (id: string) => persist(bets.filter((bet) => bet.id !== id));

  const totals = useMemo(() => {
    let staked = 0;
    let livePayout = 0;
    let won = 0;
    let lost = 0;
    for (const bet of bets) {
      staked += bet.stake;
      const outcome = betOutcome(bet);
      if (outcome.status === "won") { won += 1; livePayout += outcome.potentialPayout; }
      else if (outcome.status === "lost") { lost += 1; }
      else { livePayout += outcome.potentialPayout; }
    }
    return { staked, livePayout, won, lost };
  }, [bets, betOutcome]);

  const statusColor = (status: string) =>
    status === "won" ? "var(--acid)" : status === "lost" ? "var(--red)" : status === "live" ? "var(--amber)" : "var(--muted-2)";

  const legColor = (state: LegState) =>
    state === "hit" ? "var(--acid)" : state === "miss" ? "var(--red)" : state === "live-none" ? "var(--amber)" : "var(--muted-2)";

  const legLabel = (state: LegState, hits: number) =>
    state === "hit" ? `${hits} HIT${hits === 1 ? "" : "S"}` : state === "miss" ? "NO HIT" : state === "live-none" ? "0 SO FAR" : "PREGAME";

  return (
    <div>
      <style>{`
        .bt-card { position: relative; overflow: hidden; }
        .bt-input {
          height: 44px; width: 100%; border: 1px solid var(--line); border-radius: 12px;
          padding: 0 14px; background: rgba(255,255,255,.02); color: var(--text);
          font-family: ${MONO}; font-size: 14px; outline: none;
        }
        .bt-input:focus { border-color: var(--acid); }
        .bt-suggest {
          display: flex; justify-content: space-between; align-items: center;
          padding: 11px 14px; border: 1px solid var(--line); border-radius: 11px;
          background: rgba(255,255,255,.02); cursor: pointer; transition: all .12s;
        }
        .bt-suggest:hover { border-color: var(--acid); background: rgba(183,255,99,.06); }
        .bt-chip {
          display: inline-flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px;
          border: 1px solid var(--line-strong); border-radius: 10px; background: rgba(255,255,255,.03);
          font-size: 13px;
        }
        .bt-chip button {
          width: 18px; height: 18px; border-radius: 6px; border: 0; cursor: pointer;
          background: rgba(255,255,255,.08); color: var(--muted); font-size: 12px; line-height: 1;
        }
        .bt-chip button:hover { background: var(--red); color: #07100d; }
        .bt-add {
          height: 48px; width: 100%; border: 0; border-radius: 13px; cursor: pointer;
          background: var(--acid); color: #07100d; font-weight: 800; font-size: 14px;
          letter-spacing: .02em; transition: opacity .12s;
        }
        .bt-add:disabled { opacity: .4; cursor: not-allowed; }
        .bt-live-dot {
          width: 7px; height: 7px; border-radius: 50%; background: var(--amber);
          box-shadow: 0 0 10px var(--amber); animation: btpulse 1.4s ease-in-out infinite;
        }
        @keyframes btpulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        .bt-leg-row {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 13px 15px; border-radius: 12px; border: 1px solid var(--line);
          background: rgba(255,255,255,.015);
        }
        .bt-pill {
          font-family: ${MONO}; font-size: 10px; font-weight: 700; letter-spacing: .08em;
          padding: 5px 9px; border-radius: 7px;
        }
        .bt-progress { height: 5px; border-radius: 4px; background: rgba(255,255,255,.07); overflow: hidden; }
        .bt-progress span { display: block; height: 100%; border-radius: 4px; transition: width .5s ease; }
      `}</style>

      <div className="section-title">
        <div>
          <div className="micro-label">Live Bet Tracker</div>
          <h2>Your Slips, Tracked in Real Time</h2>
        </div>
        <p>Build a slip from any players, enter your stake and odds, and watch every leg live.</p>
      </div>

      {/* Builder */}
      <div className="panel bt-card" style={{ marginBottom: 22 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 26 }}>
          <div>
            <div className="micro-label" style={{ marginBottom: 12 }}>1 · Add Players</div>
            <input
              className="bt-input"
              placeholder="Search a hitter or team on today's slate..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {draftLegs.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                {draftLegs.map((leg) => (
                  <span key={leg.playerId} className="bt-chip">
                    <b style={{ fontWeight: 600 }}>{leg.name}</b>
                    <span style={{ color: "var(--muted-2)", fontFamily: MONO, fontSize: 11 }}>{leg.team}</span>
                    <button type="button" onClick={() => removeDraftLeg(leg.playerId)} aria-label={`Remove ${leg.name}`}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 14 }}>
              {availableHitters.map((hitter) => (
                <div key={hitter.playerId} className="bt-suggest" onClick={() => addLeg(hitter)}>
                  <div>
                    <b style={{ fontWeight: 600, fontSize: 14 }}>{hitter.name}</b>
                    <span style={{ color: "var(--muted-2)", fontSize: 12, marginLeft: 8 }}>
                      {hitter.team} vs {hitter.opponent}
                    </span>
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--acid)" }}>
                    {Math.round(hitter.modelHitProbability * 100)}%
                  </span>
                </div>
              ))}
              {!availableHitters.length && search ? (
                <div style={{ color: "var(--muted-2)", fontSize: 13, padding: "6px 2px" }}>
                  No match on today's slate. You can only track players who are playing today.
                </div>
              ) : null}
            </div>
          </div>

          <div>
            <div className="micro-label" style={{ marginBottom: 12 }}>2 · Stake and Odds</div>
            <label style={{ display: "block", fontSize: 11, color: "var(--muted-2)", marginBottom: 6, fontFamily: MONO, letterSpacing: ".06em" }}>BET AMOUNT ($)</label>
            <input className="bt-input" inputMode="decimal" placeholder="50" value={stake} onChange={(event) => setStake(event.target.value.replace(/[^0-9.]/g, ""))} />
            <label style={{ display: "block", fontSize: 11, color: "var(--muted-2)", margin: "14px 0 6px", fontFamily: MONO, letterSpacing: ".06em" }}>ODDS (AMERICAN, e.g. +260 or -110)</label>
            <input className="bt-input" inputMode="text" placeholder="+260" value={odds} onChange={(event) => setOdds(event.target.value.replace(/[^0-9+-]/g, ""))} />

            <div style={{ marginTop: 16, padding: "14px 16px", borderRadius: 13, border: "1px solid var(--line)", background: "rgba(183,255,99,.04)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted-2)", fontFamily: MONO }}>
                <span>DECIMAL</span>
                <span style={{ color: "var(--text)" }}>{draftDecimal ? draftDecimal.toFixed(2) : "--"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted-2)", fontFamily: MONO, marginTop: 8 }}>
                <span>TO WIN</span>
                <span style={{ color: "var(--acid)", fontWeight: 700 }}>{draftPayout ? formatCurrency(draftPayout - Number(stake)) : "--"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                <span style={{ color: "var(--muted)" }}>Total payout</span>
                <span style={{ color: "var(--text)", fontWeight: 700, fontFamily: MONO }}>{draftPayout ? formatCurrency(draftPayout) : "--"}</span>
              </div>
            </div>

            <button type="button" className="bt-add" style={{ marginTop: 16 }} disabled={!canSubmit} onClick={submitBet}>
              {draftLegs.length > 1 ? `Track ${draftLegs.length}-Leg Parlay` : "Track This Bet"}
            </button>
          </div>
        </div>
      </div>

      {/* Portfolio summary */}
      {bets.length ? (
        <div className="kpi-grid" style={{ marginBottom: 22 }}>
          <div className="panel kpi"><span>Active Slips</span><strong>{bets.length}</strong></div>
          <div className="panel kpi"><span>Total Staked</span><strong>{formatCurrency(totals.staked)}</strong></div>
          <div className="panel kpi"><span>Live + Won Payout</span><strong style={{ color: "var(--acid)" }}>{formatCurrency(totals.livePayout)}</strong></div>
          <div className="panel kpi">
            <span>Record</span>
            <strong>
              <span style={{ color: "var(--acid)" }}>{totals.won}W</span>
              <span style={{ color: "var(--muted-2)" }}> · </span>
              <span style={{ color: "var(--red)" }}>{totals.lost}L</span>
            </strong>
          </div>
        </div>
      ) : null}

      {/* Live update status line */}
      {bets.length ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, fontSize: 12, color: "var(--muted-2)", fontFamily: MONO }}>
          {trackedGamePks.some((pk) => statuses.get(pk)?.state === "live") ? <i className="bt-live-dot" /> : null}
          <span>
            {building ? "Refreshing live scores..." : lastUpdated ? `Live · updated ${new Date(lastUpdated).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Waiting for first pitch"}
          </span>
          <button type="button" onClick={fetchLive} style={{ marginLeft: "auto", background: "none", border: "1px solid var(--line)", color: "var(--muted)", borderRadius: 8, padding: "5px 11px", cursor: "pointer", fontSize: 11 }}>
            Refresh now
          </button>
        </div>
      ) : null}

      {/* Bet slips */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!bets.length ? (
          <div className="panel" style={{ textAlign: "center", padding: "40px 20px" }}>
            <div className="micro-label" style={{ marginBottom: 8 }}>No Slips Yet</div>
            <p style={{ color: "var(--muted)", maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>
              Build a slip above with any players from today's board. Each leg tracks live: green when they get their hit,
              amber while their game is on, red if the game ends with no hit.
            </p>
          </div>
        ) : null}

        {bets.map((bet) => {
          const outcome = betOutcome(bet);
          return (
            <div key={bet.id} className="panel bt-card">
              <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 100% at 100% 0%, ${statusColor(outcome.status)}14, transparent 55%)`, pointerEvents: "none" }} />
              <div style={{ position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                  <div>
                    <span className="bt-pill" style={{ background: `${statusColor(outcome.status)}1f`, color: statusColor(outcome.status) }}>
                      {outcome.status === "won" ? "CASHED" : outcome.status === "lost" ? "LOST" : outcome.status === "live" ? "IN PROGRESS" : "PREGAME"}
                    </span>
                    <span style={{ marginLeft: 10, fontFamily: MONO, fontSize: 12, color: "var(--muted-2)" }}>
                      {bet.legs.length}-leg · {formatOdds(bet.odds)}
                    </span>
                  </div>
                  <button type="button" onClick={() => removeBet(bet.id)} style={{ background: "none", border: "1px solid var(--line)", color: "var(--muted-2)", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 11 }}>
                    Remove
                  </button>
                </div>

                <div style={{ display: "flex", gap: 22, marginBottom: 16, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--muted-2)", fontFamily: MONO, letterSpacing: ".08em" }}>STAKE</div>
                    <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO }}>{formatCurrency(bet.stake)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--muted-2)", fontFamily: MONO, letterSpacing: ".08em" }}>TO WIN</div>
                    <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO, color: "var(--acid)" }}>{formatCurrency(outcome.profit)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--muted-2)", fontFamily: MONO, letterSpacing: ".08em" }}>PAYOUT</div>
                    <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO }}>{formatCurrency(outcome.potentialPayout)}</div>
                  </div>
                  <div style={{ marginLeft: "auto", textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: "var(--muted-2)", fontFamily: MONO, letterSpacing: ".08em" }}>LEGS HIT</div>
                    <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO }}>
                      <span style={{ color: outcome.hitCount === bet.legs.length ? "var(--acid)" : "var(--text)" }}>{outcome.hitCount}</span>
                      <span style={{ color: "var(--muted-2)" }}>/{bet.legs.length}</span>
                    </div>
                  </div>
                </div>

                <div className="bt-progress" style={{ marginBottom: 16 }}>
                  <span style={{ width: `${(outcome.hitCount / bet.legs.length) * 100}%`, background: outcome.status === "lost" ? "var(--red)" : "var(--acid)" }} />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {bet.legs.map((leg, index) => {
                    const info = outcome.legInfos[index];
                    const game = info.game;
                    return (
                      <div key={leg.playerId} className="bt-leg-row">
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{leg.name}</div>
                          <div style={{ fontSize: 11, color: "var(--muted-2)", fontFamily: MONO, marginTop: 2 }}>
                            {leg.team} vs {leg.opponent}
                            {game && game.state === "live" && game.inning ? ` · ${game.inningHalf ?? ""} ${game.inning}` : ""}
                            {game && game.state === "final" ? " · Final" : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          {game && game.state === "live" ? <i className="bt-live-dot" /> : null}
                          <span className="bt-pill" style={{ background: `${legColor(info.state)}1f`, color: legColor(info.state) }}>
                            {legLabel(info.state, info.hits)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
