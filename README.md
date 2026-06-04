# RaceReady

A marathon training planner built on the Daniels 2Q methodology. Plan each week around two quality workouts with easy mileage filling the volume — no junk miles. Tracks weekly targets, WoW ramp rate, and acute:chronic workload ratio (ACR) per day.

**Live app:** [raceready2q.netlify.app](https://raceready2q.netlify.app)

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Static `index.html` + `styles.css` + `app.js` — no build step |
| Database | Supabase (Postgres via REST API) |
| Hosting | Netlify (static drag-and-drop deploy) |
| AI | Anthropic API (`claude-sonnet-4-20250514`) for mileage ramp generation |

---

## Setup

### 1. Supabase

The database is already configured at `https://kmzbdoxfhrksimfgxhdb.supabase.co`. The schema and plan data are pre-loaded. No action needed for the primary account.

**To set up a fresh Supabase project:**

1. Create a new project at [supabase.com](https://supabase.com)
2. In the Supabase dashboard → **SQL Editor**, paste and run `schema.sql`
3. Copy your **Project URL** and **anon public key** from Settings → API
4. In `app.js`, replace the two config constants at the top:

```js
const SUPABASE_URL  = 'https://your-project.supabase.co';
const SUPABASE_ANON = 'your-anon-key-here';
```

### 2. Anthropic API key (for mileage ramp generator)

The mileage ramp "Generate weekly targets" feature calls the Anthropic API directly from your browser. Your key is stored only in `localStorage` and never sent anywhere except Anthropic.

1. Get an API key at [console.anthropic.com](https://console.anthropic.com)
2. In the app, click the **🔑 key icon** in the topbar
3. Paste your key and click **Save key**

---

## Deploy to Netlify

1. Go to [app.netlify.com](https://app.netlify.com)
2. Click **Add new site → Deploy manually**
3. Drag the `race-ready` folder onto the upload area
4. Done — Netlify gives you a live URL in seconds

**For automatic deploys on push:**
1. Netlify site → **Site configuration → Build & deploy → Link repository**
2. Select `schloo/race-ready`
3. Build command: *(leave blank)*
4. Publish directory: `.`

---

## Features

- **26-week plan** anchored to your race date, Mon–Sun weeks
- **Daniels 2Q structure** — Q1 and Q2 workout prescriptions per week, assigned to specific days
- **ACR heatmap** — per-day acute:chronic workload ratio with color-coded zones (purple → blue → green → orange → red)
- **Weekly metrics** — vs. target, WoW mileage ramp, WoW long run, pace mix bar
- **AI ramp generation** — describe your mileage strategy in plain English; Claude generates per-week targets
- **Cross-device sync** — all data in Supabase; phone and desktop stay in sync automatically
- **Mobile layout** — week-at-a-time view with swipe navigation and bottom sheets

---

## Data model

| Table | Key fields |
|---|---|
| `plans` | `plan_name`, `race_date`, `num_weeks`, `vdot_paces` |
| `weeks` | `week_number`, `phase`, `location`, `target_miles`, `q1_prescription`, `q2_prescription` |
| `days` | `day_of_week` (0=Mon…6=Sun), `easy_miles`, `marathon_miles`, `threshold_miles`, `interval_miles`, `repetition_miles`, `tags` |

ACR and all weekly summary metrics are derived live from day data — nothing pre-computed.

---

## ACR zones

| Zone | ACR | Color |
|---|---|---|
| Under-training | < 50% | Purple |
| Low | 50–80% | Blue |
| Optimal | 80–130% | Green |
| Caution | 130–150% | Orange |
| High risk | > 150% | Red |

---

## Repo

[github.com/schloo/race-ready](https://github.com/schloo/race-ready)
