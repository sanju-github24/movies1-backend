import express from "express";
import puppeteer from "puppeteer-extra"; // puppeteer-extra for stealth
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { load } from "cheerio";

const router = express.Router();
const DEFAULT_ACTOR_IMAGE = "/user.png";
const DEFAULT_POSTER = "/default-poster.png";

// Use stealth plugin to reduce blocking
puppeteer.use(StealthPlugin());

// Optional: Google Custom Search config
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GOOGLE_CX = process.env.GOOGLE_CX || "";

// -------------------- Helper: Google release date --------------------
async function fetchReleaseDateGoogle(title) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return "N/A";
  try {
    const res = await fetch(
      `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
        title + " release date India"
      )}&cx=${GOOGLE_CX}&num=3&key=${GOOGLE_API_KEY}`
    );
    const data = await res.json();
    const items = data.items || [];
    for (const item of items) {
      const text = (item.snippet || "") + " " + (item.title || "");
      const patterns = [
        /\b\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{4}\b/,
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4}\b/,
        /\b\d{4}-\d{2}-\d{2}\b/,
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[0];
      }
    }
    return "N/A";
  } catch (e) {
    console.error("Google release date fetch error:", e.message);
    return "N/A";
  }
}

// -------------------- Main BMS Scraper --------------------
async function scrapeBMS(slug) {
  try {
    const browser = await puppeteer.launch({
      headless: "new", // use new headless mode for better stealth
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();

    // Anti-bot settings
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    );

    const url = `https://in.bookmyshow.com/movies/bengaluru/${slug}`;
    await page.goto(url, { waitUntil: "networkidle2" });

    // Random small delay to mimic human browsing
    await page.waitForTimeout(1000 + Math.random() * 1000);

    const html = await page.content();
    await browser.close();

    const $ = load(html);

    // -------------------- Movie Details --------------------
    const title = $("h1").first().text().trim() || slug;
    const rating = $("h5.sc-ycjzp1-4").first().text().trim() || "N/A";

    const formatLanguage = [];
    $("a.sc-2k6tnd-2.eUdyhJ").each((i, el) => {
      formatLanguage.push($(el).text().trim());
    });

    const releaseDate = await fetchReleaseDateGoogle(title);

    const cast = [];
    $("a.sc-17p4id8-0.chrvLp").each((i, el) => {
      try {
        const name = $(el).find("h5").first().text().trim();
        const role = $(el).find("h5").eq(1).text().replace("as ", "").trim() || null;
        const img = $(el).find("img").attr("src") || DEFAULT_ACTOR_IMAGE;
        cast.push({ name, role, image: img });
      } catch (e) {
        console.error("Error processing cast block:", e.message);
      }
    });

    // -------------------- Poster --------------------
    const poster =
      $("img[src*='/movies/images/mobile/thumbnail/']").first().attr("src") ||
      DEFAULT_POSTER;

    // -------------------- Hero Background --------------------
    let background =
      $("img[src*='/movies/images/cover/']").first().attr("src") ||
      $("img[src*='/movies/images/banner/']").first().attr("src") ||
      null;

    // Fallback: Inline style background
    if (!background) {
      const inlineStyle = $("[style*='background-image']").attr("style");
      if (inlineStyle) {
        const match = inlineStyle.match(/url\((['"]?)(.*?)\1\)/);
        if (match && match[2]) background = match[2];
      }
    }

    // Final fallback: poster
    if (!background) background = poster;

    return {
      success: true,
      movie: { title, rating, releaseDate, formatLanguage, cast, poster, background },
    };
  } catch (e) {
    console.error("BMS Puppeteer error:", e.message);
    return { success: false, error: e.message };
  }
}

// -------------------- Route --------------------
router.get("/", async (req, res) => {
  const { slug } = req.query;
  if (!slug)
    return res.status(400).json({ success: false, message: "No slug provided" });

  const result = await scrapeBMS(slug);
  res.json(result);
});

export default router;
