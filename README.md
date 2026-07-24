# Hit Index Pro

A production-ready MVP for daily MLB 1+ hit matchup intelligence. It pulls live MLB schedules, probable starters, player season stats, recent form and available batting orders; then creates explainable hitter rankings and diversified 2-leg combinations.

## What works immediately

- Live MLB schedule for any selected date
- Probable pitchers and season pitcher metrics
- Team hitter season stats and rolling 14-day form
- Official batting order when MLB has posted it
- Expected plate appearances when the lineup is pending
- Starting-pitcher weakness, platoon and opponent-staff factors
- Static park factors
- Explainable Hit Index and model 1+ hit estimate
- Ranked two-leg parlay combinations
- Conservative, balanced and aggressive filters
- Explicit pass signals when a slate does not qualify

## Optional integrations

- **Supabase:** saves predictions and settles results so the model can be audited over time
- **OpenWeather:** adds current temperature, humidity and wind around each venue
- **The Odds API:** retrieves game totals and available 0.5-hit markets, prefers BetMGM by default, removes vig when both sides are available and estimates cross-game parlay prices. Same-game parlay prices still require the sportsbook’s actual quote.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Connect Supabase

1. Create a Supabase project.
2. Open the SQL editor and run `supabase/schema.sql`.
3. Copy `.env.example` to `.env.local`.
4. Add:

```bash
NEXT_PUBLIC_SUPABASE_URL=your-project-url
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
CRON_SECRET=a-long-random-secret
```

The service-role key is used only inside server routes. Never prefix it with `NEXT_PUBLIC_`.

## Add weather

Create an OpenWeather API key and add:

```bash
OPENWEATHER_API_KEY=your-key
```

Without the key, the environment score uses the ballpark factor and neutral weather assumptions.


## Add sportsbook market data

Create a The Odds API key and add:

```bash
THE_ODDS_API_KEY=your-key
PREFERRED_BOOKMAKER=betmgm
```

The app fetches featured MLB totals and, for the highest-ranked games, `batter_hits` markets at 0.5 hits. It calculates a no-vig market probability when both Over and Under are available. Cross-game parlay prices are estimated by multiplying decimal leg prices; same-game prices must still be checked inside the sportsbook.

## Deploy to Netlify

1. Push the project to GitHub.
2. In Netlify, choose Add new site, then Import an existing project, and pick the repo.
3. Add the environment variables (at minimum the three Supabase values below).
4. Deploy.

On Netlify the heavy model build runs in a background function with a 15 minute budget, stores the finished slate in Supabase, and the page reads that cached slate instantly. Two scheduled functions rebuild the slate at 11:00 UTC and 16:00 UTC daily and settle the prior days' predictions against final box scores.

## Important limitations

- The MLB Stats API is a public feed but does not provide every Baseball Savant metric in one licensed, stable endpoint.
- xBA, barrel rate, pitch-mix matchup data, umpire tendencies and live player-prop prices require additional reliable data agreements or adapters.
- Weather near a stadium does not prove roof status or exact wind direction relative to home plate.
- The probabilities are model estimates, not guarantees.
- Parlays increase variance even when both legs are individually strong.

## Recommended next production additions

1. Add a licensed odds feed with 1+ hit prop prices.
2. Store the actual price taken and stake for verified ROI.
3. Add Baseball Savant Statcast ingestion where terms and reliability allow.
4. Add expected-lineup projections earlier in the day.
5. Train/calibrate model weights only after collecting a meaningful out-of-sample history.
