// Small parsing helpers, kept dependency-free so the workflow needs no npm install.
export const UA = "Mozilla/5.0 (compatible; AIRadarCollector/1.0; +https://github.com)";

export function decode(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&").trim();
}

const tag = (block, name) => {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decode(m[1]) : "";
};

// YouTube channel feed: <entry> with yt:videoId, title, published, media:statistics views.
export function parseYouTubeFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const b = m[1];
    const id = tag(b, "yt:videoId");
    if (!id) continue;
    const views = (b.match(/<media:statistics[^>]*views="(\d+)"/) || [])[1];
    out.push({
      id,
      title: tag(b, "title"),
      url: "https://www.youtube.com/watch?v=" + id,
      published: tag(b, "published"),
      views: views ? Number(views) : null,
    });
  }
  return out;
}

// Generic RSS 2.0 / Atom reader used for lab blogs and security feeds.
export function parseFeed(xml) {
  const out = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)];
  for (const [, , b] of blocks) {
    let link = tag(b, "link");
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "";
    out.push({
      title: tag(b, "title"),
      url: decode(link),
      published: tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"),
      summary: tag(b, "description").replace(/<[^>]+>/g, "").slice(0, 300) || tag(b, "summary").replace(/<[^>]+>/g, "").slice(0, 300),
    });
  }
  return out;
}

export function parseArxiv(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, b]) => ({
    title: tag(b, "title").replace(/\s+/g, " "),
    url: tag(b, "id"),
    published: tag(b, "published"),
    summary: tag(b, "summary").replace(/\s+/g, " ").slice(0, 400),
  }));
}

export async function get(url, opts = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...(opts.headers || {}) }, redirect: opts.redirect || "follow", signal: AbortSignal.timeout(20000) });
  return res;
}
export async function getText(url, opts) {
  const res = await get(url, opts);
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.text();
}
export async function getJson(url, opts) {
  return JSON.parse(await getText(url, opts));
}
