import * as cheerio from "cheerio";

/* Pulls the story out of a news article page as clean HTML: paragraphs,
   sub-headings, lists, quotes and the article's own images, without the
   site's ads, share bars, "also read" boxes or the headline (which the reader
   page shows on its own).

   It used to be a handful of regexes that captured "from this <div> to the
   first </div> followed by another tag". News markup nests deeply, so on
   FilmiBeat that first </div> closed the headline block and readers got about
   twenty words of a four-hundred-word story. A parser sees the real nesting. */

// Where the body usually lives, most specific first. The one holding the most
// paragraph text wins, so a broad match like <article> only wins when nothing
// tighter has the story.
const BODY_CANDIDATES = [
  ".fb-article-content-desc",          // FilmiBeat
  "[itemprop='articleBody']",
  ".io-article-body",
  ".story-content", ".ds-prose",        // ESPNcricinfo
  ".article-body", "#article-content", ".article-content",
  "article", "main",
];

const JUNK = [
  "script", "style", "noscript", "iframe", "ins", "form", "button", "svg", "video", "audio",
  "nav", "header", "footer", "aside", "h1", "source",
  ".fb-breadcrumb", ".fb-article-sharesocial", ".google-pref-btn", ".author-profile",
  "[id^='are-slot']", "[class*='oiad']", "[id*='deeplink']", "[class*='deeplink']",
  "[id*='promo']", "[class*='promo']", "[class*='related']", "[class*='widget']",
  "[class*='share']", "[class*='social']", "[class*='newsletter']", "[class*='subscribe']",
  "[class*='advert']", "[id*='advert']", "[class~='ad']", "[class~='ads']",
].join(",");

const KEEP_ATTRS = { a: ["href"], img: ["src", "alt"] };

const paragraphWords = ($, el) =>
  $(el).find("p").toArray()
    .map((p) => $(p).text().trim())
    .filter((t) => t.length > 40)
    .join(" ").split(/\s+/).filter(Boolean).length;

export function wordCount(html = "") {
  return String(html).replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}

export function extractArticleBody(html, pageUrl) {
  const $ = cheerio.load(html);

  let best = null, bestWords = 0;
  for (const sel of BODY_CANDIDATES) {
    $(sel).each((_, el) => {
      const w = paragraphWords($, el);
      // A tighter container with nearly all the text beats a wider one.
      if (w > bestWords * 1.15 || (best === null && w > 0)) { best = el; bestWords = w; }
    });
  }
  if (!best || bestWords < 40) return "";

  const body = $(best).clone();
  body.find(JUNK).remove();
  // "Comments" jump links and similar in-page anchors lead nowhere on our page.
  body.find("a[href^='#'], a[href*='#vuukle'], a[href*='#comments']").remove();

  /* An Instagram embed is a blockquote that Instagram's script turns into the
     post. Without the script it is the words "View this post on Instagram"
     and a byline floating in the story; say plainly what it is instead. */
  body.find("blockquote").each((_, bq) => {
    const $bq = $(bq);
    const link = $bq.find("a[href*='instagram.com/']").first();
    if (!link.length) return;
    const href = String(link.attr("href")).split("?")[0];
    const byline = $bq.find("p").toArray().map((p) => $(p).text().trim())
      .find((t) => /post shared by/i.test(t));
    const who = byline ? byline.replace(/^.*?post shared by\s*/i, "") : "";
    $bq.replaceWith($("<p>").append($("<a>").attr("href", href).text(who ? `Instagram post by ${who}` : "View this post on Instagram")));
  });

  // Lazy-loaded images keep the real address in a data attribute.
  body.find("img").each((_, img) => {
    const $img = $(img);
    const real = ["data-src", "data-lazy-src", "data-original", "data-gal-src", "src"]
      .map((a) => $img.attr(a)).find((v) => v && /^https?:\/\//.test(v) && !/placeholder|blank|spacer|1x1|lazyimage|\.svg(\?|$)/i.test(v));
    if (!real) { $img.remove(); return; }
    $img.attr("src", real);
  });

  // Make links absolute, then strip every attribute the reader does not need
  // (classes, inline styles, tracking data) so the site's own styles apply.
  body.find("*").each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (tag === "a") {
      const href = $(el).attr("href");
      try { if (href) $(el).attr("href", new URL(href, pageUrl).href); } catch { $(el).removeAttr("href"); }
    }
    const keep = KEEP_ATTRS[tag] || [];
    for (const name of Object.keys(el.attribs || {})) if (!keep.includes(name)) $(el).removeAttr(name);
  });

  // Drop the shells ads and widgets leave behind, innermost first.
  body.find("div, span, section, figure, p, picture").toArray().reverse().forEach((el) => {
    const $el = $(el);
    if (!$el.text().trim() && !$el.find("img").length) $el.remove();
  });
  // One copy of each image — galleries often repeat the lead picture.
  const seen = new Set();
  body.find("img").each((_, img) => {
    const src = $(img).attr("src");
    if (seen.has(src)) $(img).remove(); else seen.add(src);
  });

  return body.html()?.trim() || "";
}
