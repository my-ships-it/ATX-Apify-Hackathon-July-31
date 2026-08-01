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
app.use(express.json());

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

function summarizeSignals(signals, targetsCount, rumorDocsCount, officialDocsCount, matchThresholds, previousSummary = null) {
  const current = {
    totalSignals: signals.length,
    confirmed: signals.filter((signal) => signal.status === 'confirmed').length,
    likely: signals.filter((signal) => signal.status === 'likely').length,
    watching: signals.filter((signal) => signal.status === 'watching').length,
  };

  return {
    scannedTargets: targetsCount,
    rumorDocs: rumorDocsCount,
    officialDocs: officialDocsCount,
    ...current,
    deltas: previousSummary
      ? {
          signals: current.totalSignals - (previousSummary.totalSignals || 0),
          confirmed: current.confirmed - (previousSummary.confirmed || 0),
          likely: current.likely - (previousSummary.likely || 0),
          watching: current.watching - (previousSummary.watching || 0),
          rumorDocs: rumorDocsCount - (previousSummary.rumorDocs || 0),
          officialDocs: officialDocsCount - (previousSummary.officialDocs || 0),
        }
      : null,
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
const APIFY_MAX_CHARGE_USD = Number(process.env.APIFY_MAX_CHARGE_USD || 0.25);
const APIFY_DEFAULT_MEMORY_MB = Number(process.env.APIFY_DEFAULT_MEMORY_MB || 512);
const APIFY_BLOG_MEMORY_MB = Number(process.env.APIFY_BLOG_MEMORY_MB || 2048);
const APIFY_BLOG_TIMEOUT_MS = Number(process.env.APIFY_BLOG_TIMEOUT_MS || 90000);

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

const sseClients = new Set();
let autoScanTimer = null;
let autoScanIntervalMs = 0;
let autoScanRunning = false;

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (error) {
      // A dead/closed browser tab shouldn't be able to crash the whole server mid-demo.
      sseClients.delete(client);
    }
  }
}

