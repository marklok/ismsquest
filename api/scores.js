/* Scoreboard for ISMS Quest.
 *
 * GET  /api/scores  -> the best runs, as a JSON array, newest ordering rules applied
 * POST /api/scores  -> one run, validated and stored
 *
 * Storage is an Upstash Redis sorted set, reached over its REST API so this file
 * needs no dependencies, no SDK and no build step. It needs a REST endpoint and a
 * token, under either of the two names the Vercel integration uses depending on how
 * the store was added:
 *
 *   UPSTASH_REDIS_REST_URL  or  KV_REST_API_URL
 *   UPSTASH_REDIS_REST_TOKEN  or  KV_REST_API_TOKEN
 *
 * Nothing here is a security boundary. Anyone can post to this endpoint with curl,
 * so the checks below exist to keep the board readable, not to prove a score was
 * earned. The ceiling, the initials pattern and the per-address limit between them
 * stop the board being flooded or defaced in an afternoon.
 *
 * The rate limiter keys its counters by an HMAC of the caller's address under
 * SCORE_SALT, so the stored identifier is pseudonymous rather than anonymous: it
 * cannot be reversed without the secret, but the same address always maps to the
 * same key while the secret stands. Counters live for an hour. SCORE_SALT is
 * required for POST; without it the function refuses to record rather than fall
 * back to a guessable default.
 */

import { createHmac } from "node:crypto";

const KEY = "ismsquest:scores";
const KEEP = 500;              // runs retained in Redis
const RETURN = 25;             // runs handed to the page
const POSTS_PER_HOUR = 20;     // a full run takes ten minutes or more
const WINDOW_SECONDS = 3600;
const UPSTREAM_TIMEOUT_MS = 5000;
const BOARD_CACHE = "public, s-maxage=5, stale-while-revalidate=30";   // the edge absorbs a burst of readers

/* Count and expire in one atomic step, and repair a counter that somehow has no expiry.
   Two separate commands could leave a counter that never expires if the second one
   failed, and an address would then be refused for good once it passed the limit. */
const COUNT_LUA =
  "local n = redis.call('INCR', KEYS[1]) " +
  "if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end " +
  "return n";

/* A real run tops out near 900 points. The ceilings are loose enough not to reject
   an honest score after the game grows, and tight enough to reject a fabricated one. */
const RANGES = {
  score: [-2000, 2000],
  time:  [0, 86400],
  stars: [0, 60],
  trust: [0, 100],
  risk:  [0, 100],
  pct:   [0, 100],
  max:   [0, 10000]
};
const REQUIRED = ["score", "time"];

/* Three letters is exactly enough to be rude in. Extend as needed. */
const BLOCKED = new Set([
  "ASS", "TIT", "FUC", "FUK", "FCK", "CUM", "CUN", "KNT", "SEX", "SHT", "DIC",
  "DIK", "COK", "PIS", "POO", "WAN", "TWA", "SLT", "HOE", "RAP", "NIG", "NGR",
  "FAG", "JEW", "KKK", "NAZ", "HTL", "ISS"
]);

async function redis(...command) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("no upstash REST url or token in the environment");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)   // a stalled store fails fast rather than holding the function open
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) throw new Error((body && body.error) || `upstash ${res.status}`);
  return body.result;
}

/* The caller's address is only ever stored as an HMAC under SCORE_SALT, in a counter that
   expires after an hour. Pseudonymous, not anonymous: see the note at the top. */
function callerKey(req) {
  const secret = process.env.SCORE_SALT;
  if (!secret) throw new Error("SCORE_SALT is not set; refusing to rate limit with a guessable key");
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return "ismsquest:rl:" + createHmac("sha256", secret).update(forwarded || "unknown").digest("hex").slice(0, 16);
}

function readBody(req) {
  if (!req.body) return null;
  if (typeof req.body !== "string") return req.body;
  try { return JSON.parse(req.body); } catch { return null; }
}

/* Returns a clean entry, or null if the submission is not worth storing.
   The date and the id are set here: a client is not asked to be honest about either. */
function validate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const ini = String(raw.ini || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(ini) || BLOCKED.has(ini)) return null;

  const entry = {
    ini,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    date: new Date().toISOString().slice(0, 10)
  };

  for (const [field, [low, high]] of Object.entries(RANGES)) {
    const value = Math.round(Number(raw[field]));
    if (!Number.isFinite(value)) {
      if (REQUIRED.includes(field)) return null;
      continue;
    }
    entry[field] = Math.min(high, Math.max(low, value));
  }
  return REQUIRED.every(f => f in entry) ? entry : null;
}

function parseEntry(text) {
  try {
    const entry = JSON.parse(text);
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const stored = await redis("ZRANGE", KEY, 0, RETURN - 1, "REV");
      const runs = (stored || []).map(parseEntry).filter(Boolean);
      runs.sort((a, b) => b.score - a.score || (a.time || 0) - (b.time || 0));
      res.setHeader("Cache-Control", BOARD_CACHE);
      return res.status(200).json(runs);
    }

    if (req.method === "POST") {
      const entry = validate(readBody(req));
      if (!entry) return res.status(400).json({ error: "that is not a run" });

      const posts = await redis("EVAL", COUNT_LUA, 1, callerKey(req), String(WINDOW_SECONDS));
      if (Number(posts) > POSTS_PER_HOUR) return res.status(429).json({ error: "too many runs from here this hour" });

      await redis("ZADD", KEY, entry.score, JSON.stringify(entry));
      await redis("ZREMRANGEBYRANK", KEY, 0, -(KEEP + 1));
      const better = await redis("ZCOUNT", KEY, "(" + entry.score, "+inf");
      return res.status(200).json({ ok: true, rank: Number(better) + 1 });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("scoreboard:", err && err.message);
    return res.status(500).json({ error: "scoreboard unavailable" });
  }
}
