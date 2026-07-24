"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryResponse, HitterProjection, ParlayProjection, SlateResponse } from "@/lib/types";

type Mode = "conservative" | "balanced" | "aggressive";

const MODE_LABELS: Record<Mode, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

const MODE_NOTES: Record<Mode, string> = {
  conservative: "Elite confidence only, cross-game parlays with 46%+ combined probability.",
  balanced: "Elite and Strong confidence, parlays with 40%+ combined probability.",
  aggressive: "Every qualified play and every ranked parlay combination.",
};

const NAV_SECTIONS = [
  { id: "overview", label: "Command Center" },
  { id: "games", label: "Games and Starters" },
  { id: "hitters", label: "Hit Index Board" },
  { id: "parlays", label: "Parlay Builder" },
  { id: "history", label: "Track Record" },
  { id: "model", label: "Model Logic" },
];

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function odds(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function ringStyle(score: number, color = "var(--acid)") {
  return { background: `conic-gradient(${color} ${Math.round(score * 3.6)}deg, rgba(255,255,255,.07) 0deg)` };
}

function confidenceColor(confidence: HitterProjection["confidence"]): string {
  if (confidence === "Elite") return "var(--acid)";
  if (confidence === "Strong") return "var(--blue)";
  if (confidence === "Qualified") return "var(--amber)";
  return "var(--muted-2)";
}

function hitterPasses(hitter: HitterProjection, mode: Mode): boolean {
  if (mode === "conservative") return hitter.confidence === "Elite";
  if (mode === "balanced") return hitter.confidence === "Elite" || hitter.confidence === "Strong";
  return hitter.confidence !== "Pass";
}

function parlayPasses(parlay: ParlayProjection, mode: Mode): boolean {
  if (mode === "conservative") {
    return !parlay.sameGame && parlay.combinedProbability >= 0.46 && parlay.legs.every((leg) => leg.confidence === "Elite");
  }
  if (mode === "balanced") {
    return parlay.combinedProbability >= 0.4 && parlay.legs.every((leg) => leg.confidence === "Elite" || leg.confidence === "Strong");
  }
  return true;
}

function gameTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso)) + " ET";
  } catch {
    return "TBD";
  }
}

