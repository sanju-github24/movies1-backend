import asyncio
import re
import json
import sys
import os
import nest_asyncio
import httpx
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup

nest_asyncio.apply()

# ── Browser path: Render vs local ─────────────────────────────
# On Render we set a custom path so Playwright finds the browser
# downloaded during build. Locally (Mac/Linux/Windows) we
# FORCE-CLEAR any leftover env var so Playwright uses its own
# default install location (~/.cache/ms-playwright etc).

_RENDER_BROWSER_PATH = "/opt/render/project/src/.playwright"
_IS_RENDER = os.path.exists("/opt/render")

if _IS_RENDER:
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = _RENDER_BROWSER_PATH
else:
    # Force remove even if it was set externally (shell profile, .env, etc.)
    os.environ.pop("PLAYWRIGHT_BROWSERS_PATH", None)

# --single-process and --no-zygote are required on Render but
# CRASH Chromium on Mac/desktop — never set them locally.
LAUNCH_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
]
if _IS_RENDER:
    LAUNCH_ARGS += ["--single-process", "--no-zygote"]

# ============================================================
# 🧠 INTELLIGENCE ENGINE
# ============================================================

# ============================================================
# 🎬 TMDB AUTO-SEARCH  (fetches poster + description + clean title)
# ============================================================

TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "")  # Set in Render env vars

async def tmdb_search(movie_name: str, year: str = "") -> dict:
    """
    Searches TMDB by the clean movie name extracted from the page title.
    Returns poster_url, description, clean title, and imdb_rating.
    Falls back to empty strings if API key missing or not found.
    """
    if not TMDB_API_KEY:
        return {}

    query = movie_name.strip()
    params = {
        "api_key": TMDB_API_KEY,
        "query": query,
        "language": "en-US",
        "page": 1,
    }
    if year and year.isdigit():
        params["year"] = year

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            # 1. Search for the movie
            resp = await client.get(
                "https://api.themoviedb.org/3/search/movie",
                params=params
            )
            data = resp.json()
            results = data.get("results", [])

            if not results:
                # Try without year constraint
                params.pop("year", None)
                resp = await client.get(
                    "https://api.themoviedb.org/3/search/movie",
                    params=params
                )
                data = resp.json()
                results = data.get("results", [])

            if not results:
                return {}

            # Pick best match — prefer exact title match, else take first
            best = None
            for r in results:
                if r.get("title", "").lower() == query.lower():
                    best = r
                    break
            if not best:
                best = results[0]

            tmdb_id   = best.get("id")
            poster_path = best.get("poster_path", "")
            overview  = best.get("overview", "")
            title     = best.get("title", movie_name)
            release   = best.get("release_date", "")
            release_year = release[:4] if release else year

            poster_url = (
                f"https://image.tmdb.org/t/p/w500{poster_path}"
                if poster_path else ""
            )

            # 2. Fetch external IDs to get IMDb rating (optional enrichment)
            imdb_rating = ""
            if tmdb_id:
                ext_resp = await client.get(
                    f"https://api.themoviedb.org/3/movie/{tmdb_id}/external_ids",
                    params={"api_key": TMDB_API_KEY}
                )
                ext_data = ext_resp.json()
                imdb_id_val = ext_data.get("imdb_id", "")

                # Fetch IMDb rating via OMDb if available
                omdb_key = os.environ.get("OMDB_API_KEY", "")
                if imdb_id_val and omdb_key:
                    omdb_resp = await client.get(
                        f"http://www.omdbapi.com/?i={imdb_id_val}&apikey={omdb_key}"
                    )
                    omdb_data = omdb_resp.json()
                    imdb_rating = omdb_data.get("imdbRating", "")

            return {
                "title":       title,
                "poster":      poster_url,
                "description": overview,
                "year":        release_year,
                "imdb_rating": imdb_rating,
                "tmdb_id":     tmdb_id,
            }

    except Exception as e:
        print(f"⚠️ TMDB search failed for '{movie_name}': {e}", file=sys.stderr)
        return {}


