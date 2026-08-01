# Rumor → Reality Launch Radar

**Live app: https://rumor-radar-web-production.up.railway.app**

Tracks rumor-level chatter about a set of companies, gathers official evidence, and answers one question per rumor: has this actually been confirmed yet?

Each rumor lands in one of three buckets (Confirmed / Likely / Watching) with a confidence score, the lag between rumor and confirmation, and a link to the specific evidence behind it.

Built for ATX Elastic + Apify HackNight, July 31 2026.

## Data sources (Apify)

| Tier | Source | Actor |
|---|---|---|
| Rumor | Twitter chatter | `danek/twitter-scraper` |
| Reality (social) | LinkedIn official posts | `harvestapi/linkedin-post-search` |
| Reality (primary) | Company newsroom | `apify/website-content-crawler` |

The third tier crawls `openai.com/news`, `anthropic.com/news`, and `stripe.com/newsroom`, so Confirmed means matched against an actual press release rather than another social post.

## Elasticsearch usage

**Hybrid retrieval** — BM25 keyword matching plus semantic matching over a `semantic_text` field, fused with a Reciprocal Rank Fusion retriever.

**Aggregations** (`GET /api/trends`) — `date_histogram` for rumor volume over time, `change_point` to detect momentum shifts, `significant_text` for trending language vs. background frequency.

**ES|QL** (`GET /api/esql`) — company leaderboard via the piped query language:

```esql
FROM rumor-reality-radar
| WHERE sourceType == "rumor"
| EVAL text_len = LENGTH(text)
| STATS rumor_count = COUNT(*), avg_text_len = ROUND(AVG(text_len)) BY company
| SORT rumor_count DESC
```

**Percolator** (`POST /api/percolate-test`) — search in reverse. Rumors are stored as queries, and each new official document is percolated against them to ask which rumors it confirms. Acts as an independent cross-check on every signal, and works standalone:

```bash
curl -X POST https://rumor-radar-web-production.up.railway.app/api/percolate-test \
  -H 'Content-Type: application/json' \
  -d '{"company":"Anthropic","text":"<paste any headline here>"}'
```

## Live updates

Live radar mode re-scans on a timer, diffs each signal against the previous run, and pushes a Server-Sent Event when a rumor flips Watching → Likely → Confirmed. No page reload.

## Engineering notes

- Scan completes in ~33s. Initially the 3 companies × 3 sources ran sequentially and Railway's proxy returned a 502; actor calls now run concurrently via `Promise.all`.
- Per-run cost and memory caps (`maxTotalChargeUsd`, `memory`) keep a scan from burning credits or exceeding the account's concurrent memory limit.
- A scan mutex prevents UI-triggered and auto-scan runs from overlapping.
- A slow or unreachable source degrades only that source instead of failing the whole scan.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Env + Elasticsearch status |
| `POST /api/scan` | Scrape → index → match → score |
| `GET /api/latest` | Most recent signals + raw feed |
| `GET /api/trends` | Aggregation-based trend data |
| `GET /api/esql` | ES\|QL company leaderboard |
| `POST /api/percolate-test` | Percolator reverse-match |
| `GET /api/events` | SSE stream of status-flip alerts |
| `POST /api/autoscan` | Toggle background re-scan loop |

## Run locally

```bash
npm install
cp .env.example .env   # add APIFY_TOKEN, ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY
npm start
```

Open http://localhost:3000

Optional env tuning: `RUMOR_CONFIRM_THRESHOLD`, `RUMOR_LIKELY_THRESHOLD`, `ES_RRF_WINDOW_SIZE`, `ES_RRF_CONSTANT`, `ES_RRF_TOP`, `APIFY_MAX_POSTS_DEFAULT`.

Companies and sources are configured in [`data/targets.json`](data/targets.json).

## Stack

Node.js + Express, Apify (3 actors), Elasticsearch Serverless, deployed on Railway.

Submission notes: [SUBMISSION.md](SUBMISSION.md)
