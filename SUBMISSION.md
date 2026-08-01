# Submission pack: Rumor → Reality Launch Radar

## Public repo
https://github.com/my-ships-it/ATX-Apify-Hackathon-July-31

## Project description
Rumor → Reality Launch Radar keeps an eye on noisy startup news for you. It scrapes rumor-style social chatter and official company communications for a list of companies, indexes all of it in Elasticsearch, and sorts the messy signal into three clear buckets: confirmed, likely, and watching. Every result links back to the actual evidence behind it.

## Why and how we used Apify and Elasticsearch
- **Apify Twitter Scraper** (`danek~twitter-scraper`) pulls in the rumor-level social chatter for each company.
- **Apify LinkedIn Post Search** (`harvestapi~linkedin-post-search`) pulls in social posts from official company accounts.
- **Apify Website Content Crawler** (`apify~website-content-crawler`) adds a third, stronger tier of evidence. It crawls each company's actual newsroom or blog (openai.com/news, anthropic.com/news, stripe.com/newsroom), so we're checking against a real press release, not just someone's take on one.
- **Elasticsearch Serverless** runs hybrid search on one index: keyword matching (BM25 on title and text), semantic matching through a `semantic_text` field (no manual embedding work needed), and a Reciprocal Rank Fusion (RRF) retriever that blends both instead of just showing two separate result lists.
- **Elasticsearch aggregations** power `/api/trends`: a `date_histogram` for rumor volume over time, a `change_point` aggregation that flags when a company's rumor volume actually spikes or shifts, and `significant_text` to surface which words are showing up more than usual.
- **ES|QL** powers `/api/esql`, a separate query style (Elasticsearch's piped query language) that builds a live leaderboard of company activity straight from a `FROM ... | WHERE ... | EVAL ... | STATS ... BY company` query.
- **Elasticsearch percolator** flips the usual search around. Rumors get stored as saved queries, and when a new official post comes in, we ask Elasticsearch which rumors it satisfies, instead of only searching forward from rumor to evidence. This shows up as an independent check on each signal, and gives a small confidence boost when it agrees with the main match.
- **Live radar** is an optional background loop (`/api/autoscan`, over Server-Sent Events) that rescans on a timer, compares each signal's status to the previous run, and pushes a live alert the instant something moves from watching to likely to confirmed. No page reload needed.

## What makes this different from a typical "scrape and search" demo
- Three tiers of evidence instead of two: social rumor, social "official" post, and an actual company press release.
- Two different Elasticsearch query styles (aggregations and ES|QL), plus a percolator doing reverse matching. Most hackathon Elastic projects stop at a single search call.
- Real momentum detection, not just a static count: the `change_point` aggregation flags when a company's rumor volume genuinely shifts.
- It's live: alerts push over SSE the moment a rumor gets confirmed, no manual refresh needed.
- Every signal shows its reasoning in plain terms, with links to the matching evidence.
- The interface is built to be read by a person making a decision, not just a table of raw data.

## Live links
- App: https://rumor-radar-web-production.up.railway.app
- API health: https://rumor-radar-web-production.up.railway.app/api/health
- Latest results: https://rumor-radar-web-production.up.railway.app/api/latest

## Quick demo script (90 seconds)
1. Open the app and click **Health check** to confirm Elasticsearch is up.
2. Click **Run scan** (the first cold run takes about 2 to 5 minutes: 3 companies across 3 Apify sources, including a real crawl of each company's blog).
3. The signal board fills in. Filter by **Confirmed**, **Likely**, or **Watching**.
4. Open the top card in **Signal spotlight** and walk through its status, confidence score, the reasons it matched, and the linked evidence (point out when it's a real company blog post, not just a social post).
5. Scroll to **Trends behind the numbers** and point out the rumor volume chart, the sudden-change callout, and the trending words, all computed live by Elasticsearch, not in the browser.
6. Hit `/api/esql` directly (or use the panel) to show the ES|QL leaderboard query in plain text.
7. Turn on **Live radar**, then trigger a scan from another tab or device. Watch a toast alert arrive over SSE the moment a signal changes status, with no reload.

## Airtable-ready text (copy and paste)

**Description:**
Rumor → Reality Launch Radar pulls in rumor signals from Twitter, social "official" posts from LinkedIn, and real official press releases crawled from company blogs, all through Apify. It indexes everything in Elasticsearch and sorts each rumor into Confirmed, Likely, or Watching using a hybrid search (keyword plus semantic, combined with RRF), double-checked against an independent Elasticsearch percolator match. A live radar pushes real-time alerts the instant a rumor gets confirmed.

**Why and how we used Elastic and Apify:**
Three Apify actors (a Twitter scraper, a LinkedIn search, and a website content crawler) supply the rumor evidence and two tiers of "reality" evidence. Elasticsearch Serverless indexes all of it with a `semantic_text` field and answers three different kinds of questions: hybrid RRF search to match rumors to evidence, aggregations (`date_histogram`, `change_point`, `significant_text`) to spot market trends, ES|QL for a piped-query company leaderboard, and a percolator index to check, in reverse, which rumors a new document satisfies.

**Name/Team:**
Your Name(s): _[fill in]_
Teammates: _[fill in if applicable]_
