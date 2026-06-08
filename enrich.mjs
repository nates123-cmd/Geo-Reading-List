// Enrich Geo's reading list from OpenLibrary (keyless).
// Reads data/source.csv -> writes data/books.json. Resumable: re-run to fill gaps.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SRC = new URL("./data/source.csv", import.meta.url);
const OUT = new URL("./data/books.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tiny CSV parser (handles quoted fields, embedded commas, "" escapes) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
// Authors sometimes have notes glued on after a run of spaces; cut at first 2+ space gap.
const cleanAuthor = (s) => {
  let a = (s || "").split(/\s{2,}/)[0];
  a = a.replace(/\(.*?\)/g, "");          // drop "(Taft'53)" etc
  return clean(a).replace(/^&\s*/, "");
};
// Strip parenthetical / trailing-volume noise from title for searching.
const searchTitle = (t) =>
  clean(t.replace(/\bVol\.?\s*#?\s*\d+\b/gi, "").replace(/\(.*?\)/g, "").replace(/[?!]+/g, " "));

const FAV_RE = /excellent|excellant|excllent|excellan|finest|the ?best|powerful|wonderful|exceptional|extraordinar|incredible|incredable|fascinating|brilliant|outstanding|epic|delightful|inspiring|finest excellence/i;

const THEMES = [
  ["Presidents", /president|white house|jefferson|adams|madison|monroe|jackson|lincoln|roosevelt|truman|eisenhow|kennedy|jfk|lbj|johnson|nixon|ford|carter|reagan|bush|clinton|obama|trump|franklin pierce|polk|hayes|cleveland|mckinley|harrison|van buren|garfield|buchanan|tyler|fillmore|taft|harding|coolidge|cooledge|hoover|wilson|grant/i],
  ["Civil War", /civil war|confedera|lincoln|lee|sherman|grant|gettysburg|appomattox|shiloh|sumter|secession|abolition|slavery|reconstruction|stonewall|longstreet|calhoun|sumner/i],
  ["WWII", /ww ?11|ww ?ii|wwii|world war ?(ii|2)|1939|1940|1941|1942|1943|1944|1945|pacific|normandy|iwo jima|guadalcanal|midway|patton|eisenhow|churchill|blitz|d.?day|nazi|natzi|u-?boat|holocaust|halsey|nimitz|macarthur/i],
  ["Revolution", /revolution|1776|founding|washington|franklin|hamilton|lafayette|continental|patriot|bunker hill|yorktown|valley forge|adams/i],
  ["Naval & Maritime", /navy|naval|sea|ship|frigate|whal|sail|harbor|hurricane|nelson|trafalgar|lobster|cape horn|coast guard|destroyer|fleet|cruise|cook/i],
  ["Biography", /life|memoir|letters|portrait|story of|his life|reconsidered/i],
];

function deriveThemes(title, note) {
  const hay = `${title} ${note}`;
  return THEMES.filter(([, re]) => re.test(hay)).map(([name]) => name);
}

async function getJSON(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "GeoReadingList/1.0 (personal project)" } });
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(1000 * (attempt + 1)); }
  }
  return null;
}

function descText(d) {
  if (!d) return "";
  if (typeof d === "string") return d;
  if (typeof d.value === "string") return d.value;
  return "";
}
// OL descriptions sometimes carry trailing source citations / markdown links; tidy a bit.
const tidy = (s) =>
  clean(s).replace(/\(\[source\]\[\d+\]\)/gi, "").replace(/\[\d+\]:.*$/g, "").replace(/----.*$/g, "").trim();

async function enrichOne(b) {
  const st = searchTitle(b.title), au = cleanAuthor(b.author);
  let doc = null;
  // try title + author, then title only
  for (const q of [
    `title=${encodeURIComponent(st)}&author=${encodeURIComponent(au)}`,
    `title=${encodeURIComponent(st)}`,
  ]) {
    const j = await getJSON(`https://openlibrary.org/search.json?${q}&limit=3&fields=key,cover_i,first_publish_year,first_sentence,author_name,title`);
    if (j?.docs?.length) {
      doc = j.docs.find((d) => d.cover_i) || j.docs[0];
      if (doc?.cover_i) break;
    }
    await sleep(200);
  }
  if (!doc) return { ...b, _miss: true };

  let synopsis = "";
  const fs = Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence;
  if (doc.key) {
    const work = await getJSON(`https://openlibrary.org${doc.key}.json`);
    synopsis = tidy(descText(work?.description));
    await sleep(150);
  }
  return {
    ...b,
    cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : "",
    pubYear: doc.first_publish_year || null,
    synopsis,
    firstSentence: clean(fs || ""),
    olKey: doc.key || "",
    _miss: false,
  };
}

// ---- main ----
const rows = parseCSV(readFileSync(SRC, "utf8"));
rows.shift(); // header
const books = rows
  .filter((r) => clean(r[2]))
  .map((r, i) => {
    const date = clean(r[0]), title = clean(r[2]), author = clean(r[1] && /\d/.test(r[0]) ? r[3] : r[3]);
    const note = clean(r[4]);
    return {
      id: i,
      date,
      yearRead: clean(r[1]),
      title,
      author: clean(r[3]),
      note,
      favorite: FAV_RE.test(note),
      themes: deriveThemes(title, note),
    };
  });

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
const byKey = new Map(existing.map((b) => [`${b.title}|${b.date}`, b]));

let done = 0, miss = 0;
const result = [];
for (const b of books) {
  const k = `${b.title}|${b.date}`;
  const prev = byKey.get(k);
  if (prev && prev.cover) { result.push({ ...prev, ...b, cover: prev.cover, pubYear: prev.pubYear, synopsis: prev.synopsis || b.synopsis, firstSentence: prev.firstSentence, olKey: prev.olKey }); done++; continue; }
  const e = await enrichOne(b);
  if (e._miss) miss++; else done++;
  delete e._miss;
  result.push(e);
  if (result.length % 10 === 0) {
    writeFileSync(OUT, JSON.stringify(result, null, 2));
    process.stdout.write(`  ${result.length}/${books.length} (covers:${done} miss:${miss})\n`);
  }
  await sleep(120);
}
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`DONE ${result.length} books — covers found:${result.filter(b=>b.cover).length}  synopses:${result.filter(b=>b.synopsis).length}  favorites:${result.filter(b=>b.favorite).length}`);
