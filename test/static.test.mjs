/* Checks that need no server: the game's inline script parses, the deployment config is
   valid JSON, and the page still carries the things a deploy depends on. A syntax error in
   index.html is the one mistake that takes the whole game down at once. */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const results = [];
const check = (name, fn) => {
  try { const detail = fn(); results.push({ name, pass: true, detail }); }
  catch (e) { results.push({ name, pass: false, detail: e.message }); }
};

check("index.html inline script parses", () => {
  const start = html.indexOf("<script>") + "<script>".length;
  const end = html.lastIndexOf("</script>");
  if (start < 8 || end < 0) throw new Error("no inline script found");
  const src = html.slice(start, end);
  new vm.Script(src, { filename: "index.html" });   // throws on a syntax error, runs nothing
  return src.length + " chars";
});

check("vercel.json is valid JSON with a CSP", () => {
  const cfg = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
  const csp = cfg.headers.flatMap(h => h.headers).find(h => h.key === "Content-Security-Policy");
  if (!csp) throw new Error("no Content-Security-Policy header");
  for (const must of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
    if (!csp.value.includes(must)) throw new Error("CSP is missing " + must);
  }
  return "ok";
});

check("the game points at the scoreboard endpoint", () => {
  if (!html.includes('const SCORE_API="/api/scores"')) throw new Error("SCORE_API is not /api/scores");
  return "ok";
});

check("dev tooling is gated on a local host", () => {
  if (!/const LOCAL=\/\^\(localhost\|127/.test(html)) throw new Error("LOCAL host check not found");
  return "ok";
});

let failed = 0;
for (const t of results) {
  if (!t.pass) failed++;
  console.log((t.pass ? "  ok   " : "  FAIL ") + t.name + (t.pass ? "" : "   <- " + t.detail));
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
