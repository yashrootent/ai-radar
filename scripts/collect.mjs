// Collects raw signals for one day into data/<YYYY-MM-DD>/. Every source fails soft:
// a broken source is recorded in manifest.json instead of stopping the run.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { UA, get, getText, getJson, parseYouTubeFeed, parseFeed, parseArxiv } from "./lib.mjs";

const day = process.env.RADAR_DATE || new Date().toISOString().slice(0, 10);
const dir = new URL(`../data/${day}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const manifest = { date: day, generatedAt: new Date().toISOString(), sources: {} };
const save = (name, data) => writeFile(new URL(name, dir), JSON.stringify(data, null, 1));
const WINDOW_DAYS = 14;
const since = Date.now() - WINDOW_DAYS * 864e5;
const ghHeaders = process.env.GITHUB_TOKEN ? { Authorization: "Bearer " + process.env.GITHUB_TOKEN, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" };

async function step(name, fn) {
  try { const r = await fn(); manifest.sources[name] = { ok: true, ...(r || {}) }; }
  catch (e) { manifest.sources[name] = { ok: false, error: String(e.message || e).slice(0, 200) }; }
}

/* ---- YouTube: channel id from the handle page, then the public RSS feed (15 newest) ---- */
async function channelId(handle, cached) {
  if (cached) return cached;
  const html = await getText("https://www.youtube.com/" + handle, { headers: { Cookie: "CONSENT=YES+1; SOCS=CAI" } });
  const m = html.match(/feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/) || html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error("no channel id for " + handle);
  return m[1];
}
async function isShort(id) {
  try { const r = await get("https://www.youtube.com/shorts/" + id, { redirect: "manual", headers: { Cookie: "CONSENT=YES+1; SOCS=CAI" } }); return r.status === 200; }
  catch { return false; }
}
await step("youtube", async () => {
  const channels = JSON.parse(await readFile(new URL("../channels.json", import.meta.url), "utf8"));
  let ids = {};
  try { ids = JSON.parse(await readFile(new URL("../channel-ids.json", import.meta.url), "utf8")); } catch {}
  const out = []; let ok = 0;
  for (const ch of channels) {
    try {
      const id = await channelId(ch.handle, ids[ch.handle]);
      ids[ch.handle] = id;
      const xml = await getText("https://www.youtube.com/feeds/videos.xml?channel_id=" + id);
      const vids = parseYouTubeFeed(xml).filter((v) => Date.parse(v.published) >= since);
      for (const v of vids) { v.isShort = await isShort(v.id); v.url = v.isShort ? "https://www.youtube.com/shorts/" + v.id : v.url; v.date = v.published.slice(0, 10); }
      out.push({ ...ch, channelId: id, ok: true, videos: vids });
      ok++;
    } catch (e) { out.push({ ...ch, ok: false, error: String(e.message).slice(0, 120), videos: [] }); }
  }
  await writeFile(new URL("../channel-ids.json", import.meta.url), JSON.stringify(ids, null, 1));
  await save("youtube.json", { windowDays: WINDOW_DAYS, fetchedAt: new Date().toISOString(), channels: out });
  return { channelsOk: ok, channelsTracked: channels.length, videos: out.reduce((n, c) => n + c.videos.length, 0) };
});

/* ---- Hacker News: front page plus AI keyword search, last 3 days ---- */
await step("hn", async () => {
  const t0 = Math.floor(Date.now() / 1000) - 3 * 86400;
  const seen = new Map();
  const add = (h) => seen.set(h.objectID, { id: h.objectID, title: h.title, url: h.url, hn: "https://news.ycombinator.com/item?id=" + h.objectID, points: h.points, comments: h.num_comments, created: h.created_at });
  const front = await getJson("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60");
  front.hits.forEach(add);
  for (const q of ["AI", "LLM", "Claude", "GPT", "Gemini", "agent", "OpenAI", "Anthropic", "DeepSeek", "vulnerability"]) {
    const r = await getJson(`https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(q)}&numericFilters=created_at_i>${t0},points>25&hitsPerPage=30`);
    r.hits.forEach(add);
  }
  const items = [...seen.values()].sort((a, b) => (b.points || 0) - (a.points || 0));
  await save("hn.json", items);
  return { items: items.length };
});

/* ---- arXiv (cs.AI, cs.CL, cs.CR), Hugging Face papers and trending models ---- */
await step("arxiv", async () => {
  const xml = await getText("https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.CR&sortBy=submittedDate&sortOrder=descending&max_results=80");
  const items = parseArxiv(xml); await save("arxiv.json", items); return { items: items.length };
});
await step("hf_papers", async () => {
  const j = await getJson("https://huggingface.co/api/daily_papers?limit=40");
  const items = j.map((p) => ({ title: p.title || p.paper?.title, url: "https://huggingface.co/papers/" + p.paper?.id, upvotes: p.paper?.upvotes, summary: (p.paper?.summary || "").replace(/\s+/g, " ").slice(0, 400) }));
  await save("hf_papers.json", items); return { items: items.length };
});
await step("hf_models", async () => {
  const j = await getJson("https://huggingface.co/api/models?sort=trendingScore&limit=30");
  const items = j.map((m) => ({ id: m.id, url: "https://huggingface.co/" + m.id, likes: m.likes, downloads: m.downloads, pipeline: m.pipeline_tag, trending: m.trendingScore }));
  await save("hf_models.json", items); return { items: items.length };
});

/* ---- GitHub: new and fast-rising AI repos, recent security advisories ---- */
await step("github_repos", async () => {
  const d = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const items = new Map();
  for (const q of [`topic:llm created:>${d}`, `topic:ai-agents created:>${d}`, `topic:mcp created:>${d}`, `llm agent pushed:>${d} stars:>500`]) {
    const j = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`, { headers: ghHeaders });
    j.items.forEach((r) => items.set(r.full_name, { name: r.full_name, url: r.html_url, stars: r.stargazers_count, created: r.created_at, description: r.description, language: r.language }));
  }
  const out = [...items.values()].sort((a, b) => b.stars - a.stars); await save("github_repos.json", out); return { items: out.length };
});
await step("github_advisories", async () => {
  const j = await getJson("https://api.github.com/advisories?per_page=40&type=reviewed&sort=published&direction=desc", { headers: ghHeaders });
  const items = j.map((a) => ({ id: a.ghsa_id, cve: a.cve_id, severity: a.severity, summary: a.summary, url: a.html_url, published: a.published_at }));
  await save("github_advisories.json", items); return { items: items.length };
});