export function Dashboard({ initialDate }: { initialDate: string }) {
  const [date, setDate] = useState(initialDate);
  const [mode, setMode] = useState<Mode>("balanced");
  const [slate, setSlate] = useState<SlateResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("overview");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSlate = useCallback(async (target: string, refresh = false, silent = false) => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await fetch(`/api/slate?date=${target}${refresh ? "&refresh=1" : ""}`, { cache: "no-store" });
      const payload = (await response.json()) as (SlateResponse & { building?: boolean }) | { building: true; error?: string };
      if (!response.ok) {
        throw new Error(("error" in payload && payload.error) || `Slate request failed (${response.status}).`);
      }
      if ("games" in payload) {
        setSlate(payload);
        setError(null);
      }
      const stillBuilding = Boolean(payload.building);
      setBuilding(stillBuilding);
      if (stillBuilding) {
        pollRef.current = setTimeout(() => {
          loadSlate(target, false, true);
        }, 6000);
      }
    } catch (requestError) {
      setBuilding(false);
      setError(requestError instanceof Error ? requestError.message : "The slate could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSlate(date);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [date, loadSlate]);

  useEffect(() => {
    fetch("/api/history", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => setHistory(payload as HistoryResponse))
      .catch(() => setHistory({ enabled: false }));
  }, []);

  const qualifiedHitters = useMemo(
    () => (slate?.hitters ?? []).filter((hitter) => hitterPasses(hitter, mode)).slice(0, 25),
    [slate, mode],
  );
  const qualifiedParlays = useMemo(
    () => (slate?.parlays ?? []).filter((parlay) => parlayPasses(parlay, mode)).slice(0, 10),
    [slate, mode],
  );
  const eliteCount = useMemo(() => (slate?.hitters ?? []).filter((hitter) => hitter.confidence === "Elite").length, [slate]);
  const topAverage = useMemo(() => {
    const top = (slate?.hitters ?? []).slice(0, 10);
    if (!top.length) return 0;
    return top.reduce((sum, hitter) => sum + hitter.modelHitProbability, 0) / top.length;
  }, [slate]);

  const jumpTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const sourceLabel = (status: string) => (status === "live" ? "Live" : status === "partial" ? "Partial" : "Off");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">H1</div>
          <div>
            <strong>Hit Index Pro</strong>
            <span>MLB 1+ Hit Intelligence</span>
          </div>
        </div>
        <nav>
          {NAV_SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={activeSection === section.id ? "active" : ""}
              onClick={() => jumpTo(section.id)}
            >
              <i className="nav-dot" />
              {section.label}
            </button>
          ))}
        </nav>
        <div className="objective-card">
          <span>Daily Objective</span>
          <strong>1+ Hit</strong>
          <p>Rank the most probable hitters on the slate, then pair them into diversified two-leg combinations with explainable logic.</p>
        </div>
      </aside>

      <main className="content-shell">
        <header className="topbar">
          <div>
            <div className="micro-label">Slate Date (ET)</div>
            <h1>Daily Matchup Board</h1>
          </div>
          <div className="top-controls">
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Slate date" />
            <select value={mode} onChange={(event) => setMode(event.target.value as Mode)} aria-label="Filter mode">
              {(Object.keys(MODE_LABELS) as Mode[]).map((key) => (
                <option key={key} value={key}>{MODE_LABELS[key]}</option>
              ))}
            </select>
            <button type="button" className="refresh-button" disabled={loading || building} onClick={() => loadSlate(date, true)}>
              {loading || building ? "Building..." : "Refresh"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="error-banner">
            <span>ERROR</span>
            {error}
          </div>
        ) : null}

        <section id="overview" className="section-block" style={{ paddingTop: 0 }}>
          <div className="hero-grid">
            <div className="panel command-card">
              <div className="scan-line" />
              <div className="eyebrow">Live Model Run</div>
              <h2>Explainable hit probability for every bat on the slate.</h2>
              <p>
                Season contact quality, rolling 14-day form, opposing starter weakness, batting order, platoon edge, park and
                weather environment, and bullpen quality are combined into a single Hit Index with a model 1+ hit estimate.
                Currently on the {MODE_LABELS[mode]} filter: {MODE_NOTES[mode]}
              </p>
              <div className="source-row">
                {slate ? (
                  <>
                    <span className={`status-pill status-${slate.source.mlb}`}><i />MLB Feed: {sourceLabel(slate.source.mlb)}</span>
                    <span className={`status-pill status-${slate.source.weather}`}><i />Weather: {sourceLabel(slate.source.weather)}</span>
                    <span className={`status-pill status-${slate.source.odds}`}><i />Sportsbook: {sourceLabel(slate.source.odds)}</span>
                    <span className={`status-pill status-${slate.source.persistence}`}><i />Tracking: {sourceLabel(slate.source.persistence)}</span>
                    <span className={`status-pill status-${slate.lineupStatus === "official" ? "live" : slate.lineupStatus === "none" ? "unavailable" : "partial"}`}>
                      <i />Lineups: {slate.lineupStatus === "official" ? "Confirmed" : slate.lineupStatus === "mixed" ? "Part confirmed" : slate.lineupStatus === "projected" ? "Projected" : "Unavailable"}
                    </span>
                    {building ? <span className="status-pill status-partial"><i />Model rebuilding in the background...</span> : null}
                  </>
                ) : (
                  <span className="status-pill"><i />Connecting to the MLB feed...</span>
                )}
              </div>
            </div>
            <div className="panel objective-panel">
              <div className="panel-heading">
                <span>Top Board Average</span>
                <b>{MODE_LABELS[mode]}</b>
              </div>
              <div className="objective-number">
                {topAverage ? pct(topAverage) : "--"}
                <small>model 1+ hit, top 10</small>
              </div>
              <div className="protocol-list">
                <div><span>Games</span><b>{slate?.games.length ?? "--"}</b></div>
                <div><span>Qualified hitters</span><b>{qualifiedHitters.length}</b></div>
                <div><span>Elite confidence</span><b>{eliteCount}</b></div>
                <div><span>Ranked parlays</span><b>{qualifiedParlays.length}</b></div>
              </div>
            </div>
          </div>

          <div className="kpi-grid">
            <div className="panel kpi"><span>Slate Generated</span><strong>{slate ? gameTime(slate.generatedAt) : "--"}</strong></div>
            <div className="panel kpi"><span>Hitters Modeled</span><strong>{slate?.hitters.length ?? "--"}</strong></div>
            <div className="panel kpi"><span>Batting Orders</span><strong>{slate ? (slate.lineupStatus === "official" ? "Confirmed" : slate.lineupStatus === "mixed" ? "Part confirmed" : slate.lineupStatus === "projected" ? "Projected" : "Unavailable") : "--"}</strong></div>
            <div className="panel kpi"><span>Prop Markets</span><strong>{slate ? slate.hitters.filter((hitter) => hitter.market).length : "--"}</strong></div>
          </div>

          {slate?.warnings.length ? (
            <div className="warning-stack">
              {slate.warnings.map((warning) => (
                <div key={warning}><span>Note</span>{warning}</div>
              ))}
            </div>
          ) : null}
        </section>

        <section id="games" className="section-block">
          <div className="section-title">
            <div>
              <div className="micro-label">Schedule</div>
              <h2>Games and Probable Starters</h2>
            </div>
            <p>Park, weather and market context feed the environment score.</p>
          </div>
          <div className="game-grid">
            {(loading || building) && !slate ? <div className="panel loading-panel">Building the slate in the background. This first run can take a couple of minutes...</div> : null}
            {slate && !slate.games.length && !loading && !building ? (
              <div className="panel pass-panel">
                <b>NO GAMES</b>
                <span>MLB has no games scheduled for this date. Pick another slate date above.</span>
              </div>
            ) : null}
            {(slate?.games ?? []).map((game) => (
              <div key={game.gamePk} className="panel game-card">
                <div className="game-top">
                  <span>{gameTime(game.gameDate)} · {game.status}</span>
                  <b>{game.venue}</b>
                </div>
                <div className="teams-row">
                  <strong>{game.away.abbreviation}</strong>
                  <i>at</i>
                  <strong>{game.home.abbreviation}</strong>
                </div>
                <div className="pitcher-row">
                  <div>
                    <span>{game.away.abbreviation} Starter</span>
                    <b>{game.away.pitcher.name}{game.away.pitcher.hand ? ` (${game.away.pitcher.hand}HP)` : ""}</b>
                    <small>
                      {game.away.pitcher.era != null ? `${game.away.pitcher.era.toFixed(2)} ERA` : "ERA TBD"}
                      {game.away.pitcher.whip != null ? ` · ${game.away.pitcher.whip.toFixed(2)} WHIP` : ""}
                    </small>
                  </div>
                  <div>
                    <span>{game.home.abbreviation} Starter</span>
                    <b>{game.home.pitcher.name}{game.home.pitcher.hand ? ` (${game.home.pitcher.hand}HP)` : ""}</b>
                    <small>
                      {game.home.pitcher.era != null ? `${game.home.pitcher.era.toFixed(2)} ERA` : "ERA TBD"}
                      {game.home.pitcher.whip != null ? ` · ${game.home.pitcher.whip.toFixed(2)} WHIP` : ""}
                    </small>
                  </div>
                </div>
                <div className="environment-row">
                  <div>
                    <span>Environment</span>
                    <b>{game.environmentScore}/100</b>
                  </div>
                  <div>
                    <span>Market Total</span>
                    <b>{game.marketTotal != null ? game.marketTotal.toFixed(1) : "--"}</b>
                  </div>
                  <small>
                    {game.weather.available
                      ? `${Math.round(game.weather.temperatureF ?? 0)}F · ${Math.round(game.weather.windMph ?? 0)} mph wind · ${game.weather.description ?? ""}`
                      : "Weather feed off: neutral assumptions in use."}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="hitters" className="section-block">
          <div className="section-title">
            <div>
              <div className="micro-label">{MODE_LABELS[mode]} Filter</div>
              <h2>Hit Index Board</h2>
            </div>
            <p>{MODE_NOTES[mode]}</p>
          </div>
          <div className="hitter-list">
            {(loading || building) && !slate ? <div className="panel loading-panel">Scoring every hitter on the slate. The board fills in automatically when the model finishes...</div> : null}
            {slate && !loading && !building && !qualifiedHitters.length ? (
              <div className="panel pass-panel">
                <b>PASS SIGNAL</b>
                <span>
                  No hitter clears the {MODE_LABELS[mode]} bar on this slate. The disciplined play is to pass, loosen the
                  filter, or wait for lineups and updated starter data later in the day.
                </span>
              </div>
            ) : null}
            {qualifiedHitters.map((hitter, index) => (
              <div key={`${hitter.gamePk}-${hitter.playerId}`} className="panel hitter-card">
                <div className="hitter-rank">#{index + 1}</div>
                <div>
                  <div className="hitter-title-row">
                    <div>
                      <div className="micro-label" style={{ color: confidenceColor(hitter.confidence) }}>{hitter.confidence}</div>
                      <h3>{hitter.name}</h3>
                      <p>
                        {hitter.team} vs {hitter.opponent} · faces {hitter.starterName}
                        {hitter.starterHand ? ` (${hitter.starterHand}HP)` : ""}
                        {hitter.lineupSlot
                          ? ` · batting ${hitter.lineupSlot} (${hitter.lineupSource === "official" ? "confirmed" : "projected"})`
                          : " · lineup pending"}
                      </p>
                    </div>
                    <div className="score-ring" style={ringStyle(hitter.hitIndex, confidenceColor(hitter.confidence))}>
                      <div>{hitter.hitIndex}</div>
                    </div>
                  </div>
                  <div className="stat-grid six">
                    <div><span>Model 1+ Hit</span><strong>{pct(hitter.modelHitProbability)}</strong></div>
                    <div><span>Fair Odds</span><strong>{odds(hitter.fairAmericanOdds)}</strong></div>
                    <div><span>Season AVG</span><strong>{hitter.seasonAvg.toFixed(3)}</strong></div>
                    <div><span>Last 14 AVG</span><strong>{hitter.recentAvg.toFixed(3)}</strong></div>
                    <div><span>Expected PA</span><strong>{hitter.expectedPlateAppearances.toFixed(1)}</strong></div>
                    <div>
                      <span>{hitter.market ? hitter.market.bookmaker : "Market"}</span>
                      <strong>
                        {hitter.market
                          ? `${odds(hitter.market.overPrice)}${hitter.marketEdge != null ? ` (${hitter.marketEdge >= 0 ? "+" : ""}${Math.round(hitter.marketEdge * 100)}% edge)` : ""}`
                          : "--"}
                      </strong>
                    </div>
                  </div>
                  <div className="factor-grid">
                    {Object.entries(hitter.factors).map(([key, value]) => (
                      <div key={key}>
                        <div className="factor-meta">
                          <span>{key === "starterWeakness" ? "starter" : key === "recentForm" ? "form" : key}</span>
                          <b>{value}</b>
                        </div>
                        <div className="factor-track"><span style={{ width: `${value}%` }} /></div>
                      </div>
                    ))}
                  </div>
                  <p className="parlay-note">{hitter.explanation.join(" · ")}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="parlays" className="section-block">
          <div className="section-title">
            <div>
              <div className="micro-label">Two-Leg Combinations</div>
              <h2>Parlay Builder</h2>
            </div>
            <p>Diversified pairings ranked by combined index; player exposure is capped.</p>
          </div>
          <div className="parlay-grid">
            {slate && !loading && !building && !qualifiedParlays.length ? (
              <div className="panel pass-panel">
                <b>PASS SIGNAL</b>
                <span>No parlay clears the {MODE_LABELS[mode]} bar today. Passing on a thin slate is a feature, not a bug.</span>
              </div>
            ) : null}
            {qualifiedParlays.map((parlay, index) => (
              <div key={parlay.id} className="panel parlay-card">
                <div className="parlay-head">
                  <div>
                    <div className="micro-label">{parlay.sameGame ? "Same Game" : "Cross Game"} · Rank {index + 1}</div>
                    <h3>{parlay.legs[0].name} + {parlay.legs[1].name}</h3>
                  </div>
                  <div className="score-ring score-ring-small" style={ringStyle(parlay.parlayIndex)}>
                    <div>{parlay.parlayIndex}</div>
                  </div>
                </div>
                <div className="legs">
                  {parlay.legs.map((leg) => (
                    <div key={leg.playerId} className="leg">
                      <div>
                        <span>{leg.confidence.toUpperCase()}</span>
                        <b>{leg.name} 1+ Hit</b>
                        <small>{leg.team} vs {leg.opponent} · faces {leg.starterName}</small>
                      </div>
                      <strong>{pct(leg.modelHitProbability)}</strong>
                    </div>
                  ))}
                </div>
                <div className="parlay-footer">
                  <div><span>Combined</span><b>{pct(parlay.combinedProbability)}</b></div>
                  <div><span>Fair Odds</span><b>{odds(parlay.fairAmericanOdds)}</b></div>
                  <div><span>Est. Market</span><b>{parlay.estimatedMarketOdds != null ? odds(parlay.estimatedMarketOdds) : "--"}</b></div>
                  <div><span>Model Edge</span><b>{parlay.modelEdge != null ? `${parlay.modelEdge >= 0 ? "+" : ""}${Math.round(parlay.modelEdge * 100)}%` : "--"}</b></div>
                </div>
                <p className="parlay-note">{parlay.reason.join(" · ")}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="history" className="section-block">
          <div className="section-title">
            <div>
              <div className="micro-label">Audited Results</div>
              <h2>Track Record</h2>
            </div>
            <p>Predictions settle automatically against final box scores.</p>
          </div>
          {history?.enabled && history.summary ? (
            <div className="history-layout">
              <div className="panel history-kpis">
                <div><span>Settled Predictions</span><b>{history.summary.predictions}</b></div>
                <div><span>1+ Hit Rate</span><b>{pct(history.summary.hitRate)}</b></div>
                <div><span>Settled Parlays</span><b>{history.summary.parlays}</b></div>
                <div><span>Parlay Win Rate</span><b>{pct(history.summary.parlayWinRate)}</b></div>
              </div>
              <div className="panel history-table">
                <div className="table-row table-head">
                  <span>Date</span><span>Predictions</span><span>Hits</span><span>Hit Rate</span><span>Parlay W-L</span>
                </div>
                {(history.days ?? []).map((day) => (
                  <div key={day.date} className="table-row">
                    <span>{day.date}</span>
                    <span>{day.predictions}</span>
                    <span>{day.hits}</span>
                    <span>{pct(day.hitRate)}</span>
                    <span>{day.parlayWins}-{day.parlays - day.parlayWins}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="panel setup-panel">
              <div className="micro-label">Not Connected Yet</div>
              <h3>Turn on performance tracking</h3>
              <p>
                Connect Supabase to save every prediction and settle it against the final box score, so the model can be
                audited over time. In Vercel, add NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and CRON_SECRET, then
                run supabase/schema.sql once in the Supabase SQL editor. The daily cron does the rest automatically.
              </p>
            </div>
          )}
        </section>

        <section id="model" className="section-block">
          <div className="section-title">
            <div>
              <div className="micro-label">Transparent Weights</div>
              <h2>How the Hit Index is built</h2>
            </div>
            <p>Every score is explainable; nothing is a black box.</p>
          </div>
          <div className="model-grid">
            <div className="panel model-card">
              <strong>24%</strong>
              <h3>Contact Quality</h3>
              <p>Season batting average and strikeout rate. High-contact bats put more balls in play per plate appearance.</p>
            </div>
            <div className="panel model-card">
              <strong>20%</strong>
              <h3>Starter Weakness</h3>
              <p>Opposing starter ERA, WHIP, hits per 9 and strikeouts per 9, discounted for small samples.</p>
            </div>
            <div className="panel model-card">
              <strong>18%</strong>
              <h3>Recent Form</h3>
              <p>Rolling 14-day batting average versus season baseline captures hot and cold streaks.</p>
            </div>
            <div className="panel model-card">
              <strong>14% + 24%</strong>
              <h3>Context Stack</h3>
              <p>Batting order (14%), platoon matchup (10%), park and weather environment (8%) and bullpen quality (6%).</p>
            </div>
          </div>
        </section>

        <footer>
          Hit Index Pro produces model estimates from public MLB data. Probabilities are not guarantees, parlays increase
          variance even when both legs are strong, and no output here is betting advice. If you play, set a budget and stick
          to it. Data: MLB Stats API, OpenWeather and The Odds API where configured.
        </footer>
      </main>
    </div>
  );
}
