import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { Client as EsClient } from '@elastic/elasticsearch';

dotenv.config();

const app = express();
app.use(express.static('public'));

const PORT = Number(process.env.PORT || 3000);
const PROJECT_ROOT = process.cwd();
const TARGETS_FILE = path.resolve(PROJECT_ROOT, 'data', 'targets.json');

function toSafeInt(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function toSafeFloat(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableHash(value) {
  return crypto.createHash('sha1').update(value || '').digest('hex');
}

function normalizeText(value) {
  if (!value) return '';
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

function textSnippet(value, max = 260) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function pickString(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function extractPrimaryText(item) {
  const direct = pickString(item, ['text', 'content', 'body', 'description', 'summary', 'snippet']);
  if (direct) return direct;

  const title = pickString(item, ['title', 'name', 'heading']);
  if (title) return title;

  return '';
}

function extractUrl(item) {
  return normalizeText(item.url || item.link || item.href || item.pageUrl || '');
}

function extractDate(item) {
  const candidates = ['publishedAt', 'published_at', 'date', 'createdAt', 'created_at', 'timestamp', 'pubDate'];
  for (const key of candidates) {
    const raw = item?.[key];
    if (!raw) continue;
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function tokenSet(text) {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function overlapScore(a, b) {
  if (!a || !b) return 0;
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;

  let inter = 0;
  left.forEach((t) => {
    if (right.has(t)) inter += 1;
  });
  const union = new Set([...left, ...right]).size;
  if (!union) return 0;
  return inter / union;
}

function estimateDays(afterIso, beforeIso) {
  const after = new Date(afterIso || 0).getTime();
  const before = new Date(beforeIso || 0).getTime();
  if (!Number.isFinite(after) || !Number.isFinite(before)) return null;
  return Math.max(0, Math.round((after - before) / 86_400_000));
}

function rumorAgeDays(rumorIso) {
  return estimateDays(new Date().toISOString(), rumorIso);
}

function reasonBadges(rumorText) {
  const text = normalizeText(rumorText).toLowerCase();
  const reasons = [];

  const urgencyPatterns = [
    { re: /\b(launch|launching|launched|shipping|ship|ships?)\b/i, label: 'Launch language detected' },
    { re: /\b(announce|announcement|announcing|tease|teasing|leak|rumor|beta|pilot|preview|alpha|private beta)\b/i, label: 'Early-stage announcement signal' },
    { re: /\b(today|tomorrow|this week|next week|coming soon|hours|minutes|days)\b/i, label: 'Near-term timing reference' },
  ];

  for (const pattern of urgencyPatterns) {
    if (pattern.re.test(text)) reasons.push(pattern.label);
  }

  if (reasons.length === 0) reasons.push('General rumor signal');
  return reasons;
}

function buildMatchSignals(rumorText, officialDoc, semanticScore, overlap, lagDays) {
  const reasons = [];
  const lexicalScore = toSafeFloat(overlap * 100, 0, 0, 100);
  const semanticBoost = toSafeFloat(semanticScore * 8, 0, 0, 100);

  if (lexicalScore > 65) reasons.push('Strong keyword overlap between rumor and official post');
  else if (lexicalScore > 40) reasons.push('Moderate keyword overlap found');
  else reasons.push('Low keyword overlap, mostly semantic match');

  if (lagDays === 0) reasons.push('Official signal appeared same day');
  else if (lagDays !== null && lagDays <= 3) reasons.push('Official signal appeared within 3 days');
  else if (lagDays !== null && lagDays <= 14) reasons.push('Official signal appeared within 2 weeks');

  if (officialDoc?.sourceName) reasons.push(`Official source: ${officialDoc.sourceName}`);

  return {
    lexical: Math.round(lexicalScore),
    semantic: Math.round(semanticBoost),
    lagDays,
    sourceType: officialDoc?.sourceType || 'official',
    sourceName: officialDoc?.sourceName || null,
    reasons,
  };
}

function summarizeSignals(signals, targetsCount, rumorDocsCount, officialDocsCount, matchThresholds) {
  return {
    scannedTargets: targetsCount,
    rumorDocs: rumorDocsCount,
    officialDocs: officialDocsCount,
    totalSignals: signals.length,
    confirmed: signals.filter((signal) => signal.status === 'confirmed').length,
    likely: signals.filter((signal) => signal.status === 'likely').length,
    watching: signals.filter((signal) => signal.status === 'watching').length,
    latestRumorAt: rumorDocsCount ? signals[0]?.rumorAt || null : null,
    configuredThresholds: matchThresholds,
  };
}

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_RUMOR_ACTOR_ID = process.env.APIFY_RUMOR_ACTOR_ID || '';
const APIFY_REALITY_ACTOR_ID = process.env.APIFY_REALITY_ACTOR_ID || '';
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS || 45000);
const APIFY_REQUEST_TIMEOUT_MS = Number(process.env.APIFY_REQUEST_TIMEOUT_MS || 180000);
const APIFY_MAX_RETRY = Number(process.env.APIFY_MAX_RETRY || 2);
const APIFY_MAX_POSTS_DEFAULT = Number(process.env.APIFY_MAX_POSTS_DEFAULT || 12);

const ES_URL = process.env.ELASTICSEARCH_URL || '';
const ES_KEY = process.env.ELASTICSEARCH_API_KEY || '';
const ES_INDEX = process.env.ELASTIC_INDEX || 'rumor-reality-radar';
const CONFIRM_THRESHOLD = toSafeInt(process.env.RUMOR_CONFIRM_THRESHOLD, 48, 30, 95);
const LIKELY_THRESHOLD = toSafeInt(process.env.RUMOR_LIKELY_THRESHOLD, Math.min(CONFIRM_THRESHOLD - 8, 55), 20, 90);
const ES_RRF_WINDOW_SIZE = toSafeInt(process.env.ES_RRF_WINDOW_SIZE, 20, 5, 200);
const ES_RRF_CONSTANT = toSafeInt(process.env.ES_RRF_CONSTANT, 60, 10, 200);
const ES_RRF_TOP = toSafeInt(process.env.ES_RRF_TOP, 5, 2, 20);

const missingEnv = [];
if (!APIFY_TOKEN) missingEnv.push('APIFY_TOKEN');
if (!APIFY_RUMOR_ACTOR_ID) missingEnv.push('APIFY_RUMOR_ACTOR_ID');
if (!APIFY_REALITY_ACTOR_ID) missingEnv.push('APIFY_REALITY_ACTOR_ID');
if (!ES_URL) missingEnv.push('ELASTICSEARCH_URL');
if (!ES_KEY) missingEnv.push('ELASTICSEARCH_API_KEY');

const es = ES_URL && ES_KEY
  ? new EsClient({
      node: ES_URL,
      auth: { apiKey: ES_KEY },
      requestTimeout: APIFY_REQUEST_TIMEOUT_MS,
    })
  : null;

const state = {
  lastRunAt: null,
  signals: [],
  raw: [],
  summary: {
    scannedTargets: 0,
    rumorDocs: 0,
    officialDocs: 0,
    totalSignals: 0,
    confirmed: 0,
    likely: 0,
    watching: 0,
    latestRumorAt: null,
    configuredThresholds: {
      confirm: CONFIRM_THRESHOLD,
      likely: LIKELY_THRESHOLD,
    },
  },
};

async function ensureIndex() {
  if (!es) return;
  const exists = await es.indices.exists({ index: ES_INDEX });
  if (exists === true || exists?.body === true) return;

  try {
    await es.indices.create({
      index: ES_INDEX,
      body: {
        mappings: {
          properties: {
            company: { type: 'keyword' },
            sourceType: { type: 'keyword' },
            sourceName: { type: 'keyword' },
            title: { type: 'text' },
            text: { type: 'text' },
            text_semantic: { type: 'semantic_text' },
            url: { type: 'keyword' },
            publishedAt: { type: 'date' },
            fingerprint: { type: 'keyword' },
            insertedAt: { type: 'date' },
            raw: { type: 'object', enabled: false },
          },
        },
      },
    });
  } catch (error) {
    const alreadyExists =
      error?.meta?.body?.error?.type === 'resource_already_exists_exception' ||
      /resource_already_exists_exception/.test(error?.message || '');
    if (!alreadyExists) throw error;
  }
}

async function persistDocuments(docs) {
  if (!docs.length || !es) return;
  await ensureIndex();

  const body = docs.flatMap((doc) => [
    { index: { _index: ES_INDEX, _id: doc.fingerprint } },
    {
      ...doc,
      insertedAt: new Date().toISOString(),
    },
  ]);

  await es.bulk({ refresh: true, body });
}

async function runActor(actorId, input) {
  if (!actorId || !APIFY_TOKEN) return [];

  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
  const request = {
    method: 'post',
    url,
    headers: {
      Authorization: `Bearer ${APIFY_TOKEN}`,
      'content-type': 'application/json',
    },
    params: { token: APIFY_TOKEN },
    timeout: APIFY_TIMEOUT_MS,
    data: input,
  };

  let attempts = 0;
  while (true) {
    try {
      const response = await axios(request);
      const payload = response?.data;
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.items)) return payload.items;
      if (payload?.data && Array.isArray(payload.data)) return payload.data;
      return [];
    } catch (error) {
      attempts += 1;
      const status = error?.response?.status;
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempts > APIFY_MAX_RETRY) {
        throw error;
      }

      const delay = Math.min(1000 * attempts * 2, 8000);
      await sleep(delay);
    }
  }
}

function normalizeItem(item, company, sourceType, sourceName) {
  const text = extractPrimaryText(item);
  const explicitTitle = pickString(item, ['title', 'name', 'heading']);
  const title = explicitTitle || (text ? `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` : 'Untitled');
  const url = extractUrl(item);
  const publishedAt = extractDate(item);
  const fingerprintSeed = `${company}|${sourceType}|${sourceName}|${url}|${title}|${normalizeText(text).slice(0, 80)}`;

  return {
    company,
    sourceType,
    sourceName: sourceName || company,
    title,
    text: text || title,
    text_semantic: text || title,
    url,
    publishedAt,
    fingerprint: stableHash(fingerprintSeed),
    raw: item,
  };
}

async function loadTargets() {
  const text = await fs.readFile(TARGETS_FILE, 'utf8');
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.targets) ? parsed.targets : [];
}

function withDefaultInput(input, urls, sourceType) {
  const explicitStartUrls = Object.prototype.hasOwnProperty.call(input, 'startUrls') ? input.startUrls : undefined;
  const withDefaults = { ...input };

  if (!Object.prototype.hasOwnProperty.call(withDefaults, 'max_posts') && sourceType === 'rumor') {
    withDefaults.max_posts = APIFY_MAX_POSTS_DEFAULT;
  }
  if (!Object.prototype.hasOwnProperty.call(withDefaults, 'maxPosts') && sourceType === 'official') {
    withDefaults.maxPosts = APIFY_MAX_POSTS_DEFAULT;
  }

  if (explicitStartUrls !== undefined) return withDefaults;
  if (!urls?.length) return withDefaults;

  return {
    ...withDefaults,
    startUrls: urls.map((item) => (typeof item === 'string' ? { url: item } : item)),
  };
}

function sanitizeTargets(targets) {
  return targets
    .map((target) => {
      const sourceName = target.sourceName || target.company;
      return {
        company: target.company,
        sourceName,
        rumorActorId: target.rumorActorId || APIFY_RUMOR_ACTOR_ID,
        officialActorId: target.officialActorId || APIFY_REALITY_ACTOR_ID,
        rumorSources: target.rumorSources || [],
        officialSources: target.officialSources || [],
        rumorInput: target.rumorInput || {},
        officialInput: target.officialInput || {},
      };
    })
    .filter((target) => target.company && target.rumorActorId && target.officialActorId);
}

async function collectByType(targets, sourceType) {
  const actorField = `${sourceType}ActorId`;
  const sourceField = `${sourceType}Sources`;
  const inputField = `${sourceType}Input`;

  const results = [];

  for (const target of targets) {
    const actorId = target[actorField];
    const input = withDefaultInput(target[inputField] || {}, target[sourceField] || [], sourceType);

    if (!actorId || !input || Object.keys(input).length === 0) continue;

    const items = await runActor(actorId, input);
    const normalized = items.map((item) => normalizeItem(item, target.company, sourceType, target.sourceName || target.company));

    for (const doc of normalized) {
      results.push(doc);
    }
  }

  return results;
}

async function findOfficialMatch(rumor, officialDocs) {
  if (!officialDocs.length && !es) {
    return {
      match: null,
      score: 0,
      reasons: ['No official corpus available locally or in Elasticsearch yet.'],
    };
  }

  if (es) {
    const filter = [{ term: { company: rumor.company } }, { term: { sourceType: 'official' } }];
    const result = await es.search({
      index: ES_INDEX,
      size: ES_RRF_TOP,
      retriever: {
        rrf: {
          retrievers: [
            {
              standard: {
                query: {
                  bool: {
                    filter,
                    should: [
                      { match: { title: { query: rumor.title, boost: 2 } } },
                      { match: { text: { query: rumor.text } } },
                    ],
                  },
                },
              },
            },
            {
              standard: {
                query: {
                  bool: {
                    filter,
                    must: [{ semantic: { field: 'text_semantic', query: rumor.text } }],
                  },
                },
              },
            },
          ],
          rank_window_size: ES_RRF_WINDOW_SIZE,
          rank_constant: ES_RRF_CONSTANT,
        },
      },
    });

    const hits = result?.hits?.hits || [];

    const rankedCandidates = hits
      .map((hit) => {
        const topDoc = hit._source || {};
        const overlap = overlapScore(rumor.text, topDoc.text || '');
        const lagDays = estimateDays(topDoc.publishedAt, rumor.publishedAt);
        const lagPenalty = lagDays === null ? 0 : lagDays <= 1 ? 12 : lagDays <= 3 ? 9 : lagDays <= 7 ? 6 : lagDays <= 14 ? 3 : 0;
        const semanticScore = toSafeFloat(hit._score, 0);

        const rawScore = 28 + semanticScore * 4.2 + overlap * 48 + lagPenalty;
        const score = clamp(Math.round(rawScore), 0, 99);
        const signals = buildMatchSignals(rumor.text, topDoc, semanticScore, overlap, lagDays);

        return {
          match: topDoc,
          overlap,
          lagDays,
          score,
          searchScore: semanticScore,
          signals,
        };
      })
      .filter((candidate) => candidate.score > 15)
      .sort((a, b) => b.score - a.score);

    const top = rankedCandidates[0];
    if (!top) {
      return {
        match: null,
        score: 0,
        reasons: ['No strong matching official posts were found above threshold.'],
      };
    }

    return {
      match: top.match,
      score: top.score,
      lagDays: top.lagDays,
      overlap: top.overlap,
      searchScore: top.searchScore,
      reasons: top.signals.reasons,
      matchSignals: top.signals,
    };
  }

  const candidate = officialDocs.find((doc) => doc.company === rumor.company) || null;
  if (!candidate) return { match: null, score: 0 };

  const overlap = overlapScore(rumor.text, candidate.text || '');
  const lagDays = estimateDays(candidate.publishedAt, rumor.publishedAt);
  const matchSignals = buildMatchSignals(rumor.text, candidate, 0, overlap, lagDays);
  return {
    match: candidate,
    score: clamp(Math.round(20 + overlap * 70), 10, 85),
    lagDays,
    overlap,
    reasons: matchSignals.reasons,
    matchSignals,
  };
}

function scoreRumor(rawScore, lagDays, rumorText, rumorAt) {
  let score = rawScore;
  const reasons = reasonBadges(rumorText);
  const rumorAge = rumorAgeDays(rumorAt);

  if (/\b(announce|announcing|shipping|launch|launching|teaser|reveal|release|beta|private beta|pilot)\b/i.test(rumorText)) {
    score += 9;
    if (!reasons.includes('Launch language detected')) reasons.push('Launch language detected');
  }

  if (/\b(today|tomorrow|this week|next week|this month|hours|minutes)\b/i.test(rumorText)) {
    score += 5;
    if (!reasons.includes('Near-term timing reference')) reasons.push('Near-term timing reference');
  }

  if (rumorAge !== null && rumorAge <= 2) {
    score += 4;
    reasons.push('Very recent rumor input');
  }

  if (lagDays !== null && lagDays <= 14) {
    score += lagDays === 0 ? 12 : lagDays <= 3 ? 10 : 6;
  }

  const confidence = clamp(Math.round(score), 12, 99);

  return {
    confidence,
    signalList: Array.from(new Set(reasons)).filter(Boolean),
    baseline: rawScore,
  };
}

app.get('/api/health', async (_req, res) => {
  let elasticHealthy = false;
  if (es) {
    try {
      await es.ping();
      elasticHealthy = true;
    } catch (_err) {
      elasticHealthy = false;
    }
  }

  res.json({
    ok: missingEnv.length === 0,
    missingEnv,
    elasticHealthy,
    index: ES_INDEX,
    thresholds: {
      confirm: CONFIRM_THRESHOLD,
      likely: LIKELY_THRESHOLD,
    },
  });
});

app.get('/api/latest', (_req, res) => {
  res.json({
    ok: missingEnv.length === 0,
    missingEnv,
    scannedAt: state.lastRunAt,
    signals: state.signals,
    raw: state.raw,
    summary: state.summary,
  });
});

app.post('/api/scan', async (_req, res) => {
  try {
    const targets = sanitizeTargets(await loadTargets());
    const rumorDocs = await collectByType(targets, 'rumor');
    const officialDocs = await collectByType(targets, 'official');
    const allDocs = [...rumorDocs, ...officialDocs];

    const sortedRaw = allDocs
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .filter((doc, index, list) => list.findIndex((x) => x.fingerprint === doc.fingerprint) === index);

    state.raw = sortedRaw;

    if (es) {
      await persistDocuments(allDocs);
    }

    const signals = [];
    for (const rumor of rumorDocs) {
      const matchResult = await findOfficialMatch(rumor, officialDocs);
      const match = matchResult?.match || null;
      const matchLagDays = matchResult?.lagDays;

      const scoreResult = scoreRumor(matchResult?.score || 0, matchLagDays, rumor.text, rumor.publishedAt);
      const confidence = scoreResult.confidence;

      let status = 'watching';
      if (match && confidence >= CONFIRM_THRESHOLD) status = 'confirmed';
      else if (match && confidence >= LIKELY_THRESHOLD) status = 'likely';

      signals.push({
        company: rumor.company,
        rumorAt: rumor.publishedAt,
        rumorTitle: rumor.title,
        rumorText: rumor.text,
        rumorSnippet: textSnippet(rumor.text, 190),
        rumorUrl: rumor.url,
        status,
        confidence,
        confidenceSignals: scoreResult.signalList,
        confirmLagDays: match ? estimateDays(match.publishedAt, rumor.publishedAt) : null,
        officialUrl: match?.url || null,
        officialTitle: match?.title || null,
        officialText: match?.text || null,
        officialSnippet: match?.text ? textSnippet(match.text, 260) : null,
        officialAt: match?.publishedAt || null,
        matchingReasons: matchResult?.reasons || [],
        matchSignals: matchResult?.matchSignals || null,
        matchSearchScore: matchResult?.searchScore || null,
      });
    }

    state.signals = signals
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 25);
    state.lastRunAt = new Date().toISOString();
    state.summary = summarizeSignals(state.signals, targets.length, rumorDocs.length, officialDocs.length, {
      confirm: CONFIRM_THRESHOLD,
      likely: LIKELY_THRESHOLD,
    });

    res.json({
      ok: true,
      scannedAt: state.lastRunAt,
      missingEnv,
      signals: state.signals,
      raw: state.raw.slice(0, 60),
      summary: state.summary,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      missingEnv,
      error: error?.response?.data || error.message || 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Rumor Radar live on http://localhost:${PORT}`);
});
