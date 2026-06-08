// Build data/books.json for Geo's reading list.
// Source: data/source.xlsx (preferred, from OneDrive) or data/source.csv (fallback).
// Enriches via OpenLibrary (keyless). Resumable: only NEW books hit the network.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as XLSX from "xlsx";

const OUT = new URL("./data/books.json", import.meta.url);
const XLSXP = new URL("./data/source.xlsx", import.meta.url);
const CSVP = new URL("./data/source.csv", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
const cleanAuthor = (s) => clean((s || "").split(/\s{2,}/)[0].replace(/\(.*?\)/g, "")).replace(/^&\s*/, "");
const searchTitle = (t) => clean(String(t)
  .replace(/\bVol\.?\s*#?\s*\d+\b/gi, "")          // volume markers
  .replace(/\(.*?\)/g, "")                          // parentheticals
  .replace(/\b\d{4}\s*[\/-]\s*\d{2,4}\b/g, " ")     // date ranges: 1939/45, 1939-1945
  .replace(/[''`]/g, "")                            // apostrophes (Churchill's -> Churchills, matches OL)
  .replace(/[\/,:;?!.]+/g, " "));                   // separators

const FAV_RE = /excellent|excellant|excllent|excellan|finest|the ?best|powerful|wonderful|exceptional|extraordinar|incredible|incredable|fascinating|brilliant|outstanding|epic|delightful|inspiring/i;

const THEMES = [
  ["Presidents", /president|white house|jefferson|adams|madison|monroe|jackson|lincoln|roosevelt|truman|eisenhow|kennedy|jfk|lbj|johnson|nixon|ford|carter|reagan|bush|clinton|obama|trump|franklin pierce|polk|hayes|cleveland|mckinley|harrison|van buren|garfield|buchanan|tyler|fillmore|taft|harding|coolidge|cooledge|hoover|wilson|grant/i],
  ["Civil War", /civil war|confedera|lincoln|lee|sherman|grant|gettysburg|appomattox|shiloh|sumter|secession|abolition|slavery|reconstruction|stonewall|longstreet|calhoun|sumner/i],
  ["WWII", /ww ?11|ww ?ii|wwii|world war ?(ii|2)|1939|1940|1941|1942|1943|1944|1945|pacific|normandy|iwo jima|guadalcanal|midway|patton|eisenhow|churchill|blitz|d.?day|nazi|natzi|u-?boat|holocaust|halsey|nimitz|macarthur/i],
  ["Revolution", /revolution|1776|founding|washington|franklin|hamilton|lafayette|continental|patriot|bunker hill|yorktown|valley forge|adams/i],
  ["Naval & Maritime", /navy|naval|sea|ship|frigate|whal|sail|harbor|hurricane|nelson|trafalgar|lobster|cape horn|coast guard|destroyer|fleet|cruise|cook/i],
  ["Biography", /life|memoir|letters|portrait|story of|his life|reconsidered/i],
];
const deriveThemes = (title, note) => THEMES.filter(([, re]) => re.test(`${title} ${note}`)).map(([n]) => n);

// ---- source readers ----
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function fmtDate(v) {
  if (v instanceof Date && !isNaN(v)) {
    const z = (n) => String(n).padStart(2, "0");
    return `${v.getUTCFullYear()}-${z(v.getUTCMonth() + 1)}-${z(v.getUTCDate())}`;
  }
  const s = clean(v);
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s) || /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (!m) return s;
  if (m[0].includes("/")) return `${m[3]}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;
  return m[0];
}
const yearOf = (date, fallback) => (/^(\d{4})/.exec(date)?.[1]) || clean(fallback);

// Map a header row -> column indexes, tolerant of layout (xlsx has no Year col; csv does).
function indexCols(header) {
  const find = (...names) => header.findIndex((h) => names.some((n) => clean(h).toLowerCase() === n));
  return { date: find("date"), year: find("year"), title: find("title"), author: find("author"), note: find("comments", "comment", "notes", "note") };
}

function loadRows() {
  let matrix;
  if (existsSync(XLSXP)) {
    const wb = XLSX.read(readFileSync(XLSXP), { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    console.log("source: data/source.xlsx");
  } else if (existsSync(CSVP)) {
    matrix = parseCSV(readFileSync(CSVP, "utf8"));
    console.log("source: data/source.csv");
  } else throw new Error("no source.xlsx or source.csv in data/");

  // find the header row (the one containing "Title")
  const hi = matrix.findIndex((r) => r.some((c) => clean(c).toLowerCase() === "title"));
  if (hi < 0) throw new Error("could not find a header row with a Title column");
  const cols = indexCols(matrix[hi]);
  const out = [];
  for (let i = hi + 1; i < matrix.length; i++) {
    const r = matrix[i];
    const title = clean(r[cols.title]);
    if (!title) continue;
    const date = fmtDate(r[cols.date]);
    const note = clean(r[cols.note]);
    out.push({
      date,
      yearRead: yearOf(date, cols.year >= 0 ? r[cols.year] : ""),
      title,
      author: clean(r[cols.author]),
      note,
      favorite: FAV_RE.test(note),
      themes: deriveThemes(title, note),
    });
  }
  return out;
}

// ---- OpenLibrary enrichment ----
async function getJSON(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "GeoReadingList/1.0 (personal project)" } });
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * (a + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(1000 * (a + 1)); }
  }
  return null;
}
const descText = (d) => (!d ? "" : typeof d === "string" ? d : typeof d.value === "string" ? d.value : "");
const tidy = (s) => clean(s).replace(/\(\[source\]\[\d+\]\)/gi, "").replace(/\[\d+\]:.*$/g, "").replace(/----.*$/g, "").trim();

// ---- Google Books fallback (build-time only; key stays server-side) ----
const GBKEY = process.env.GOOGLE_BOOKS_KEY || "";
const gbCover = (v) => { const l = v.imageLinks || {}; const u = l.thumbnail || l.smallThumbnail; return u ? u.replace(/^http:/, "https:").replace(/&edge=curl/, "") : ""; };

async function gbLookup(title, author) {
  if (!GBKEY) return [];
  for (const q of [`intitle:${title} inauthor:${author}`, `${title} ${author}`.trim()]) {
    const j = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&key=${GBKEY}`);
    if (j?.items?.length) return j.items;
    await sleep(120);
  }
  return [];
}
function gbPick(items, srcTokens, stLower) {
  let best = null, bestScore = -1, bestAuth = false;
  for (const it of items) {
    const v = it.volumeInfo || {};
    const names = (v.authors || []).join(" ").toLowerCase();
    const authMatch = srcTokens.length > 0 && fuzzyAuthorMatch(srcTokens, names);
    let s = 0; if (authMatch) s += 10; if (v.imageLinks) s += 3;
    const dt = (v.title || "").toLowerCase();
    if (dt === stLower) s += 2; else if (dt.includes(stLower) || stLower.includes(dt)) s += 1;
    if (s > bestScore) { best = v; bestScore = s; bestAuth = authMatch; }
  }
  return best ? { v: best, authMatch: bestAuth } : null;
}
// Fill cover/synopsis/year gaps from Google Books; confirm author when possible.
async function gbFill(rec, st, au, srcTokens, stLower) {
  if (!GBKEY || (rec.cover && rec.synopsis)) return rec;
  const pick = gbPick(await gbLookup(st, au), srcTokens, stLower);
  if (!pick) return rec;
  if (!rec.cover) { const c = gbCover(pick.v); if (c) { rec.cover = c; rec.coverSource = "gb"; } }
  if (!rec.synopsis && pick.v.description) rec.synopsis = tidy(pick.v.description).slice(0, 800);
  if (!rec.pubYear && pick.v.publishedDate) rec.pubYear = parseInt(String(pick.v.publishedDate).slice(0, 4)) || null;
  if (rec.unverified && pick.authMatch && rec.cover) rec.unverified = false; // GB confirmed the author
  return rec;
}

const FIELDS = "key,cover_i,first_publish_year,first_sentence,author_name,title";
// surname-ish tokens from an author string, for match scoring
const authorTokens = (a) => clean(a).toLowerCase().replace(/[.,&]/g, " ").split(/\s+/).filter((t) => t.length >= 4);

// Levenshtein distance (small strings) — tolerates spelling drift like Asbury/Ashbury.
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// Fuzzy: a source token matches an OL author token by equality, prefix, or edit-distance ≤1.
function fuzzyAuthorMatch(srcTokens, names) {
  const nameToks = names.toLowerCase().replace(/[.,&]/g, " ").split(/\s+/).filter((t) => t.length >= 4);
  return srcTokens.some((s) => nameToks.some((n) =>
    n === s || n.startsWith(s) || s.startsWith(n) || (Math.max(s.length, n.length) >= 5 && lev(s, n) <= 1)));
}

function scoreDoc(doc, srcTokens, stLower) {
  const names = (doc.author_name || []).join(" ").toLowerCase();
  const authMatch = srcTokens.length > 0 && fuzzyAuthorMatch(srcTokens, names);
  let s = 0;
  if (authMatch) s += 10;
  if (doc.cover_i) s += 3;
  const dt = clean(doc.title || "").toLowerCase();
  if (dt === stLower) s += 2; else if (dt.includes(stLower) || stLower.includes(dt)) s += 1;
  return { s, authMatch };
}

// Pull synopsis/firstSentence/cover from a chosen OL doc; shape the final record.
async function recordFromDoc(b, doc, { unverified }) {
  let synopsis = "";
  const fs = Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence;
  if (doc.key) { const w = await getJSON(`https://openlibrary.org${doc.key}.json`); synopsis = tidy(descText(w?.description)); await sleep(120); }
  return {
    ...b,
    cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : "",
    pubYear: doc.first_publish_year || null,
    synopsis,
    firstSentence: clean(fs || ""),
    olKey: doc.key || "",
    unverified: !!unverified,
  };
}

// Manual override: pin a specific OL work key (from the "Wrong book!" picker).
async function recordFromOverride(b, ov) {
  if (ov.olKey) {
    const j = await getJSON(`https://openlibrary.org/search.json?q=key:${encodeURIComponent(ov.olKey.replace("/works/", ""))}&fields=${FIELDS}`);
    const doc = j?.docs?.[0] || { key: ov.olKey, cover_i: ov.coverId, title: b.title };
    const rec = await recordFromDoc({ ...b, author: ov.author || b.author }, doc, { unverified: false });
    rec.overridden = true;
    if (ov.coverUrl) rec.cover = ov.coverUrl;
    else if (ov.coverId) rec.cover = `https://covers.openlibrary.org/b/id/${ov.coverId}-L.jpg`;
    return rec;
  }
  // override with no work key — a forced cover (pasted URL or id) and/or manual synopsis
  const cover = ov.coverUrl || (ov.coverId ? `https://covers.openlibrary.org/b/id/${ov.coverId}-L.jpg` : "");
  return { ...b, cover, pubYear: null, synopsis: ov.synopsis || "", firstSentence: "", olKey: "", unverified: false, overridden: true };
}

async function enrichOne(b) {
  const st = searchTitle(b.title), au = cleanAuthor(b.author);
  const stLower = st.toLowerCase();
  const srcTokens = authorTokens(au);
  const pool = new Map();
  const queries = [
    `title=${encodeURIComponent(st)}&author=${encodeURIComponent(au)}`,
    `title=${encodeURIComponent(st)}`,
    `q=${encodeURIComponent(`${st} ${au}`.trim())}`,   // loose general search — catches field-structure misses
  ];
  for (const q of queries) {
    const j = await getJSON(`https://openlibrary.org/search.json?${q}&limit=5&fields=${FIELDS}`);
    for (const d of j?.docs || []) if (d.key && !pool.has(d.key)) pool.set(d.key, d);
    // stop early once we have a confident author match WITH a cover
    if ([...pool.values()].some((d) => scoreDoc(d, srcTokens, stLower).authMatch && d.cover_i)) break;
    await sleep(180);
  }
  if (!pool.size) {
    const empty = { ...b, cover: "", pubYear: null, synopsis: "", firstSentence: "", olKey: "", unverified: true };
    return gbFill(empty, st, au, srcTokens, stLower);
  }
  let best = null, bestScore = -1, bestAuth = false;
  for (const d of pool.values()) {
    const { s, authMatch } = scoreDoc(d, srcTokens, stLower);
    if (s > bestScore) { best = d; bestScore = s; bestAuth = authMatch; }
  }
  // Unverified when we couldn't confirm the author (and the source actually had an author to match).
  const unverified = !bestAuth && srcTokens.length > 0;
  const rec = await recordFromDoc(b, best, { unverified });
  return gbFill(rec, st, au, srcTokens, stLower);
}

// ---- main ----
const OVP = new URL("./data/overrides.json", import.meta.url);
const FORCE = process.env.FORCE === "1";

const books = loadRows();
const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
const cache = new Map(existing.map((b) => [`${b.title}|${b.date}`, b]));
const overrides = existsSync(OVP) ? JSON.parse(readFileSync(OVP, "utf8")) : {};
const ovCount = Object.keys(overrides).length;
console.log(`${books.length} rows · cache:${existing.length} · overrides:${ovCount}${FORCE ? " · FORCE" : ""}`);

const keep = (hit, b) => ({ ...hit, ...b, cover: hit.cover, pubYear: hit.pubYear, synopsis: hit.synopsis, firstSentence: hit.firstSentence, olKey: hit.olKey, unverified: hit.unverified, overridden: hit.overridden });

let fresh = 0;
const result = [];
for (const b of books) {
  const key = `${b.title}|${b.date}`;
  const hit = cache.get(key);
  const ov = overrides[key];

  if (ov) {
    // manual correction always wins; reuse cache if it already reflects this override
    if (!FORCE && hit?.overridden && hit.olKey === (ov.olKey || hit.olKey)) { result.push(keep(hit, b)); continue; }
    result.push(await recordFromOverride(b, ov)); fresh++;
  } else if (!FORCE && hit && hit.cover !== undefined && hit.unverified !== undefined) {
    result.push(keep(hit, b)); continue; // fully-cached by the current matcher
  } else {
    result.push(await enrichOne(b)); fresh++;
  }
  if (fresh % 10 === 0) { console.log(`  processed ${fresh} new…`); writeFileSync(OUT, JSON.stringify(reindex(result), null, 2)); }
  await sleep(120);
}
function reindex(arr) { return arr.map((b, i) => ({ id: i, ...b })); }
const final = reindex(result);
writeFileSync(OUT, JSON.stringify(final, null, 2));
console.log(`DONE ${final.length} books (${fresh} newly enriched) — covers:${final.filter(b=>b.cover).length} synopses:${final.filter(b=>b.synopsis).length} favorites:${final.filter(b=>b.favorite).length}`);