/* ---- Reddit (may refuse datacenter IPs; that is recorded, not fatal) ---- */
await step("reddit", async () => {
  const out = {};
  for (const sub of ["LocalLLaMA", "MachineLearning", "netsec", "ChatGPTCoding"]) {
    const j = await getJson(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=25`);
    out[sub] = j.data.children.map((c) => ({ title: c.data.title, url: "https://www.reddit.com" + c.data.permalink, score: c.data.score, comments: c.data.num_comments, created: new Date(c.data.created_utc * 1000).toISOString() }));
  }
  await save("reddit.json", out); return { subs: Object.keys(out).length };
});

/* ---- Labs, changelogs, security and newsletters ---- */
const FEEDS = {
  openai: "https://openai.com/news/rss.xml",
  google_ai: "https://blog.google/technology/ai/rss/",
  deepmind: "https://deepmind.google/blog/rss.xml",
  meta_ai: "https://ai.meta.com/blog/rss/",
  huggingface_blog: "https://huggingface.co/blog/feed.xml",
  mistral: "https://mistral.ai/rss.xml",
  simon_willison: "https://simonwillison.net/atom/everything/",
  hacker_news_sec: "https://feeds.feedburner.com/TheHackersNews",
  krebs: "https://krebsonsecurity.com/feed/",
  bleeping: "https://www.bleepingcomputer.com/feed/",
  latent_space: "https://www.latent.space/feed",
  import_ai: "https://importai.substack.com/feed",
  tldr_ai: "https://tldr.tech/api/rss/ai",
  the_verge_ai: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  techcrunch_ai: "https://techcrunch.com/category/artificial-intelligence/feed/",
};
await step("feeds", async () => {
  const out = {}; const status = {};
  for (const [k, url] of Object.entries(FEEDS)) {
    try { out[k] = parseFeed(await getText(url)).slice(0, 25); status[k] = out[k].length; }
    catch (e) { status[k] = "failed: " + String(e.message).slice(0, 80); }
  }
  await save("feeds.json", out); return { status };
});

await writeFile(new URL("manifest.json", dir), JSON.stringify(manifest, null, 1));
await writeFile(new URL("../data/latest.txt", import.meta.url), day + "\n");
console.log(JSON.stringify(manifest, null, 1));
