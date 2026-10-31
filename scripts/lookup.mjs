// Reads lookup.json: fetches article text and runs YouTube searches (recent uploads first).
// Output: data/<date>/lookup.json. Used to check what creators already covered, and Hindi gaps.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getText } from "./lib.mjs";

const day = process.env.RADAR_DATE || new Date().toISOString().slice(0, 10);
const dir = new URL(`../data/${day}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const spec = JSON.parse(await readFile(new URL("../lookup.json", import.meta.url), "utf8"));
const CONSENT = { Cookie: "CONSENT=YES+1; SOCS=CAI" };

function articleText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  let body = (html.match(/<article[\s\S]*?<\/article>/i) || [html])[0];
  body = body.replace(/<(script|style|noscript|svg|nav|header|footer|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|h\d|li|div|br)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&rsquo;|&#8217;/g, "'").replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"').replace(/&#8212;|&mdash;/g, "-")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { title: title.replace(/\s+/g, " ").trim(), text: body.slice(0, 7000) };
}

const AGO = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i;
function searchResults(html) {
  const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!m) throw new Error("no ytInitialData");
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.videoRenderer?.videoId) {
      const v = n.videoRenderer;
      out.push({ id: v.videoId, title: v.title?.runs?.map((r) => r.text).join("") || "", channel: v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || "", ago: v.publishedTimeText?.simpleText || "", views: v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || "" });
    } else if (n.lockupViewModel?.contentId && n.lockupViewModel.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const l = n.lockupViewModel;
      const parts = (l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || []).map((r) => (r.metadataParts || []).map((p) => p.accessibilityLabel || p.text?.content || ""));
      const flat = parts.flat();
      out.push({ id: l.contentId, title: l.metadata?.lockupMetadataViewModel?.title?.content || "", channel: parts[0]?.[0] || "", ago: flat.find((s) => AGO.test(s)) || "", views: flat.find((s) => /views?$/i.test(s)) || "" });
    }
    Object.values(n).forEach(walk);
  };
  walk(JSON.parse(m[1]));
  return out.slice(0, 10);
}

const result = { date: day, articles: [], youtube: [] };
for (const url of spec.urls || []) {
  try { result.articles.push({ url, ok: true, ...articleText(await getText(url)) }); }
  catch (e) { result.articles.push({ url, ok: false, error: String(e.message).slice(0, 120) }); }
}
for (const q of spec.youtube || []) {
  try { result.youtube.push({ query: q, ok: true, results: searchResults(await getText("https://www.youtube.com/results?search_query=" + encodeURIComponent(q) + "&sp=CAI%253D", { headers: CONSENT })) }); }
  catch (e) { result.youtube.push({ query: q, ok: false, error: String(e.message).slice(0, 120) }); }
}
await writeFile(new URL("lookup.json", dir), JSON.stringify(result, null, 1));
console.log("articles ok:", result.articles.filter((a) => a.ok).length + "/" + result.articles.length, "searches ok:", result.youtube.filter((a) => a.ok).length + "/" + result.youtube.length);
