# Rumor → Reality Launch Radar

Hackathon version focused on **Apify + Elasticsearch** with a spicy demo angle:
- Pull rumor-like posts from Twitter
- Pull official updates from LinkedIn
- Store everything in Elasticsearch with hybrid search (`rrf + semantic_text`)
- Surface confidence scores + explanation for each rumor-to-reality match

## Stack
- Node.js + Express API
- Apify actors:
  - `danek~twitter-scraper` (rumor feed)
  - `harvestapi~linkedin-post-search` (official feed)
- Elasticsearch Serverless (`semantic_text`, `rrf` retriever)

## Run locally (2-minute setup)
1. Install deps
   ```bash
   npm install
   ```
2. Configure environment in `.env`
   ```bash
   APIFY_TOKEN=...
   APIFY_RUMOR_ACTOR_ID=danek~twitter-scraper
   APIFY_REALITY_ACTOR_ID=harvestapi~linkedin-post-search
   ELASTICSEARCH_URL=https://...
   ELASTICSEARCH_API_KEY=...
   ```
3. Start
   ```bash
   npm start
   ```
4. Open [http://localhost:3000](http://localhost:3000)

## Demo flow (5 minutes)
1. Click **Health check** to confirm Elasticsearch+env are green.
2. Click **Run scan**.
3. Watch status buckets:
   - **confirmed**: strong rumor → official match with high confidence
   - **likely**: medium confidence, strong semantic + lexical overlap
   - **watching**: rumor only / weak or no match yet
4. Point judges to confidence reasoning and match lag.

## Key endpoints
- `GET /api/health`: environment and Elasticsearch status
- `GET /api/latest`: most recent signals plus the raw feed
- `POST /api/scan`: runs the scrape, index, match, and score pipeline

## Scoring controls (optional, for tune-in seconds)
- `RUMOR_CONFIRM_THRESHOLD` default `48`
- `RUMOR_LIKELY_THRESHOLD` default ~`40` (confirm - 8, capped)
- `ES_RRF_WINDOW_SIZE` default `20`
- `ES_RRF_CONSTANT` default `60`
- `ES_RRF_TOP` default `5`

## One-liner for the judge demo
"The app doesn't just show keyword hits. It explains why rumor chatter gets promoted to likely or confirmed, by combining semantic search, exact overlap, and timing, all inside Elasticsearch."

## Submission pack
- Full submission notes and Airtable-ready copy: [SUBMISSION.md](SUBMISSION.md)
- Live app: https://rumor-radar-web-production.up.railway.app
