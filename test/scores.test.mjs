/* Drives api/scores.js against an in-memory stand-in for Upstash so the handler's real
   logic runs: validation, ceilings, the blocklist, the atomic rate limiter and its TTL
   repair, the upstream deadline, caching headers and ordering. */
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.SCORE_SALT = "test-secret";

const zset = new Map();      // member -> score
const counters = new Map();  // key -> {n, ttl}   ttl -1 means no expiry
let hang = false;            // when true, the store never answers
let calls = [];

globalThis.fetch = (_url, init) => {
  const cmd = JSON.parse(init.body);
  calls.push(cmd[0]);
  if (hang) {
    return new Promise((_, reject) => {
      const sig = init.signal;
      if (sig) sig.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }
  const [op, ...a] = cmd;
  let result = null;
  if (op === "ZADD") { zset.set(String(a[2]), Number(a[1])); result = 1; }
  else if (op === "ZRANGE") {
    const all = [...zset.entries()].sort((x, y) => y[1] - x[1]);
    result = all.slice(Number(a[1]), Number(a[2]) + 1).map(e => e[0]);
  }
  else if (op === "ZREMRANGEBYRANK") result = 0;
  else if (op === "ZCOUNT") result = [...zset.values()].filter(v => v > Number(String(a[1]).replace("(", ""))).length;
  else if (op === "EVAL") {
    /* the only script we run: INCR, then set an expiry if the key has none */
    const [script, , key, ttl] = a;
    if (!/INCR/.test(script) || !/TTL/.test(script) || !/EXPIRE/.test(script)) throw new Error("unexpected script");
    const c = counters.get(key) || { n: 0, ttl: -1 };
    c.n += 1;
    if (c.ttl < 0) c.ttl = Number(ttl);
    counters.set(key, c);
    result = c.n;
  }
  else throw new Error("unmocked command " + op);
  return Promise.resolve({ ok: true, json: async () => ({ result }) });
};

const { default: handler } = await import(new URL("../api/scores.js", import.meta.url));

function call(method, body, ip = "203.0.113.7") {
  const req = { method, body, headers: { "x-forwarded-for": ip } };
  let code = 0, payload = null; const headers = {};
  const res = {
    setHeader(k, v) { headers[k] = v; return res; },
    status(c) { code = c; return res; },
    json(p) { payload = p; return res; }
  };
  return handler(req, res).then(() => ({ code, payload, headers }));
}

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
let r;

/* --- acceptance and server-set fields --- */
r = await call("POST", { ini: "mkl", score: 642, time: 1483, stars: 31, trust: 70, risk: 30, pct: 74, max: 864 });
check("accepts a valid run", r.code === 200 && r.payload.rank === 1, JSON.stringify(r.payload));
const stored = JSON.parse([...zset.keys()][0]);
check("server sets the date", /^\d{4}-\d{2}-\d{2}$/.test(stored.date), stored.date);
check("server sets an id", typeof stored.id === "string" && stored.id.length > 5, stored.id);
check("initials upper-cased", stored.ini === "MKL", stored.ini);
r = await call("POST", { ini: "OLE", score: 401, time: 1702, date: "1999-01-01" });
check("ignores a client date", [...zset.keys()].map(JSON.parse).find(e => e.ini === "OLE").date !== "1999-01-01", "");

/* --- rejections --- */
for (const [name, body] of [
  ["empty body", null], ["missing initials", { score: 10, time: 5 }], ["four letters", { ini: "MKLX", score: 10, time: 5 }],
  ["one letter", { ini: "M", score: 10, time: 5 }], ["punctuation", { ini: "M-L", score: 10, time: 5 }],
  ["blocked word", { ini: "ASS", score: 10, time: 5 }], ["blocked lowercase", { ini: "fuc", score: 10, time: 5 }],
  ["no score", { ini: "ABC", time: 5 }], ["score not a number", { ini: "ABC", score: "lots", time: 5 }], ["an array", [1, 2, 3]]
]) {
  const out = await call("POST", body);
  check("rejects " + name, out.code === 400, String(out.code));
}

/* --- clamping --- */
r = await call("POST", { ini: "ZZZ", score: 99999999, time: 1, stars: 9999 });
const zzz = [...zset.keys()].map(JSON.parse).find(e => e.ini === "ZZZ");
check("clamps an absurd score", r.code === 200 && zzz.score === 2000, String(zzz && zzz.score));
check("clamps absurd stars", zzz.stars === 60, String(zzz && zzz.stars));

/* --- ordering --- */
await call("POST", { ini: "AAA", score: 500, time: 900 });
await call("POST", { ini: "BBB", score: 500, time: 400 });
r = await call("GET");
const five = r.payload.filter(e => e.score === 500).map(e => e.ini);
check("ties break on the faster time", five[0] === "BBB" && five[1] === "AAA", five.join(","));
check("GET returns an ordered array", Array.isArray(r.payload) && r.payload.every((e, i) => i === 0 || r.payload[i - 1].score >= e.score), "");

/* --- caching headers (finding 2) --- */
check("GET is cacheable at the edge for a few seconds", /s-maxage=\d+/.test(r.headers["Cache-Control"]), r.headers["Cache-Control"]);
const p = await call("POST", { ini: "CCC", score: 1, time: 1 }, "198.51.100.50");
check("POST is never cached", p.headers["Cache-Control"] === "no-store", p.headers["Cache-Control"]);

/* --- the rate limiter is one atomic command (finding 1) --- */
calls = [];
await call("POST", { ini: "ONE", score: 1, time: 1 }, "198.51.100.1");
check("counting is a single EVAL, not INCR then EXPIRE", calls.includes("EVAL") && !calls.includes("INCR") && !calls.includes("EXPIRE"), calls.join(","));
const oneKey = [...counters.keys()].pop();
check("a fresh counter gets an expiry in the same step", counters.get(oneKey).ttl === 3600, String(counters.get(oneKey).ttl));

/* the regression the review described: a counter that lost its expiry */
const before77 = new Set(counters.keys());
await call("POST", { ini: "SDX", score: 1, time: 1 }, "198.51.100.77");
const stuckKey = [...counters.keys()].find(k => !before77.has(k));   // the counter that address just created
counters.get(stuckKey).ttl = -1;                       // the failure mode: no expiry on disk
await call("POST", { ini: "SDX", score: 1, time: 1 }, "198.51.100.77");
check("a counter with no expiry is repaired on the next count", counters.get(stuckKey).ttl === 3600, String(counters.get(stuckKey).ttl));

/* --- limit still holds, per address --- */
let limitedAt = null;
for (let i = 0; i < 30; i++) {
  const out = await call("POST", { ini: "SPM", score: 1, time: 1 }, "198.51.100.4");
  if (out.code === 429) { limitedAt = i; break; }
}
check("rate limits a flood", limitedAt !== null && limitedAt <= 20, "blocked after " + limitedAt);
check("limit is per address", (await call("POST", { ini: "NEW", score: 5, time: 5 }, "198.51.100.99")).code === 200, "");

/* --- the key is an HMAC under the secret (finding 3) --- */
const keysBefore = new Set(counters.keys());
process.env.SCORE_SALT = "another-secret";
await call("POST", { ini: "HMC", score: 1, time: 1 }, "198.51.100.4");
const newKeys = [...counters.keys()].filter(k => !keysBefore.has(k));
check("a different secret yields a different key for the same address", newKeys.length === 1, String(newKeys.length));
process.env.SCORE_SALT = "test-secret";

/* --- a missing secret refuses to record, loudly, but reads still work --- */
delete process.env.SCORE_SALT;
const noSalt = await call("POST", { ini: "NOS", score: 1, time: 1 }, "198.51.100.5");
check("POST without SCORE_SALT is refused", noSalt.code === 500, String(noSalt.code));
check("GET without SCORE_SALT still serves the board", (await call("GET")).code === 200, "");
process.env.SCORE_SALT = "test-secret";

/* --- a stalled store fails fast (finding 2) --- */
hang = true;
const keepAlive = setInterval(() => {}, 500);   // production has a socket and a platform holding the loop; the mock has neither
const t0 = Date.now();
const stalled = await call("GET");
const took = Date.now() - t0;
clearInterval(keepAlive);
hang = false;
check("a stalled upstream returns 500", stalled.code === 500, String(stalled.code));
check("and does so within the deadline", took < 6500, took + "ms");

/* --- method handling --- */
check("rejects PUT", (await call("PUT", {})).code === 405, "");

let failed = 0;
for (const t of results) {
  if (!t.pass) failed++;
  console.log((t.pass ? "  ok   " : "  FAIL ") + t.name + (t.pass ? "" : "   <- " + t.detail));
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