def clean_label(raw: str) -> str:
    """
    Strip domain names, URLs, Telegram promos, and other noise from a
    scraped label so only the real quality/spec text remains.
    e.g. "www.1tamilmv.com - MovieName 1080p WEB-DL x265 : 2.1 GB MKV"
         → "MovieName 1080p WEB-DL x265 : 2.1 GB MKV"
    """
    # Remove domain variants: www.1tamilmv.ltd, 1tamilmv.com, 1TamilMV.*, etc.
    raw = re.sub(r'(?:www\.)?1tamilmv\.\S+', '', raw, flags=re.IGNORECASE)
    # Remove any stray URLs
    raw = re.sub(r'https?://\S+', '', raw)
    # Remove Telegram promo lines
    raw = re.sub(
        r'(?:TamilMV\s+Official\s+Telegram\s+Channel\s*[:\-]?\s*Click\s+Here)',
        '', raw, flags=re.IGNORECASE
    )
    raw = re.sub(r'Telegram\s*[:\-]?\s*\S*', '', raw, flags=re.IGNORECASE)
    raw = re.sub(r'\b(Click\s*Here|Official|Channel)\b', '', raw, flags=re.IGNORECASE)
    # Collapse whitespace
    raw = re.sub(r'\s{2,}', ' ', raw)
    # Strip leading dashes, pipes, colons, spaces
    raw = re.sub(r'^[\s\-\|:]+|[\s\-\|:]+$', '', raw)
    return raw.strip()