const state = {
  lastRunAt: null,
  signals: [],
  raw: [],
  lastRunSummary: null,
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

const PERCOLATOR_INDEX = `${ES_INDEX}-percolator`;

async function ensurePercolatorIndex() {
  if (!es) return;
  const exists = await es.indices.exists({ index: PERCOLATOR_INDEX });
  if (exists === true || exists?.body === true) return;

  try {
    await es.indices.create({
      index: PERCOLATOR_INDEX,
      body: {
        mappings: {
          properties: {
            query: { type: 'percolator' },
            company: { type: 'keyword' },
            text: { type: 'text' },
            rumorFingerprint: { type: 'keyword' },
            rumorTitle: { type: 'text' },
            rumorUrl: { type: 'keyword' },
            registeredAt: { type: 'date' },
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

// Registers each rumor as a STORED QUERY (Elasticsearch's percolator feature) instead of just
// searching forward from rumor -> official docs. This lets us ask the reverse question cheaply:
// "does this new official post satisfy any rumor we're already watching?" — the same mechanism
// production alerting systems (e.g. "notify me when a document matching X arrives") are built on.
async function registerRumorPercolatorQueries(rumorDocs) {
  if (!es || !rumorDocs.length) return;
  await ensurePercolatorIndex();

  const body = rumorDocs.flatMap((rumor) => [
    { index: { _index: PERCOLATOR_INDEX, _id: rumor.fingerprint } },
    {
      query: {
        bool: {
          filter: [{ term: { company: rumor.company } }],
          must: [{ match: { text: { query: rumor.text, minimum_should_match: '60%' } } }],
        },
      },
      company: rumor.company,
      rumorFingerprint: rumor.fingerprint,
      rumorTitle: rumor.title,
      rumorUrl: rumor.url,
      registeredAt: new Date().toISOString(),
    },
  ]);

  await es.bulk({ refresh: true, body });
}

// Reverse-search: for each freshly collected official doc, ask the percolator index which
// stored rumor queries it satisfies. Returns a map of rumorFingerprint -> matching official docs.
async function percolateOfficialDocs(officialDocs) {
  if (!es || !officialDocs.length) return new Map();
  await ensurePercolatorIndex();

  const matches = new Map();

  for (const doc of officialDocs.slice(0, 40)) {
    try {
      const result = await es.search({
        index: PERCOLATOR_INDEX,
        size: 10,
        query: {
          percolate: {
            field: 'query',
            document: { company: doc.company, text: doc.text },
          },
        },
      });
      const hits = result?.hits?.hits || [];
      for (const hit of hits) {
        const fingerprint = hit._source?.rumorFingerprint;
        if (!fingerprint) continue;
        if (!matches.has(fingerprint)) matches.set(fingerprint, []);
        matches.get(fingerprint).push({ url: doc.url, title: doc.title, sourceName: doc.sourceName });
      }
    } catch (error) {
      // Percolator is a bonus signal, not a hard dependency of the scan — skip failures quietly.
      console.error('[percolateOfficialDocs] failed:', error?.meta?.body?.error || error.message);
    }
  }

  return matches;
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

async function runActor(actorId, input, timeoutMsOverride = null, memoryMbOverride = null) {
  if (!actorId || !APIFY_TOKEN) return [];

  const clientTimeoutMs = timeoutMsOverride || APIFY_TIMEOUT_MS;
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
  const request = {
    method: 'post',
    url,
    headers: {
      Authorization: `Bearer ${APIFY_TOKEN}`,
      'content-type': 'application/json',
    },
    params: {
      token: APIFY_TOKEN,
      // Hard spend cap per actor call so a runaway scan can't burn through Apify credits.
      maxTotalChargeUsd: APIFY_MAX_CHARGE_USD,
      // Give the actor run itself close to the full HTTP window so slow crawls don't get killed mid-run.
      timeout: Math.max(10, Math.round(clientTimeoutMs / 1000) - 5),
      // Cap memory per run so a handful of concurrent scans can't exceed the account's total memory pool.
      memory: memoryMbOverride || APIFY_DEFAULT_MEMORY_MB,
    },
    timeout: clientTimeoutMs,
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
  const runtimeInput = input || {};
  const explicitStartUrls = Object.prototype.hasOwnProperty.call(runtimeInput, 'startUrls') ? runtimeInput.startUrls : undefined;
  const withDefaults = { ...runtimeInput };
  const runtimeRumorPosts = Number.parseInt(runtimeInput?.__hackathonRuntime?.rumorPosts, 10);
  const runtimeOfficialPosts = Number.parseInt(runtimeInput?.__hackathonRuntime?.officialPosts, 10);
  const runtimeMaxPosts = Number.parseInt(runtimeInput?.__hackathonRuntime?.maxPosts, 10);

  const rumorMaxPosts = Number.isFinite(runtimeRumorPosts)
    ? runtimeRumorPosts
    : Number.isFinite(runtimeMaxPosts)
      ? runtimeMaxPosts
      : null;
  const officialMaxPosts = Number.isFinite(runtimeOfficialPosts)
    ? runtimeOfficialPosts
    : Number.isFinite(runtimeMaxPosts)
      ? runtimeMaxPosts
      : null;

  delete withDefaults.__hackathonRuntime;

  if (!Object.prototype.hasOwnProperty.call(withDefaults, 'max_posts') && sourceType === 'rumor') {
    withDefaults.max_posts = APIFY_MAX_POSTS_DEFAULT;
  }
  if (!Object.prototype.hasOwnProperty.call(withDefaults, 'maxPosts') && sourceType === 'official') {
    withDefaults.maxPosts = APIFY_MAX_POSTS_DEFAULT;
  }

  if (sourceType === 'rumor' && rumorMaxPosts !== null) {
    withDefaults.max_posts = rumorMaxPosts;
  }
  if (sourceType === 'official' && officialMaxPosts !== null) {
    withDefaults.maxPosts = officialMaxPosts;
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
        officialBlogActorId: target.officialBlogActorId || '',
        officialBlogSources: target.officialBlogSources || [],
        officialBlogInput: target.officialBlogInput || {},
      };
    })
    .filter((target) => target.company && target.rumorActorId && target.officialActorId);
}

async function collectByType(targets, sourceType, runtimeInput = null) {
  const actorField = `${sourceType}ActorId`;
  const sourceField = `${sourceType}Sources`;
  const inputField = `${sourceType}Input`;

  // Companies are independent Apify actor calls — run them concurrently instead of sequentially.
  // With 3 source types x N companies this cuts wall-clock time roughly Nx, which matters because
  // a synchronous HTTP request behind a reverse proxy (e.g. Railway) will get killed (502) if the
  // whole scan takes several minutes end-to-end.
  const perTarget = await Promise.all(
    targets.map(async (target) => {
      const actorId = target[actorField];
      const targetInput = {
        ...(target[inputField] || {}),
        __hackathonRuntime: runtimeInput?.__hackathonRuntime || null,
      };
      const input = withDefaultInput(targetInput, target[sourceField] || [], sourceType);

      if (!actorId || !input || Object.keys(input).length === 0) return [];

      const timeoutOverride = sourceType === 'officialBlog' ? APIFY_BLOG_TIMEOUT_MS : null;
      const memoryOverride = sourceType === 'officialBlog' ? APIFY_BLOG_MEMORY_MB : APIFY_DEFAULT_MEMORY_MB;
      let items = [];
      try {
        items = await runActor(actorId, input, timeoutOverride, memoryOverride);
      } catch (error) {
        // A slow/unreachable blog crawl shouldn't sink the whole scan — log and continue with what we have.
        console.error(`[collectByType] ${sourceType} actor failed for ${target.company}:`, error?.response?.data || error.message);
        return [];
      }
      return items.map((item) => normalizeItem(item, target.company, sourceType, target.sourceName || target.company));
    }),
  );

  return perTarget.flat();
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
  const breakdown = {
    rawScore: clamp(Math.round(rawScore), 0, 99),
    urgencyBoost: 0,
    timingBoost: 0,
    freshnessBoost: 0,
    lagBoost: 0,
    confidence: 0,
  };

  if (/\b(announce|announcing|shipping|launch|launching|teaser|reveal|release|beta|private beta|pilot)\b/i.test(rumorText)) {
    const boost = 9;
    score += boost;
    breakdown.urgencyBoost += boost;
    if (!reasons.includes('Launch language detected')) reasons.push('Launch language detected');
  }

  if (/\b(today|tomorrow|this week|next week|this month|hours|minutes)\b/i.test(rumorText)) {
    const boost = 5;
    score += boost;
    breakdown.timingBoost += boost;
    if (!reasons.includes('Near-term timing reference')) reasons.push('Near-term timing reference');
  }

  if (rumorAge !== null && rumorAge <= 2) {
    const boost = 4;
    score += boost;
    breakdown.freshnessBoost += boost;
    reasons.push('Very recent rumor input');
  }

  if (lagDays !== null && lagDays <= 14) {
    const boost = lagDays === 0 ? 12 : lagDays <= 3 ? 10 : 6;
    score += boost;
    breakdown.lagBoost += boost;
  }

  const confidence = clamp(Math.round(score), 12, 99);
  breakdown.confidence = confidence;

  return {
    confidence,
    signalList: Array.from(new Set(reasons)).filter(Boolean),
    baseline: rawScore,
    breakdown,
  };
}

app.get('/api/esql', async (_req, res) => {
  if (!es) {
    return res.status(503).json({ ok: false, error: 'Elasticsearch is not configured.' });
  }

  // ES|QL: a distinct query surface from the DSL aggregations in /api/trends, using Elasticsearch's
  // pipe-based query language for a company leaderboard by rumor volume and average rumor text length.
  const query = [
    `FROM ${ES_INDEX}`,
    'WHERE sourceType == "rumor"',
    'EVAL text_len = LENGTH(text)',
    'STATS rumor_count = COUNT(*), avg_text_len = ROUND(AVG(text_len)) BY company',
    'SORT rumor_count DESC',
  ].join(' | ');

  try {
    const result = await es.transport.request({
      method: 'POST',
      path: '/_query',
      body: { query },
    });

    const columns = result?.columns || [];
    const values = result?.values || [];
    const rows = values.map((row) =>
      Object.fromEntries(row.map((value, index) => [columns[index]?.name || `col${index}`, value])),
    );

    res.json({ ok: true, query, columns: columns.map((c) => c.name), rows });
  } catch (error) {
    res.status(500).json({
      ok: false,
      query,
      error: error?.meta?.body?.error || error.message || 'ES|QL query failed',
    });
  }
});

app.get('/api/trends', async (_req, res) => {
  if (!es) {
    return res.status(503).json({ ok: false, error: 'Elasticsearch is not configured.' });
  }

  try {
    const result = await es.search({
      index: ES_INDEX,
      size: 0,
      aggs: {
        rumor_volume_by_day: {
          filter: { term: { sourceType: 'rumor' } },
          aggs: {
            by_day: {
              date_histogram: { field: 'publishedAt', calendar_interval: 'day', min_doc_count: 0 },
              aggs: {
                doc_count_metric: { value_count: { field: 'publishedAt' } },
              },
            },
            volume_trend: { change_point: { buckets_path: 'by_day>doc_count_metric' } },
          },
        },
        trending_rumor_terms: {
          filter: { term: { sourceType: 'rumor' } },
          aggs: {
            terms: {
              significant_text: {
                field: 'text',
                size: 12,
                filter_duplicate_text: true,
                exclude: ['https', 'http', 't.co', 'rt', 'we', 'our', 'us', 'i', 'you', 'the', 'a', 'an', 'and', 'to', 'of', 'in', 'is', 'it', 'this', 'that', 'are', 'be', 'on', 'for', 'with', 'can', "we're", "we've", "it's", "we’re", "we’ve", "it’s"],
                min_doc_count: 2,
              },
            },
          },
        },
        company_activity: {
          terms: { field: 'company', size: 20 },
          aggs: {
            rumor_count: { filter: { term: { sourceType: 'rumor' } } },
            official_count: { filter: { term: { sourceType: 'official' } } },
          },
        },
      },
    });

    const aggs = result?.aggregations || {};

    const volumeByDay = (aggs.rumor_volume_by_day?.by_day?.buckets || []).map((bucket) => ({
      day: bucket.key_as_string,
      count: bucket.doc_count,
    }));

    const changePoint = aggs.rumor_volume_by_day?.volume_trend?.type
      ? {
          type: Object.keys(aggs.rumor_volume_by_day.volume_trend.type)[0] || null,
          detail: aggs.rumor_volume_by_day.volume_trend.type[Object.keys(aggs.rumor_volume_by_day.volume_trend.type)[0]] || null,
          bucket: aggs.rumor_volume_by_day.volume_trend.bucket || null,
        }
      : null;

    const trendingTerms = (aggs.trending_rumor_terms?.terms?.buckets || []).map((bucket) => ({
      term: bucket.key,
      score: Math.round((bucket.score || 0) * 1000) / 1000,
      docCount: bucket.doc_count,
    }));

    const companyActivity = (aggs.company_activity?.buckets || []).map((bucket) => ({
      company: bucket.key,
      rumorCount: bucket.rumor_count?.doc_count || 0,
      officialCount: bucket.official_count?.doc_count || 0,
    })).sort((a, b) => b.rumorCount - a.rumorCount);

    res.json({
      ok: true,
      volumeByDay,
      changePoint,
      trendingTerms,
      companyActivity,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.meta?.body?.error || error.message || 'Failed to compute trends',
    });
  }
});

// Interactive percolator demo: paste any headline/announcement text and ask Elasticsearch, live,
// which currently-tracked rumors it would confirm — the reverse-search direction, exposed directly
// so it can be demoed as its own thing rather than only as an invisible step inside a full scan.
app.post('/api/percolate-test', async (req, res) => {
  if (!es) {
    return res.status(503).json({ ok: false, error: 'Elasticsearch is not configured.' });
  }

  const body = req.body || {};
  const text = String(body.text || '').trim();
  const company = String(body.company || '').trim();

  if (!text) {
    return res.status(400).json({ ok: false, error: 'Provide "text" (and optionally "company") to test against tracked rumors.' });
  }

  try {
    await ensurePercolatorIndex();
    const query = {
      percolate: {
        field: 'query',
        document: { company: company || undefined, text },
      },
    };
    if (!company) delete query.percolate.document.company;

    const result = await es.search({ index: PERCOLATOR_INDEX, size: 10, query });
    const hits = (result?.hits?.hits || []).map((hit) => ({
      rumorTitle: hit._source?.rumorTitle || null,
      rumorUrl: hit._source?.rumorUrl || null,
      company: hit._source?.company || null,
      score: hit._score || null,
    }));

    res.json({ ok: true, text, company: company || null, matchedRumors: hits, matchCount: hits.length });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.meta?.body?.error || error.message || 'Percolate test failed',
    });
  }
});

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

function signalKey(signal) {
  return `${signal.company}|${signal.rumorUrl || signal.rumorTitle}`;
}

const STATUS_RANK = { watching: 0, likely: 1, confirmed: 2 };

function detectStatusFlips(previousSignals, nextSignals) {
  const previousByKey = new Map((previousSignals || []).map((s) => [signalKey(s), s]));
  const flips = [];

  for (const signal of nextSignals) {
    const prev = previousByKey.get(signalKey(signal));
    const prevRank = prev ? STATUS_RANK[prev.status] ?? 0 : -1;
    const nextRank = STATUS_RANK[signal.status] ?? 0;
    if (nextRank > prevRank && (signal.status === 'confirmed' || signal.status === 'likely')) {
      flips.push({
        company: signal.company,
        status: signal.status,
        previousStatus: prev ? prev.status : 'new',
        confidence: signal.confidence,
        rumorTitle: signal.rumorTitle,
        rumorUrl: signal.rumorUrl,
        officialUrl: signal.officialUrl,
        officialTitle: signal.officialTitle,
      });
    }
  }

  return flips;
}

let scanInProgress = false;

async function performScan(options = {}) {
  if (scanInProgress) {
    throw new Error('A scan is already running — please wait for it to finish before starting another.');
  }
  scanInProgress = true;
  try {
    return await performScanInner(options);
  } finally {
    scanInProgress = false;
  }
}

async function performScanInner(options = {}) {
  const confirmThreshold = clamp(Math.max(toSafeInt(options.confirm, CONFIRM_THRESHOLD, 30, 95), 35), 30, 95);
  const likelyThreshold = clamp(Math.min(toSafeInt(options.likely, LIKELY_THRESHOLD, 20, 90), confirmThreshold - 5), 20, 90);
  const maxSignals = toSafeInt(options.maxSignals, 25, 1, 100);
  const rumorPosts = toSafeInt(options.rumorPosts, APIFY_MAX_POSTS_DEFAULT, 3, 80);
  const officialPosts = toSafeInt(options.officialPosts, APIFY_MAX_POSTS_DEFAULT, 3, 120);

  {
    const runtimeInputs = {
      __hackathonRuntime: {
        rumorPosts,
        officialPosts,
      },
    };

    const targets = sanitizeTargets(await loadTargets());
    // The three source types are independent of each other too — collect them concurrently.
    const [rumorDocs, officialSocialDocs, officialBlogDocsRaw] = await Promise.all([
      collectByType(targets, 'rumor', runtimeInputs),
      collectByType(targets, 'official', runtimeInputs),
      collectByType(targets, 'officialBlog', runtimeInputs),
    ]);
    // Official company blog posts are a much stronger "reality" signal than a random LinkedIn post,
    // so they're folded into the same official corpus (tagged with their own sourceName) rather than
    // treated as a separate bucket.
    const officialBlogDocs = officialBlogDocsRaw.map((doc) => ({
      ...doc,
      sourceType: 'official',
      sourceName: `${doc.company} Blog`,
    }));
    const officialDocs = [...officialSocialDocs, ...officialBlogDocs];
    const allDocs = [...rumorDocs, ...officialDocs];

    const sortedRaw = allDocs
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .filter((doc, index, list) => list.findIndex((x) => x.fingerprint === doc.fingerprint) === index);

    state.raw = sortedRaw;

    if (es) {
      await persistDocuments(allDocs);
    }

    let percolatorMatches = new Map();
    if (es) {
      // Register this run's rumors as stored percolator queries, then ask (in reverse) which of
      // them the freshly collected official docs already satisfy — independent of the forward
      // RRF search below, as a cross-check signal.
      await registerRumorPercolatorQueries(rumorDocs);
      percolatorMatches = await percolateOfficialDocs(officialDocs);
    }

    const scoredSignals = [];
    for (const rumor of rumorDocs) {
      const matchResult = await findOfficialMatch(rumor, officialDocs);
      const match = matchResult?.match || null;
      const matchLagDays = matchResult?.lagDays;
      const percolatorHits = percolatorMatches.get(rumor.fingerprint) || [];

      const scoreResult = scoreRumor(matchResult?.score || 0, matchLagDays, rumor.text, rumor.publishedAt);
      let confidence = scoreResult.confidence;
      if (percolatorHits.length) {
        confidence = clamp(confidence + 6, 12, 99);
        scoreResult.signalList.push('Confirmed independently by Elasticsearch percolator reverse-match');
      }

      let status = 'watching';
      if (match && confidence >= confirmThreshold) status = 'confirmed';
      else if (match && confidence >= likelyThreshold) status = 'likely';

      scoredSignals.push({
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
        scoreBreakdown: scoreResult.breakdown || null,
        percolatorConfirmed: percolatorHits.length > 0,
        percolatorHits: percolatorHits.slice(0, 3),
      });
    }

    const currentSummary = summarizeSignals(scoredSignals, targets.length, rumorDocs.length, officialDocs.length, {
      confirm: confirmThreshold,
      likely: likelyThreshold,
    }, state.lastRunSummary);

    const previousSignals = state.signals;
    const nextSignals = scoredSignals
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxSignals);
    const flips = detectStatusFlips(previousSignals, nextSignals);

    state.signals = nextSignals;
    state.lastRunAt = new Date().toISOString();
    state.lastRunSummary = {
      ...state.summary,
      deltas: null,
    };
    state.summary = currentSummary;

    state.summary.config = {
      confirm: confirmThreshold,
      likely: likelyThreshold,
      rumorPosts,
      officialPosts,
      maxSignals,
    };
    state.summary.configuredThresholds = {
      confirm: confirmThreshold,
      likely: likelyThreshold,
    };

    const payload = {
      ok: true,
      scannedAt: state.lastRunAt,
      missingEnv,
      signals: state.signals,
      raw: state.raw.slice(0, 60),
      summary: state.summary,
    };

    broadcastEvent('scan-complete', { scannedAt: state.lastRunAt, summary: state.summary });
    flips.forEach((flip) => broadcastEvent('alert', flip));

    return payload;
  }
}

app.post('/api/scan', async (_req, res) => {
  try {
    const body = _req.body || {};
    const options = {
      confirm: body.confirm ?? _req.query.confirm,
      likely: body.likely ?? _req.query.likely,
      maxSignals: body.maxSignals ?? _req.query.maxSignals,
      rumorPosts: body.rumorPosts ?? body.maxPosts ?? _req.query.rumorPosts ?? _req.query.maxPosts,
      officialPosts: body.officialPosts ?? body.maxPosts ?? _req.query.officialPosts ?? _req.query.maxPosts,
    };
    const payload = await performScan(options);
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      ok: false,
      missingEnv,
      error: error?.response?.data || error.message || 'Unknown error',
    });
  }
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ autoScanEnabled: Boolean(autoScanTimer), autoScanIntervalMs })}\n\n`);

  sseClients.add(res);
  res.on('error', () => sseClients.delete(res));
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/api/autoscan', async (req, res) => {
  const body = req.body || {};
  const enabled = Boolean(body.enabled);
  const intervalMs = clamp(toSafeInt(body.intervalMs, 120000, 30000, 3_600_000), 30000, 3_600_000);

  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }

  if (enabled) {
    autoScanIntervalMs = intervalMs;
    autoScanTimer = setInterval(async () => {
      if (autoScanRunning) return;
      autoScanRunning = true;
      try {
        await performScan(state.summary?.config || {});
      } catch (error) {
        broadcastEvent('scan-error', { error: error?.response?.data || error.message || 'Auto-scan failed' });
      } finally {
        autoScanRunning = false;
      }
    }, intervalMs);
  } else {
    autoScanIntervalMs = 0;
  }

  broadcastEvent('autoscan-status', { enabled, intervalMs: enabled ? intervalMs : 0 });
  res.json({ ok: true, enabled, intervalMs: enabled ? intervalMs : 0 });
});

app.listen(PORT, () => {
  console.log(`Rumor Radar live on http://localhost:${PORT}`);
});
