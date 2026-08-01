# Submission pack — Rumor → Reality Launch Radar

## Public repo
https://github.com/my-ships-it/ATX-Apify-Hackathon-July-31

## Project description
Rumor → Reality Launch Radar is a live launch-intelligence cockpit for noisy startup ecosystems.  
It continuously scrapes rumor-like social chatter and official communications for a target list, indexes everything in Elasticsearch, and turns ambiguous signals into ranked launch status buckets (confirmed / likely / watching) with explicit evidence links.

## Why / how we used Apify + Elasticsearch
- **Apify Twitter Scraper (`danek~twitter-scraper`)** — rumor-tier social chatter per company.
- **Apify LinkedIn Post Search (`harvestapi~linkedin-post-search`)** — social "official" signal.
- **Apify Website Content Crawler (`apify~website-content-crawler`)** — a *third* evidence tier:
  crawls each company's actual official newsroom/blog (openai.com/news, anthropic.com/news,
  stripe.com/newsroom). This is a materially stronger "reality" signal than a random social post —
  a real press release, not just someone's take on it.
- **Elasticsearch (Serverless)** — single index, hybrid retrieval:
  1. BM25 keyword matching (`multi_match` on title/text),
  2. semantic matching via a `semantic_text` field (dense embeddings, no manual vectorization),
  3. combined with a **Reciprocal Rank Fusion (RRF) retriever** — not just concatenated results.
- **Elasticsearch aggregations (`/api/trends`)** — `date_histogram` for rumor volume over time,
  `change_point` aggregation to auto-detect momentum shifts (spike/dip/trend_change) in rumor
  volume, and `significant_text` to surface trending rumor language vs. background frequency.
- **ES|QL (`/api/esql`)** — a distinct query surface (Elasticsearch's piped query language, not the
  DSL) computing a live company leaderboard: `FROM ... | WHERE ... | EVAL ... | STATS ... BY company`.
- **Elasticsearch percolator** — rumors are registered as *stored queries* in a percolator index;
  as new official docs arrive we ask Elasticsearch in reverse "which rumors does this satisfy?"
  instead of only forward-searching from rumor → official. Surfaces as an independent
  `percolatorConfirmed` cross-check on each signal, with a small confidence boost when it agrees
  with the forward RRF match.
- **Live radar (Server-Sent Events)** — an opt-in background auto-scan loop (`/api/autoscan`) that
  re-scans on an interval, diffs signal status against the previous run, and pushes real-time
  `alert` events over SSE the instant a rumor flips watching → likely → confirmed. The UI shows
  toast notifications live, no page reload.

## Differentiator vs generic “scrape + search” demos
- **Three-tier evidence, not two**: social rumor → social "official" → actual company press release.
- **Two distinct Elasticsearch query surfaces** (DSL aggregations + ES|QL) plus a **percolator**
  reverse-search cross-check — most hackathon Elastic integrations stop at one `_search` call.
- **Momentum detection**, not just a static snapshot: `change_point` aggregation flags when rumor
  volume for a company actually shifts.
- **It's live**: SSE-pushed alerts the moment a rumor gets confirmed, not just a manual refresh.
- Full explainability in the UI: every signal has reason snippets and linked matched evidence.
- Polished decision rail / executive summary layer for business-readable output, not raw data.

## Live links
- App: https://rumor-radar-web-production.up.railway.app
- API health: https://rumor-radar-web-production.up.railway.app/api/health
- Latest snapshot: https://rumor-radar-web-production.up.railway.app/api/latest

## Quick demo script (90 seconds)
1. Open the app and click **Health check**; confirm Elasticsearch is healthy.
2. Click **Run scan** (first cold run takes ~2-5 min — 3 companies × 3 Apify sources, including a
   real website crawl of each company's official blog).
3. Signal board fills. Filter with **Confirmed** / **Likely** / **Watching**.
4. Open the top card in **Signal spotlight** and read: status, confidence, "why this matched"
   reasons, and the linked official evidence (note when it's a company blog post, not just a
   social post).
5. Scroll to **Market signals** — point out the `date_histogram` volume sparkline, the
   `change_point` momentum callout, and `significant_text` trending terms — all live Elasticsearch
   aggregations, not client-side math.
6. Hit `/api/esql` directly (or the panel) to show the ES|QL leaderboard query in plain text.
7. Toggle **Live radar** on, then trigger a scan from another tab/device — watch a toast alert
   arrive over SSE the moment a signal flips status, with zero page reload.

## Airtable-ready text (copy/paste)

**Description:**  
Rumor → Reality Launch Radar ingests rumor signals (Twitter), social "official" signals (LinkedIn), and real official press releases (crawled company blogs) via Apify, indexes them in Elasticsearch, and classifies each rumor as Confirmed / Likely / Watching using a hybrid BM25 + semantic RRF retriever, cross-checked against an independent Elasticsearch percolator reverse-match. A live SSE radar pushes real-time alerts the instant a rumor gets confirmed.

**Why/How using Elastic + Apify:**  
Three Apify actors (Twitter scraper, LinkedIn search, website content crawler) supply structured rumor and multi-tier reality evidence. Elasticsearch Serverless indexes everything with a `semantic_text` field and answers three distinct kinds of question: hybrid RRF retrieval for rumor-to-evidence matching, DSL aggregations (`date_histogram`, `change_point`, `significant_text`) for market trend detection, ES|QL for a piped-query company leaderboard, and a percolator index for reverse "which rumors does this new doc satisfy" matching.

**Name/Team:**  
Your Name(s): _[fill in]_  
Teammates: _[fill in if applicable]_