def extract_size_from_label(label_text: str) -> str:
    """Extract file size like '2.1 GB', '900 MB' from label."""
    match = re.search(r'(\d+(\.\d+)?\s*(GB|MB|TB))', label_text, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def extract_format_from_label(label_text: str) -> str:
    """
    Extract video container format.
    Checks text after ':' first, then anywhere in label. Defaults to 'MKV'.
    """
    if ":" in label_text:
        after_colon = label_text.split(":", 1)[1].strip()
        m = re.search(r'\b(MKV|MP4|AVI|TS|M2TS|WEBM|MOV)\b', after_colon, re.IGNORECASE)
        if m:
            return m.group(1).upper()

    m = re.search(r'\b(MKV|MP4|AVI|TS|M2TS|WEBM|MOV)\b', label_text, re.IGNORECASE)
    if m:
        return m.group(1).upper()

    return "MKV"


def extract_quality_from_label(label_text: str) -> str:
    """
    Extract a clean quality string from an already-cleaned label.
    Result starts from the movie/quality info — never contains domain text.

    Priority:
      1. Text before the first ':' (e.g. 'Movie 1080p WEB-DL x265')
      2. From the first known resolution keyword onward
      3. Full cleaned label (up to 80 chars)
    """
    # Always clean first to remove domain/promo noise
    label_text = clean_label(label_text)

    if not label_text:
        return "Unknown"

    # Part before ':' is the quality descriptor
    if ":" in label_text:
        before = label_text.split(":")[0].strip()
        if before:
            return before[:80]

    # Find quality keyword and return from that point
    m = re.search(
        r'(4K|2160p|1080p|720p|480p|HDR|UHD|HDTS|WEB[\s\-]?DL|BluRay|PreDVD|HDCAM|HQ\s*Clean)',
        label_text, re.IGNORECASE
    )
    if m:
        return label_text[m.start():].strip()[:80]

    return label_text[:80]


def decode_title_intelligence(raw_title: str, source_url: str = "") -> dict:
    """
    Parses raw scraped title into structured metadata.
    Maps to admin panel's pill options exactly.
    """
    year_match = re.search(r'\((\d{4})\)', raw_title)
    year = year_match.group(1) if year_match else "2025"

    # Quality → maps to admin panel pills: WEB-DL, HDTS, PRE-HD, PreDVD
    panel_quality = "WEB-DL"
    q = raw_title.lower()
    if "predvd" in q or "pre dvd" in q:
        panel_quality = "PreDVD"
    elif "hdts" in q or "hdtc" in q or " tc " in q:
        panel_quality = "HDTS"
    elif "pre-hd" in q or "hq clean" in q:
        panel_quality = "PRE-HD"

    # Language extraction — works with brackets AND plain text in title/URL
    # e.g. "Madhuvidhu (2026) Malayalam HQ PreDVD..." → ["Malayalam"]
    # e.g. "Movie (Tamil + Telugu + Hindi)" → ["Tamil", "Telugu", "Hindi"]

    # Step 1: try bracketed form first (most precise)
    lang_pattern = r'[\(\[](Tamil|Telugu|Hindi|Eng(?:lish)?|Kannada|Malayalam|Multi|Tam|Tel|Kan|Hin|Mal|ESub|\s|\+|,)+[\)\]]'
    lang_match = re.search(lang_pattern, raw_title, re.IGNORECASE)

    # Full mapping — short codes and full names
    LANG_MAP = {
        "tamil": "Tamil", "tam": "Tamil",
        "telugu": "Telugu", "tel": "Telugu",
        "kannada": "Kannada", "kan": "Kannada",
        "hindi": "Hindi", "hin": "Hindi",
        "malayalam": "Malayalam", "mal": "Malayalam",
        "english": "English", "eng": "English",
    }

    scraped_langs = []

    if lang_match:
        # Parse langs from inside brackets
        raw_langs = re.sub(r'[\(\)\[\]]', '', lang_match.group(0))
        parts = re.split(r'[\+,\s]+', raw_langs)
        for p in parts:
            p = p.strip().lower()
            for key, full in LANG_MAP.items():
                if p == key or p.startswith(key):
                    scraped_langs.append(full)
                    break
    else:
        # Step 2: fallback — scan plain text of title AND source_url for language names
        search_text = raw_title + " " + source_url
        for key, full in LANG_MAP.items():
            if re.search(r'\b' + key + r'\b', search_text, re.IGNORECASE):
                scraped_langs.append(full)

    scraped_langs = list(dict.fromkeys(scraped_langs))  # dedupe preserving order

    return {
        "clean_title": raw_title.split("(")[0].strip(),
        "year": year,
        "languages": scraped_langs if scraped_langs else [],
        "quality_pill": panel_quality,
    }


# ============================================================
# 🤖 SCRAPER BOT
# ============================================================

class AdminAutoFillBot:
    def __init__(self):
        self.base_url = "https://www.1tamilmv.ltd"

    async def scrape_movie_page(self, page, topic_url):
        """
        Scrapes a single movie page and returns structured data
        ready to be auto-filled into the admin upload form.
        Steps:
          1. Load the 1TamilMV page
          2. Extract clean movie name from page title
          3. Auto-search TMDB with that name → get poster, description, clean title
          4. Extract all download blocks (size, format, quality, magnet, torrent, direct)
        """
        try:
            await page.goto(topic_url, wait_until="domcontentloaded", timeout=45000)
            soup = BeautifulSoup(await page.content(), "html.parser")
            raw_title = await page.title()

            intel = decode_title_intelligence(raw_title, topic_url)
            clean_name = intel["clean_title"]
            year       = intel["year"]

            # ── Step 1: TMDB auto-search with extracted movie name ──
            print(f"🔍 Searching TMDB for: '{clean_name}' ({year})", file=sys.stderr)
            tmdb_data = await tmdb_search(clean_name, year)

            # ── Step 2: Poster (TMDB first, fallback to page img) ──
            poster_url = tmdb_data.get("poster", "")
            if not poster_url:
                poster_tag = soup.select_one(".ipsType_richText img")
                poster_url = poster_tag.get("src", "") if poster_tag else ""

            # ── Step 3: Title (TMDB clean title preferred) ──────────
            title = tmdb_data.get("title", "") or clean_name

            # ── Step 4: Description (TMDB overview preferred) ───────
            description = tmdb_data.get("description", "")
            if not description:
                # Fallback: extract from page paragraphs
                desc_paras = soup.select(".ipsType_richText p")
                for p in desc_paras:
                    text = p.get_text(strip=True)
                    if (len(text) > 80
                            and not text.startswith("http")
                            and "magnet" not in text.lower()
                            and "telegram" not in text.lower()):
                        description = text
                        break

            # ── Step 5: Build Download Blocks ────────────────────────
            post_container = soup.select_one(".ipsType_richText")
            download_blocks = []

            if post_container:
                magnet_btns = post_container.select("a.skyblue-button")

                for btn in magnet_btns:
                    magnet_href = btn.get("href", "")
                    if not magnet_href.startswith("magnet:"):
                        continue

                    # Label from nearest <strong> before this button
                    label_tag = btn.find_previous("strong")
                    raw_label = label_tag.get_text(strip=True) if label_tag else ""

                    # ── Clean ALL noise from label first ──────────────
                    label_text = clean_label(raw_label)

                    parent = btn.find_parent("p") or btn.find_parent("div")

                    # Direct link
                    direct_url = ""
                    if parent:
                        direct_tag = parent.find("a", class_="download-button")
                        if direct_tag:
                            direct_url = direct_tag.get("href", "")

                    # Torrent file link
                    torrent_url = ""
                    if parent:
                        torrent_tag = parent.find(
                            "a", class_="ipsAttachLink_block",
                            attrs={"data-fileext": "torrent"}
                        )
                        if not torrent_tag:
                            for attach in parent.find_all("a", class_="ipsAttachLink_block"):
                                href = attach.get("href", "")
                                if ("attachment.php" in href or ".torrent" in href) and ".gif" not in href.lower():
                                    torrent_tag = attach
                                    break
                        if torrent_tag:
                            torrent_url = torrent_tag.get("href", "")

                    # Extract size, format, quality from cleaned label
                    size        = extract_size_from_label(label_text)
                    fmt         = extract_format_from_label(label_text)
                    quality_raw = extract_quality_from_label(label_text)

                    # ── Prefix quality with movie title so the field reads:
                    #    "Madhuvidhu 1080p WEB-DL x265" instead of just "1080p WEB-DL x265"
                    #    Only prepend if the clean_name isn't already in the quality string
                    if clean_name and clean_name.lower() not in quality_raw.lower():
                        quality = f"{title} {quality_raw}".strip()
                    else:
                        quality = quality_raw

                    download_blocks.append({
                        "quality":      quality,
                        "size":         size,
                        "format":       fmt,
                        "manualUrl":    torrent_url,
                        "directUrl":    direct_url,
                        "gpLink":       "",
                        "magnet":       magnet_href,
                        "showGifAfter": False,
                        "_raw_label":   raw_label,
                    })

            return {
                # ── Admin primary info (TMDB-enriched) ───────────────
                "title":       title,
                "slug":        title.lower().replace(" ", "-").replace("/", "-"),
                "poster":      poster_url,
                "description": description,

                # ── Admin taxonomy pills ──────────────────────────────
                "language":    intel["languages"],
                "subCategory": [intel["quality_pill"]],
                "categories":  [],

                # ── Admin display settings ────────────────────────────
                "showOnHomepage":  True,
                "directLinksOnly": False,

                # ── Download blocks ───────────────────────────────────
                "downloadBlocks": download_blocks,

                # ── Meta ──────────────────────────────────────────────
                "_source_url":  topic_url,
                "_year":        tmdb_data.get("year", year),
                "_tmdb_id":     tmdb_data.get("tmdb_id", ""),
                "_imdb_rating": tmdb_data.get("imdb_rating", ""),
                "_raw_1tmv_title": raw_title,
            }

        except Exception as e:
            print(f"❌ Error scraping {topic_url}: {e}", file=sys.stderr)
            return None

    async def scrape_from_url(self, url):
        """Scrape a single known movie page URL."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=LAUNCH_ARGS)
            page = await browser.new_page()
            try:
                result = await self.scrape_movie_page(page, url)
                return result
            finally:
                await browser.close()

    async def scrape_search(self, movie_name, language="Kannada"):
        """Search 1TamilMV and scrape the first matching result."""
        search_url = f"{self.base_url}/search/?q={movie_name.replace(' ', '+')}"
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=LAUNCH_ARGS)
            page = await browser.new_page()
            try:
                await page.goto(search_url, wait_until="domcontentloaded", timeout=45000)
                soup = BeautifulSoup(await page.content(), "html.parser")

                target_link = None
                for a in soup.select("#results a.sRow"):
                    text = a.get_text(" ", strip=True)
                    if movie_name.lower() in text.lower() and language.lower() in text.lower():
                        target_link = a["href"]
                        break

                if not target_link:
                    # Fallback: just take the first result
                    first = soup.select_one("#results a.sRow")
                    if first:
                        target_link = first["href"]

                if not target_link:
                    print(json.dumps({"error": "No results found"}))
                    return None

                result = await self.scrape_movie_page(page, target_link)
                return result
            finally:
                await browser.close()

    async def scrape_top_release(self):
        """Scrape the first Top Release from the homepage."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=LAUNCH_ARGS)
            page = await browser.new_page()
            try:
                await page.goto(self.base_url, wait_until="domcontentloaded", timeout=45000)
                soup = BeautifulSoup(await page.content(), "html.parser")

                span = soup.find(
                    lambda tag: tag.name == "span" and "TOP RELEASES" in tag.text.upper()
                )
                if not span:
                    return None

                parent = span.find_parent("div", class_="ipsWidget_inner")
                first = parent.find("strong")
                link = first.find("a", href=True) if first else None

                if not link:
                    return None

                result = await self.scrape_movie_page(page, link["href"])
                return result
            finally:
                await browser.close()


# ============================================================
# 🌉 EXPRESS / CLI BRIDGE
# ============================================================

async def main():
    """
    Called by Express via:
      python3 autofill_bot.py search "777 Charlie" "Kannada"
      python3 autofill_bot.py url "https://www.1tamilmv.ltd/index.php?/topic/..."
      python3 autofill_bot.py top
    """
    bot = AdminAutoFillBot()
    mode = sys.argv[1] if len(sys.argv) > 1 else "top"

    result = None

    if mode == "search":
        movie_name = sys.argv[2] if len(sys.argv) > 2 else "777 Charlie"
        language   = sys.argv[3] if len(sys.argv) > 3 else "Kannada"
        result = await bot.scrape_search(movie_name, language)

    elif mode == "url":
        url = sys.argv[2] if len(sys.argv) > 2 else ""
        if not url:
            print(json.dumps({"error": "No URL provided"}))
            return
        result = await bot.scrape_from_url(url)

    else:  # "top" — default
        result = await bot.scrape_top_release()

    if result:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"error": "Scraping failed or no data found"}))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(json.dumps({"error": str(e)}))