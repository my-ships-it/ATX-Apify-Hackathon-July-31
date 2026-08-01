# Submission pack — Rumor → Reality Launch Radar

## Public repo
https://github.com/my-ships-it/ATX-Apify-Hackathon-July-31

## Project description
Rumor → Reality Launch Radar is a live launch-intelligence cockpit for noisy startup ecosystems.  
It continuously scrapes rumor-like social chatter and official communications for a target list, indexes everything in Elasticsearch, and turns ambiguous signals into ranked launch status buckets (confirmed / likely / watching) with explicit evidence links.

## Why / how we used Apify + Elasticsearch
- **Apify Twitter Scraper (`danek~twitter-scraper`)**
  - Pulls rumor-like posts from company-related Twitter handles (or search terms per target).
  - Gives fast, structured rumor candidate ingestion with timestamps, text, and URLs.
- **Apify LinkedIn Post Search (`harvestapi~linkedin-post-search`)**
  - Pulls official updates from LinkedIn for the same company set.
  - Gives us “reality” evidence candidates to match against rumor claims.
- **Elasticsearch (Serverless)**
  - Stores rumor and official documents in a single index with semantic field support.
  - Uses a **hybrid retrieval pipeline**:
    1. keyword/BM25 matching for precision,
    2. vector/semantic matching via `semantic_text`,
    3. Reciprocal Rank Fusion (RRF) to combine signal ranking.
  - Produces confidence scores and top matches in a way judges can inspect and verify.
- **Scoring logic (app layer + Elasticsearch context)**
  - Match confidence is calculated from lexical overlap, semantic similarity ranking signals, and lag (time-to-confirmation).
  - Every match renders explainability snippets (`Why this matched`) with direct source links and confidence factors.

## Differentiator vs generic “scrape + search” demos
- Adds **explainability in the UI**: every signal has explicit reason snippets and linked matched evidence.
- Uses **hybrid ES retrieval** with RRF instead of just keyword search.
- Has a polished **decision rail** and **executive summary** layer to support business decisions, not just data viewing.
- Live controls for threshold tuning and data freshness with clear UI feedback loops.

## Live links
- App: https://rumor-radar-web-production.up.railway.app
- API health: https://rumor-radar-web-production.up.railway.app/api/health
- Latest snapshot: https://rumor-radar-web-production.up.railway.app/api/latest

## Quick demo script (60 seconds)
1. Open the app and click **Health check**; confirm Elasticsearch is healthy.
2. Click **Run scan**.  
3. In ~30–90s, the signal board fills. Filter with **Confirmed** / **Likely** / **Watching**.
4. Open the top card in **Signal spotlight** or **Decision rail** and read:
   - status label,
   - confidence percent,
   - “why this matched” reasons,
   - official evidence link.
5. Open **Market signal context (Elasticsearch)** and point out rumor volume trend + trending terms.
6. Click **Copy judge-ready summary** if you want a Slack-ready handoff text.

## Airtable-ready text (copy/paste)

**Description:**  
Rumor → Reality Launch Radar is a launch-reality intelligence tool that ingests rumor signals (Twitter) and official signals (LinkedIn), indexes them in Elasticsearch, and uses hybrid semantic+keyword matching with RRF to classify each signal as Confirmed / Likely / Watching with explainable confidence.

**Why/How using Elastic + Apify:**  
Apify actors supply structured rumor and official streams in near-real-time, then Elasticsearch Serverless indexes documents with semantic fields and runs hybrid retrieval. We fuse BM25 and semantic rank via RRF so each rumor can be matched to corroborating official posts with scoring, lag, and explainability data shown directly in the dashboard.

**Name/Team:**  
Your Name(s): _[fill in]_  
Teammates: _[fill in if applicable]_
