"""
BCCI / IPL / FIFA / Pendujatt stream & download extractor
─────────────────────────────────────────────────────────
Strategy:
  BCCI & IPL → Pure HTTP via Page Data Engine (no browser, fast)
  FIFA       → Playwright forced headless=True (required for PBS token)
  Pendujatt  → Playwright headless=True for dynamic Google CSE Search UI
               + Fast Pure HTTP bypass when direct links are provided
               + Automatic clean local downloading and strict file naming
               + Displays direct poster URLs alongside names during search
               + Full native support for /artist/ layout track listing indexes
               + DOM-Inspecting Playwright Home Landing Page Grid Compiler
"""

import sys
import re
import json
import requests
from urllib.parse import quote_plus, unquote

DEBUG = False  # set True to see diagnostics

def dbg(*a):
    if DEBUG:
        print("[debug]", *a, file=sys.stderr)

# ── Brightcove configuration parameters ───────────────────────────────────
BC_ACCOUNT_ID = "3588749423001"  # Shared across both BCCI and IPL platforms
FALLBACK_POLICY_KEY = "BCpkADawqM14f7bO4wGvT1k3zJ-8wN5rCj-C5K7Vz8PzZq"

_HTTP = requests.Session()
_HTTP.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
})


# ─────────────────────────────────────────────────────────────────────────
# Pure HTTP Content Extraction Layer (BCCI & IPL)
# ─────────────────────────────────────────────────────────────────────────

def _fetch_page(target_url, domain_info=None):
    """Return HTML of the video page directly, setting appropriate context headers."""
    headers = {}
    if domain_info:
        headers.update({
            "Origin": domain_info["origin"],
            "Referer": domain_info["referer"]
        })
    r = _HTTP.get(target_url, headers=headers, timeout=20)
    label = domain_info["label"] if domain_info else "Direct"
    dbg(f"[{label}] page fetch status:", r.status_code, "len:", len(r.text))
    r.raise_for_status()
    return r.text


def _extract_video_id(html):
    """Find the Brightcove numeric or alphanumeric video ID from the page HTML source."""
    nd = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.+?)</script>', html, re.DOTALL)
    if nd:
        try:
            text = nd.group(1)
            m = re.search(r'"(?:mediaId|videoId|video_id|brightcoveId)"\s*:\s*"([A-Za-z0-9_\-]+)"', text)
            if m:
                dbg("video_id found via __NEXT_DATA__:", m.group(1))
                return m.group(1)
            m = re.search(r'"(?:mediaId|videoId|video_id|brightcoveId)"\s*:\s*"?(\d+)"?', text)
            if m:
                dbg("video_id (numeric) found via __NEXT_DATA__:", m.group(1))
                return m.group(1)
        except Exception as e:
            dbg("NEXT_DATA parse error:", e)

    for pat in [
        r'(?:mediaId|videoId|data-video-id|data-media-id)["\s=:]+["\']?([A-Za-z0-9_\-]+)["\']?',
        r'["\'](?:mediaId|videoId)["\']\s*:\s*["\']?([A-Za-z0-9_\-]+)["\']?',
    ]:
        m = re.search(pat, html)
        if m:
            dbg("video_id found via fallback regex:", m.group(1))
            return m.group(1)

    dbg("video_id NOT found in HTML")
    return None


def _extract_policy_key(html):
    """
    Scrape a live Brightcove policy key out of the page HTML / inline JSON.
    Fixes the protocol-relative URL issue by verifying the scheme context.
    """
    patterns = [
        r'"policyKey"\s*:\s*"([A-Za-z0-9_\-\.]+)"',
        r'policy[_-]?key["\s=:]+["\']([A-Za-z0-9_\-\.]{30,})["\']',
        r'BCpkAD[A-Za-z0-9_\-\.]{20,}',
    ]
    for pat in patterns:
        m = re.search(pat, html)
        if m:
            key = m.group(1) if m.groups() else m.group(0)
            dbg("policy key scraped from page:", key[:12] + "...", "len:", len(key))
            return key

    m = re.search(r'src=["\']([^"\']*players\.brightcove\.net[^"\']+)["\']', html)
    if m:
        player_js_url = m.group(1)
        
        # ── THE CRITICAL FIX: Ensure the URL has a protocol scheme ──
        if player_js_url.startswith("//"):
            player_js_url = "https:" + player_js_url
            
        dbg("attempting to fetch player bundle for policy key:", player_js_url)
        try:
            r = _HTTP.get(player_js_url, timeout=15)
            if r.status_code == 200:
                for pat in patterns:
                    m2 = re.search(pat, r.text)
                    if m2:
                        key = m2.group(1) if m2.groups() else m2.group(0)
                        dbg("policy key scraped from player bundle:", key[:12] + "...")
                        return key
        except Exception as e:
            dbg("player bundle fetch failed:", e)

    dbg("no live policy key found on page")
    return None


def _brightcove_api(video_id, policy_key):
    """Call Brightcove Playback API and return the working m3u8 URL."""
    url = f"https://edge.api.brightcove.com/playback/v1/accounts/{BC_ACCOUNT_ID}/videos/{video_id}"
    headers = {
        "Accept": f"application/json;pk={policy_key}",
    }
    try:
        r = _HTTP.get(url, headers=headers, timeout=15)
        dbg(f"brightcove_api video_id={video_id} status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            sources = data.get("sources", [])
            
            # Keep track of a backup rendition in case master isn't available
            fallback_rendition = None
            
            for src in sources:
                href = src.get("src", "")
                
                # Check for the overarching adaptive master index first
                if "master.m3u8" in href and "rendition" not in href:
                    return href
                
                # Save the first solid absolute rendition stream as our fallback
                if "rendition.m3u8" in href and not fallback_rendition:
                    fallback_rendition = href
            
            if fallback_rendition:
                dbg("Master index absent. Falling back to active rendition track.")
                return fallback_rendition
                
            dbg("brightcove response had no valid m3u8 streaming source.")
        else:
            dbg("brightcove_api non-200 body snippet:", r.text[:300])
    except Exception as e:
        dbg("brightcove_api exception:", e)
    return None


def get_cricket_stream_http(target_url, domain_info):
    """Handles parsing and extraction logic via direct HTTP for BCCI and IPL pages."""
    short_code = target_url.rstrip("/").split("/")[-1]

    # 1. PRIMARY: Fetch target link directly, scrape video_id + live policy key
    try:
        html = _fetch_page(target_url, domain_info)
        video_id = _extract_video_id(html)
        policy_key = _extract_policy_key(html) or FALLBACK_POLICY_KEY
        if video_id:
            m3u8 = _brightcove_api(video_id, policy_key)
            if m3u8:
                return m3u8
    except Exception as e:
        dbg("primary page-scrape path failed:", e)

    # 2. SECONDARY: Fallback Search API path (Specifically for formatted BCCI endpoints)
    if domain_info["label"] == "BCCI":
        resolve_endpoint = f"https://api.bcci.tv/api/v1/videos/search?search={short_code}&page=1&limit=1"
        try:
            res = _HTTP.get(resolve_endpoint, timeout=15)
            dbg("search API status:", res.status_code)
            if res.status_code == 200:
                payload = res.json()
                video_list = payload.get("data", {}).get("videos", [])
                if video_list:
                    video_id = video_list[0].get("mediaId")
                    if video_id:
                        m3u8 = _brightcove_api(video_id, FALLBACK_POLICY_KEY)
                        if m3u8:
                            return m3u8
        except Exception as e:
            dbg("search API exception:", e)

    # 3. LAST RESORT
    dbg("falling back to ref: lookup")
    return _brightcove_api(f"ref:{short_code}", FALLBACK_POLICY_KEY)


# ─────────────────────────────────────────────────────────────────────────
# Playwright Pendujatt Homepage Scraper (Flexible Element Evaluator)
# ─────────────────────────────────────────────────────────────────────────

def get_pendujatt_homepage_playwright():
    """
    Launches a browser environment to dynamically capture all track listing panels
    and nested song anchors, sorting them gracefully by category titles.
    Handles lazy-loaded thumbnail image swapping automatically.
    """
    from playwright.sync_api import sync_playwright

    homepage_data = {}
    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-gpu",
        "--mute-audio",
        "--disable-dev-shm-usage",
        "--disable-features=IsolateOrigins,site-per-process"
    ]

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=launch_args)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            
            dbg("[Pendujatt] Resolving structural homepage node matrix...")
            page.goto("https://pendujatt.com.se/", wait_until="networkidle", timeout=30000)

            panels = page.locator(".panel.panel-primary, div[class*='panel']").all()
            if not panels:
                panels = page.locator("body > div").all()

            for panel in panels:
                heading_el = panel.locator(".panel-heading, [class*='heading'], h2, h3").first
                if not heading_el.count():
                    continue
                
                category_title = heading_el.inner_text().replace("View All", "").strip()
                if not category_title or any(kw in category_title for kw in ["Navigation", "Search", "Menu", "Footer"]):
                    continue

                anchors = panel.locator("a[href*='/song/']").all()
                category_tracks = []
                seen_slugs = set()

                for anchor in anchors:
                    full_url = anchor.get_attribute("href")
                    if not full_url:
                        continue
                        
                    track_slug = full_url.split("/song/")[-1].replace(".html", "")
                    if track_slug in seen_slugs:
                        continue
                    seen_slugs.add(track_slug)

                    raw_text = anchor.inner_text().strip()
                    lines = [line.strip() for line in raw_text.split("\n") if line.strip()]

                    if len(lines) >= 2:
                        song_name = lines[0]
                        artist = lines[1]
                        tracks_label = lines[2] if len(lines) > 2 else "1 Track"
                    else:
                        song_name = lines[0] if lines else track_slug.replace("-", " ").title()
                        artist = "Various Artists"
                        tracks_label = "1 Track"

                    # Locate the image element block wrapper
                    img_el = anchor.locator("img").first
                    if not img_el.count():
                        img_el = anchor.locator("..").locator("img").first

                    poster = "https://pendujatt.com.se/images/default-poster.jpg"
                    if img_el.count():
                        # LAZY-LOAD BYPASS: Check for lazy attributes before falling back to raw src
                        src_attr = (
                            img_el.get_attribute("data-src") or 
                            img_el.get_attribute("data-original") or 
                            img_el.get_attribute("lazy-src") or 
                            img_el.get_attribute("src")
                        )
                        if src_attr:
                            poster = src_attr if src_attr.startswith("http") else "https://pendujatt.com.se" + src_attr

                    if song_name and len(song_name) > 1:
                        category_tracks.append({
                            "id": track_slug,
                            "title": song_name,
                            "subtitle": "",
                            "artist": artist,
                            "tracks": tracks_label,
                            "poster": poster,
                            "page_url": full_url if full_url.startswith("http") else "https://pendujatt.com.se" + full_url
                        })

                if category_tracks:
                    homepage_data[category_title] = category_tracks

            # Global alternative layout extraction loop
            if not homepage_data:
                dbg("[Pendujatt] Standard panel map empty. Running universal listing fallbacks...")
                all_song_anchors = page.locator("a[href*='/song/']").all()
                fallback_tracks = []
                for a in all_song_anchors:
                    href = a.get_attribute("href")
                    slug = href.split("/song/")[-1].replace(".html", "")
                    
                    raw_text = a.inner_text().strip()
                    lines = [line.strip() for line in raw_text.split("\n") if line.strip()]
                    
                    if len(lines) >= 2:
                        name = lines[0]
                        artist = lines[1]
                        tracks_label = lines[2] if len(lines) > 2 else "1 Track"
                    else:
                        name = lines[0] if lines else slug.replace("-", " ").title()
                        artist = "Various Artists"
                        tracks_label = "1 Track"

                    img_el = a.locator("img").first
                    if not img_el.count():
                        img_el = a.locator("..").locator("img").first
                    
                    poster = "https://pendujatt.com.se/images/default-poster.jpg"
                    if img_el.count():
                        src_attr = (
                            img_el.get_attribute("data-src") or 
                            img_el.get_attribute("data-original") or 
                            img_el.get_attribute("lazy-src") or 
                            img_el.get_attribute("src")
                        )
                        if src_attr:
                            poster = src_attr if src_attr.startswith("http") else "https://pendujatt.com.se" + src_attr

                    if href and name and len(name) > 1:
                        fallback_tracks.append({
                            "id": slug,
                            "title": name,
                            "subtitle": "",
                            "artist": artist,
                            "tracks": tracks_label,
                            "poster": poster,
                            "page_url": href if href.startswith("http") else "https://pendujatt.com.se" + href
                        })
                if fallback_tracks:
                    homepage_data["Trending Music Highlights"] = fallback_tracks[:24]

            dbg("=== PENDUJATT HOME DASHBOARD PAYLOAD ===")
            if DEBUG:
                dbg(f"Dashboard Keys: {list(homepage_data.keys())}")
            dbg("=========================================")

        except Exception as e:
            try:
                print(f"Error compiling landing dashboard arrays: {e}", file=sys.stderr)
            except Exception:
                pass
        finally:
            if 'browser' in locals():
                browser.close()

    return homepage_data


# ─────────────────────────────────────────────────────────────────────────
# Non-Interactive Layout Parsing Matrix
# ─────────────────────────────────────────────────────────────────────────

def extract_pendujatt_download_link(html_tree):
    """Finds the absolute 320kbps MP3 link block inside the Pendujatt tree architecture."""
    match = re.search(r'href=["\'](https://[^"\']*?pendujatt\.com\.se/load/320/[^"\']+)["\']', html_tree, re.IGNORECASE)
    if match: return match.group(1)
        
    match_128 = re.search(r'href=["\'](https://[^"\']*?pendujatt\.com\.se/load/)128/([^"\']+)["\']', html_tree, re.IGNORECASE)
    if match_128: return f"{match_128.group(1)}320/{match_128.group(2)}"
    return None


def extract_all_pendujatt_download_links(html_tree):
    """Finds all available download links and their bitrates inside the HTML."""
    matches = re.findall(r'href=["\'](https://[^"\']*?pendujatt\.com\.se/load/(\d+)/[^"\']+)["\']', html_tree, re.IGNORECASE)
    matches_relative = re.findall(r'href=["\'](/load/(\d+)/[^"\']+)["\']', html_tree, re.IGNORECASE)
    
    results = {}
    for url, bitrate in matches:
        results[bitrate + "kbps"] = url.replace(" ", "%20")
        
    for url, bitrate in matches_relative:
        full_url = "https://pendujatt.com.se" + url
        results[bitrate + "kbps"] = full_url.replace(" ", "%20")
        
    if not results:
        fallback = extract_pendujatt_download_link(html_tree)
        if fallback:
            results["320kbps"] = fallback
            
    return results


def get_pendujatt_download(target_or_query):
    """Headless automated backend path selector targeting song pages directly via un-wrapped paths."""
    from playwright.sync_api import sync_playwright

    url = target_or_query
    is_listing_hub = False
    fallback_search_term = None
    
    if not url.startswith("http"):
        url = f"https://pendujatt.com.se/search.php?q={quote_plus(target_or_query)}#gsc.tab=0&gsc.q={quote_plus(target_or_query)}&gsc.page=1"
        is_listing_hub = True
    elif "search.php" in url or "/album/" in url or "/artist/" in url:
        is_listing_hub = True

    if not is_listing_hub and "/song/" in url:
        try:
            html = _fetch_page(url)
            resolved = extract_pendujatt_download_link(html)
            if resolved:
                details = get_pendujatt_song_details(html, url)
                return (resolved, details)
        except requests.exceptions.HTTPError as http_err:
            if http_err.response.status_code == 404:
                slug_fragment = url.split("/song/")[-1].replace(".html", "").replace("-mp3-song", "")
                fallback_search_term = slug_fragment.replace("-", " ")
                url = f"https://pendujatt.com.se/search.php?q={quote_plus(fallback_search_term)}#gsc.tab=0&gsc.q={quote_plus(fallback_search_term)}&gsc.page=1"
                is_listing_hub = True
            else:
                dbg(f"Direct path fetch failed: {http_err}")
        except Exception as e:
            dbg(f"Fast path failed: {e}")

    resolved_tuple = (None, None)
    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-gpu",
        "--mute-audio",
        "--disable-dev-shm-usage",
        "--disable-features=IsolateOrigins,site-per-process"
    ]

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=launch_args)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            
            dbg(f"[Pendujatt] Browser navigating to listing matrix: {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            
            if "search.php" in page.url:
                try:
                    page.wait_for_selector("a.gs-title, .gs-webResult", timeout=12000)
                    page.wait_for_timeout(2000)
                except Exception:
                    pass

            if "search.php" in page.url:
                html_content = page.content()
                raw_links = re.findall(r'href=["\']((?:https://(?:www\.)?google\.com/url\?[^"\'>\s]*?q=)?(?:https://pendujatt\.com\.se)?/song/[^"\'>\s]+)["\']', html_content, re.IGNORECASE)
                
                target_resolved_url = None
                for candidate in raw_links:
                    if "google.com/url?" in candidate.lower() and "q=" in candidate.lower():
                        q_match = re.search(r'[?&]q=(https://[^&]+)', candidate)
                        if q_match:
                            candidate = unquote(q_match.group(1))
                    
                    if "/song/" in candidate.lower():
                        if fallback_search_term:
                            clean_keyword = fallback_search_term.split()[0].lower()
                            if clean_keyword in candidate.lower():
                                target_resolved_url = candidate
                                break
                        else:
                            target_resolved_url = candidate
                            break

                if target_resolved_url:
                    page.goto(target_resolved_url, wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_timeout(1000)
                else:
                    browser.close()
                    return resolved_tuple

            full_dom_html = page.content()
            resolved_url = extract_pendujatt_download_link(full_dom_html)
            details = get_pendujatt_song_details(full_dom_html, page.url)
            if resolved_url:
                resolved_tuple = (resolved_url, details)

        except Exception as e:
            dbg(f"[Playwright Core Exception]: {e}")
        finally:
            if 'browser' in locals():
                browser.close()

    return resolved_tuple


def get_pendujatt_song_details(html, song_url):
    """Parses metadata cleanly using descriptive elements from the layout."""
    try:
        cover_match = re.search(r'property="og:image"\s+content=["\']([^"\']+)["\']', html)
        cover_url = cover_match.group(1) if cover_match else None

        rows = re.findall(r'<td class="td1">\s*(.*?)\s*</td>\s*<td>\s*(.*?)\s*</td>', html, re.IGNORECASE | re.DOTALL)
        table_data = {}
        for k, v in rows:
            clean_k = re.sub(r'<[^>]*>', '', k).strip().lower()
            clean_v = re.sub(r'<[^>]*>', '', v).strip()
            table_data[clean_k] = clean_v

        description_text = ""
        paragraphs = re.findall(r'<p[^>]*?>(.*?)</p>', html, re.IGNORECASE | re.DOTALL)
        for p in paragraphs:
            clean_p = re.sub(r'<[^>]*>', '', p).strip()
            if 'sung by' in clean_p or 'composed By' in clean_p:
                description_text = clean_p
                break

        title = table_data.get("song name")
        if not title:
            title_match = re.search(r'<title>([^<]+)</title>', html)
            title = title_match.group(1).split(" - ")[0].strip() if title_match else "Unknown"
            for suffix in ["Mp3 Song Download", "PendJatt.Com.Se", "PendJatt", "Mp3 Song", "Download"]:
                title = re.sub(rf'\b{suffix}\b', '', title, flags=re.IGNORECASE).strip()
            title = re.sub(r'\s+', ' ', title).strip()

        singer = table_data.get("singer")
        if not singer:
            singer_match = re.search(r'sung by\s+([^,|\n.]+)', description_text, re.IGNORECASE)
            singer = singer_match.group(1).strip() if singer_match else "Unknown"

        album = table_data.get("album")
        if not album:
            album_match = re.search(r'From\s+["\']([^"\']+)["\']', description_text, re.IGNORECASE)
            album = album_match.group(1).strip() if album_match else "Single"

        composer = "Unknown"
        composer_match = re.search(r'composed By\s+([^,|\n.]+)', description_text, re.IGNORECASE)
        if composer_match:
            composer = composer_match.group(1).strip()

        return {
            "title": title,
            "cover_image": cover_url,
            "singer": singer,
            "album": album,
            "composer": composer,
            "starring": table_data.get("starring", "N/A"),
            "label": table_data.get("label", "N/A"),
            "duration": table_data.get("duration", "N/A"),
            "added_on": table_data.get("added on", "N/A"),
            "page_url": song_url
        }
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────
# Playwright Search Pagination Indexer
# ─────────────────────────────────────────────────────────────────────────

def _clean_result_title(title):
    """Strip search-engine / site suffix noise so cards render clean names."""
    t = re.sub(r'\s+', ' ', title or '').strip()
    t = re.sub(r'\s*[-|–]\s*(?:PendJatt(?:\.Com\.Se)?|Pendujatt(?:\.com\.se)?).*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\b(?:All Mp3 Songs? Download|All Mp3 Songs?|Mp3 Songs? Download|Download Mp3 Songs?|Mp3 Songs?|Songs? Download)\b', '', t, flags=re.IGNORECASE)
    return re.sub(r'\s+', ' ', t).strip(' -|–').strip()


def get_pendujatt_search_json(query):
    """
    Launches Playwright headless browser to run search or listing parse,
    and returns a dictionary of match objects with tracking wrappers stripped out.
    """
    from playwright.sync_api import sync_playwright
    
    is_direct_listing = False
    if query.startswith("album:") or query.startswith("artist:"):
        is_direct_listing = True
        parts = query.split(":", 1)
        item_type = parts[0]
        slug = parts[1]
        url = f"https://pendujatt.com.se/{item_type}/{slug}"
    else:
        url = f"https://pendujatt.com.se/search.php?q={quote_plus(query)}#gsc.tab=0&gsc.q={quote_plus(query)}&gsc.page=1"
        
    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-gpu",
        "--mute-audio",
        "--disable-dev-shm-usage",
        "--disable-features=IsolateOrigins,site-per-process"
    ]
    results = {"songs": [], "albums": [], "artists": [], "metadata": {}}
    
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=launch_args)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            page = context.new_page()
            
            # Anti-fingerprint injection
            page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
            """)
            
            dbg(f"[Pendujatt Search] Resolving target: {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            
            if is_direct_listing:
                page.wait_for_timeout(1000)
                html_content = page.content()

                # Listing pages exist both with and without the .html suffix —
                # if the first variant rendered no song links, retry the other.
                if "/song/" not in html_content:
                    alt_url = url[:-5] if url.endswith(".html") else url + ".html"
                    try:
                        dbg(f"[Pendujatt Listing] no tracks at {url}; retrying {alt_url}")
                        page.goto(alt_url, wait_until="domcontentloaded", timeout=30000)
                        page.wait_for_timeout(1000)
                        html_content = page.content()
                    except Exception:
                        pass

                default_poster = None
                cover_match = re.search(r'property="og:image"\s+content=["\']([^"\']+)["\']', html_content)
                if cover_match: default_poster = cover_match.group(1)
                if not default_poster: default_poster = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=150&q=80"

                # Real listing title (album/artist name) for the frontend header
                listing_title = None
                title_match = re.search(r'property="og:title"\s+content=["\']([^"\']+)["\']', html_content)
                if not title_match:
                    title_match = re.search(r'<title>([^<]+)</title>', html_content)
                if title_match:
                    listing_title = _clean_result_title(title_match.group(1))

                results["metadata"] = {"poster": default_poster, "title": listing_title}

                from bs4 import BeautifulSoup
                soup = BeautifulSoup(html_content, 'html.parser')

                # Single robust pass over every /song/ anchor: works for the
                # .song-list layout, panel layouts, and any other markup.
                seen_slugs = set()
                for link in soup.find_all('a', href=True):
                    href = link['href']
                    if '/song/' not in href:
                        continue
                    slug = href.split('/song/')[-1].replace('.html', '').strip('/')
                    if not slug or slug in seen_slugs:
                        continue

                    # Title: prefer an explicit .songname node, else the anchor's first text line
                    title_el = link.find(class_='songname')
                    if title_el is not None:
                        title = title_el.get_text(strip=True)
                    else:
                        lines = [ln.strip() for ln in link.get_text('\n').split('\n') if ln.strip()]
                        title = lines[0] if lines else slug.replace('-', ' ').title()
                    title = _clean_result_title(title) or slug.replace('-', ' ').title()
                    if len(title) < 2:
                        continue

                    # Poster: look inside the anchor then its container; honour lazy-load
                    # attributes and keep relative paths by prefixing the domain.
                    img = link.find('img')
                    if img is None and link.parent is not None:
                        img = link.parent.find('img')
                    poster = None
                    if img is not None:
                        poster = (img.get('data-src') or img.get('data-original')
                                  or img.get('lazy-src') or img.get('src'))
                    if poster and poster.startswith('/'):
                        poster = 'https://pendujatt.com.se' + poster
                    if not poster or not poster.startswith('http'):
                        poster = default_poster

                    seen_slugs.add(slug)
                    results["songs"].append({
                        "id": slug, "title": title, "label": "Mp3 Song", "poster": poster,
                        "url": href if href.startswith('http') else 'https://pendujatt.com.se' + href
                    })
            else:
                # ── Custom Search Engine Scraping Execution ──
                def scrape_page_items(pg):
                    return pg.evaluate("""() => {
                        const items = [];
                        document.querySelectorAll('.gsc-webResult').forEach(el => {
                            const titleEl = el.querySelector('a.gs-title');
                            const imgEl = el.querySelector('img.gs-image');
                            if (titleEl) {
                                items.push({
                                    url: titleEl.href,
                                    title: titleEl.textContent || '',
                                    poster: imgEl ? imgEl.src : null
                                });
                            }
                        });
                        return items;
                    }""")

                def process_items(raw_items, seen, results):
                    for item in raw_items:
                        full_url = item.get("url", "")
                        if not full_url: continue

                        if "google.com/url?" in full_url.lower() and "q=" in full_url.lower():
                            q_match = re.search(r'[?&]q=(https://[^&]+)', full_url)
                            if q_match: full_url = unquote(q_match.group(1))

                        if full_url in seen: continue
                        seen.add(full_url)

                        title = _clean_result_title(item.get("title", ""))
                        poster = item.get("poster") or "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=150&q=80"
                        url_lower = full_url.lower()

                        if "/artist/" in url_lower:
                            slug = full_url.split("/artist/")[-1].replace(".html", "").strip("/")
                            if not slug or any(a["id"] == slug for a in results["artists"]): continue
                            title = title or slug.replace("-", " ").title()
                            results["artists"].append({"id": slug, "title": title, "poster": poster, "url": full_url})
                        elif "/album/" in url_lower:
                            slug = full_url.split("/album/")[-1].replace(".html", "").strip("/")
                            if not slug or any(a["id"] == slug for a in results["albums"]): continue
                            title = title or slug.replace("-", " ").title()
                            results["albums"].append({"id": slug, "title": title, "poster": poster, "url": full_url})
                        elif "/song/" in url_lower:
                            slug = full_url.split("/song/")[-1].replace(".html", "").strip("/")
                            if not slug or any(s["id"] == slug for s in results["songs"]): continue
                            title = title or slug.replace("-", " ").title()
                            results["songs"].append({"id": slug, "title": title, "label": "Mp3 Song", "poster": poster, "url": full_url})

                try:
                    page.wait_for_selector(".gs-title, a.gs-title, a.gs-image", timeout=12000)
                except Exception:
                    pass
                page.wait_for_timeout(1500)

                seen = set()
                raw_items = scrape_page_items(page)
                process_items(raw_items, seen, results)

                total_pages = page.evaluate("() => document.querySelectorAll('.gsc-cursor-page').length")
                dbg(f"[Search Engine] Processing across total paginated levels: {total_pages}")

                encoded_q = quote_plus(query)
                for pg_num in range(2, min(total_pages + 1, 6)):
                    try:
                        page_url = f"https://pendujatt.com.se/search.php?q={encoded_q}#gsc.tab=0&gsc.q={encoded_q}&gsc.page={pg_num}"
                        page.goto(page_url, wait_until="domcontentloaded", timeout=20000)
                        page.wait_for_timeout(1200)
                        raw_items = scrape_page_items(page)
                        if not raw_items: break
                        process_items(raw_items, seen, results)
                    except Exception:
                        break

        except Exception as e:
            dbg(f"Search framework error: {e}")
        finally:
            if 'browser' in locals():
                browser.close()
    return results


# ─────────────────────────────────────────────────────────────────────────
# FIFA via Playwright (Strictly Headless)
# ─────────────────────────────────────────────────────────────────────────

def get_fifa_stream_playwright(target_url):
    from playwright.sync_api import sync_playwright

    captured_url = None
    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process"
    ]

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=launch_args)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 800},
                locale="en-US",
                timezone_id="America/New_York",
            )
            page = context.new_page()
            page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            """)

            def handle_request(request):
                nonlocal captured_url
                url = request.url
                if "/j.m3u8?pbs=" in url:
                    captured_url = url
                elif ".m3u8?pbs=" in url and not captured_url:
                    captured_url = url

            page.on("request", handle_request)
            page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2000)

            try:
                cookie_btn = page.locator("#onetrust-accept-btn-handler, button:has-text('Accept All Cookies')").first
                if cookie_btn.is_visible():
                    cookie_btn.click(force=True, timeout=2000)
            except Exception:
                pass

            for _ in range(40):
                if captured_url:
                    break
                page.wait_for_timeout(250)

        except Exception as e:
            print(f"[fifa_playwright] Error: {e}", file=sys.stderr)
        finally:
            if 'browser' in locals():
                browser.close()

    return captured_url


# ─────────────────────────────────────────────────────────────────────────
# Core Routing Hub Entry Point & Backend API Bindings
# ─────────────────────────────────────────────────────────────────────────

def get_clean_stream(target_url):
    target_lower = target_url.lower()
    
    if "bcci.tv" in target_lower:
        domain_info = {"label": "BCCI", "origin": "https://www.bcci.tv", "referer": "https://www.bcci.tv/"}
        return get_cricket_stream_http(target_url, domain_info)
        
    elif "iplt20.com" in target_lower:
        domain_info = {"label": "IPL", "origin": "https://www.iplt20.com", "referer": "https://www.iplt20.com/"}
        return get_cricket_stream_http(target_url, domain_info)
        
    elif "pendujatt.com" in target_lower or not target_url.startswith("http"):
        if target_url.strip().rstrip("/") in ["https://pendujatt.com.se", "http://pendujatt.com.se"]:
            return get_pendujatt_homepage_playwright()
        return get_pendujatt_download(target_url)
        
    else:
        return get_fifa_stream_playwright(target_url)


def get_pendujatt_track_info_json(id_or_url):
    """Intercepts missing direct tracks, cascades to the tracking-unwrapped worker layout, and maps back clean JSON structures."""
    if not id_or_url.startswith("http"):
        url = f"https://pendujatt.com.se/song/{id_or_url}"
    else:
        url = id_or_url
        
    try:
        dbg(f"[Backend Port] Running direct resolution tracking payload: {url}")
        html = _fetch_page(url)
        downloads = extract_all_pendujatt_download_links(html)
        details = get_pendujatt_song_details(html, url)
        
        stream_url = None
        for br in ["320kbps", "192kbps", "128kbps"]:
            if br in downloads:
                stream_url = downloads[br]
                break
        if not stream_url and downloads: stream_url = list(downloads.values())[0]

        return {
            "success": True if downloads else False,
            "stream_url": stream_url,
            "downloads": downloads,
            "metadata": details
        }
    except requests.exceptions.HTTPError as http_err:
        if http_err.response.status_code == 404:
            clean_token = url.split("/song/")[-1].replace(".html", "").replace("-mp3-song", "")
            fallback_query = clean_token.replace("-", " ")
            dbg(f"[Backend Interceptor] 404 Found. Invoking extraction engine fallback for: '{fallback_query}'")
            
            extraction_result = get_pendujatt_download(fallback_query)
            if extraction_result and isinstance(extraction_result, tuple):
                stream_url, details = extraction_result
                if stream_url:
                    return {
                        "success": True,
                        "stream_url": stream_url,
                        "downloads": {"320kbps": stream_url},
                        "metadata": details
                    }
            return {"success": False, "error": "Requested content structure could not be resolved."}
        return {"success": False, "error": str(http_err)}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────────
# GAANA — search + HLS (.m3u8) stream extraction
# ─────────────────────────────────────────────────────────────────────────
# Gaana songs stream over HLS (e.g. https://vodhlsgaana-*.akamaized.net/hls/.../index.m3u8)
# rather than a plain downloadable MP3, so these tracks are play-only (no download).
# Song ids are namespaced as "gaana__<seokey>" so the frontend and the --track
# router can tell a Gaana track apart from a Pendujatt one.

GAANA_FALLBACK_POSTER = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=150&q=80"

# Modest memory savings that do NOT interfere with the Gaana player starting
# playback (which is required for it to request the HLS manifest we capture).
# Aggressive flags like --single-process / capped V8 heap were removed because
# they crash/stall the player and break stream extraction.
GAANA_LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--mute-audio",
    "--disable-dev-shm-usage",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-extensions",
    "--disable-software-rasterizer",
]

# Only block images/fonts — resources the player never needs. Media/stylesheet
# are left alone so the player initialises and requests the manifest normally.
_GAANA_BLOCK_TYPES = {"image", "font"}

def _gaana_block_heavy(route):
    try:
        if route.request.resource_type in _GAANA_BLOCK_TYPES:
            return route.abort()
        return route.continue_()
    except Exception:
        try:
            return route.continue_()
        except Exception:
            return None


def _gaana_pick(d, *keys):
    """Return the first truthy value among the given keys of a dict."""
    if not isinstance(d, dict):
        return None
    for k in keys:
        v = d.get(k)
        if v:
            return v
    return None


def _gaana_artist_str(track):
    """Flatten Gaana's varied artist shapes (list of dicts / list of strings / string)."""
    a = track.get("artist") if isinstance(track, dict) else None
    if isinstance(a, list):
        names = []
        for it in a:
            if isinstance(it, dict):
                names.append(it.get("name") or it.get("artist_name") or "")
            elif isinstance(it, str):
                names.append(it)
        joined = ", ".join(n for n in names if n)
        if joined:
            return joined
    elif isinstance(a, str) and a.strip():
        return a.strip()
    return _gaana_pick(track, "artist_name", "singers", "primaryArtist") or "Unknown"


def _gaana_artwork(track):
    """Pick the best artwork URL and upgrade tiny thumbnails to a larger rendition."""
    art = _gaana_pick(track, "artwork", "atw", "albumartwork", "artworkLink", "atwl", "image")
    if not art or not isinstance(art, str):
        return GAANA_FALLBACK_POSTER
    art = art.replace("size_s", "size_l").replace("size_m", "size_l")
    if art.startswith("//"):
        art = "https:" + art
    return art if art.startswith("http") else GAANA_FALLBACK_POSTER


def _gaana_seokey(track):
    """Extract the song seokey (URL slug) from a track object."""
    key = _gaana_pick(track, "seokey", "seo_url", "seokey_song", "url", "permaurl")
    if not key:
        return None
    return str(key).rstrip("/").split("/")[-1].replace(".html", "")


def _clean_gaana_title(t):
    """Strip Gaana's SEO title cruft down to just the song name.

    e.g. 'KALYANI : Play & Download New KALYANI online @Gaana' -> 'KALYANI'
    """
    if not t or not isinstance(t, str):
        return ""
    # Gaana often duplicates the song name across pipe-delimited segments —
    # the first segment holds the clean name.
    t = t.split('|')[0]
    t = re.sub(r'\s*[:|-]\s*Play\s*&\s*Download.*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*[-|:]\s*Gaana(?:\.com)?.*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*@\s*Gaana.*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\b(?:MP3\s*Song\s*Download|Song\s*Download|MP3\s*Song|Full\s*Song|Video\s*Song|online)\b',
               '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s+', ' ', t).strip(' -|:•')
    return t.strip()


def _parse_gaana_desc(desc):
    """Pull singer / album / duration out of Gaana's og:description sentence.

    Gaana descriptions read like: 'Listen to <Artist> KALYANI MP3 song.
    KALYANI song from the album <Album> is released on <date>. The duration
    of song is 03:54. This song is sung by <Artist>.'
    """
    out = {}
    if not desc or not isinstance(desc, str):
        return out
    m = re.search(r'sung by\s+([^.|]+)', desc, re.IGNORECASE)
    if m:
        out["singer"] = m.group(1).strip(' .,')
    m = re.search(r'\bfrom\s+(?:the\s+album\s+)?["\']?(.+?)["\']?\s+(?:is|was)\s+released', desc, re.IGNORECASE)
    if m:
        out["album"] = m.group(1).strip(' .,"\'')
    m = re.search(r'duration\s+of\s+(?:the\s+)?song\s+is\s+(\d{1,2}:\d{2})', desc, re.IGNORECASE)
    if m:
        out["duration"] = m.group(1).strip()
    return out


def _find_music_ld(ld_texts):
    """Given raw JSON-LD script bodies, return the MusicRecording-like object."""
    def looks_musical(obj):
        if not isinstance(obj, dict):
            return False
        t = obj.get("@type", "")
        types = t if isinstance(t, list) else [t]
        if any("music" in str(x).lower() for x in types):
            return True
        return "byArtist" in obj or "inAlbum" in obj

    for raw in ld_texts or []:
        try:
            data = json.loads(raw)
        except Exception:
            continue
        candidates = []
        if isinstance(data, list):
            candidates = data
        elif isinstance(data, dict):
            if isinstance(data.get("@graph"), list):
                candidates = data["@graph"]
            else:
                candidates = [data]
        for c in candidates:
            if looks_musical(c):
                return c
    return None


def _gaana_song_page_meta(seokey):
    """Parse a Gaana song page's metadata straight out of the server-rendered HTML.

    The song page ships og: tags and a schema.org MusicRecording block before any
    JavaScript runs, so title/artist/album/duration/artwork need no browser.
    Only the HLS manifest itself is JS-generated (see get_gaana_track_info_json).
    """
    out = {}
    try:
        r = _HTTP.get(f"https://gaana.com/song/{seokey}", timeout=15)
        if r.status_code != 200:
            return out
        html = r.text
    except Exception as e:
        dbg(f"[Gaana] song page fetch failed for {seokey}: {e}")
        return out

    # schema.org MusicRecording — richest source when present.
    ld = _find_music_ld(re.findall(
        r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S))
    if isinstance(ld, dict):
        if ld.get("name"):
            out["title"] = _clean_gaana_title(ld["name"]) or ld["name"]
        img = ld.get("image")
        if isinstance(img, list) and img:
            img = img[0]
        if isinstance(img, str) and img.startswith("http"):
            out["artwork"] = img
        by = ld.get("byArtist")
        if isinstance(by, dict) and by.get("name"):
            out["artist"] = by["name"]
        elif isinstance(by, list):
            names = [b.get("name") for b in by if isinstance(b, dict) and b.get("name")]
            if names:
                out["artist"] = ", ".join(names)
        elif isinstance(by, str) and by.strip():
            out["artist"] = by.strip()
        album = ld.get("inAlbum")
        if isinstance(album, dict) and album.get("name"):
            out["album"] = album["name"]
        elif isinstance(album, str) and album.strip():
            out["album"] = album.strip()
        dur = _iso_duration_to_clock(ld.get("duration"))
        if dur != "N/A":
            out["duration"] = dur

    # og: tags fill whatever the structured data missed. Note Gaana renders these
    # with a data-react-helmet attribute before `property`, so don't anchor on it.
    def og(prop):
        m = re.search(r'<meta[^>]+property="%s"[^>]+content="([^"]*)"' % re.escape(prop), html)
        return m.group(1) if m else None

    if not out.get("artwork"):
        image = og("og:image")
        if image and image.startswith("http"):
            out["artwork"] = image
    if not out.get("title"):
        cleaned = _clean_gaana_title(og("og:title") or "")
        if cleaned:
            out["title"] = cleaned

    desc = og("og:description")
    if desc:
        fields = _parse_gaana_desc(desc)
        for k in ("singer", "album", "duration"):
            if fields.get(k):
                out.setdefault("artist" if k == "singer" else k, fields[k])
    return out


def _gaana_search_http(query, limit=25):
    """Pure-HTTP Gaana search — scrapes the server-rendered search page.

    Gaana's search results are rendered server-side into `article.cardArticle`
    blocks, so no browser is needed. (The old gaana.com/apiv2 endpoint this used
    to call now 404s, which silently pushed every search onto the Playwright
    fallback — the reason search died on hosts without a working Chromium.)
    Artwork/artist are lazy-loaded client-side, so they're filled in concurrently
    from each song page's server-rendered metadata.
    """
    from bs4 import BeautifulSoup
    from concurrent.futures import ThreadPoolExecutor

    try:
        r = _HTTP.get(f"https://gaana.com/search/{quote_plus(query)}", timeout=20)
        if r.status_code != 200:
            dbg(f"[Gaana] search page status {r.status_code}")
            return []
    except Exception as e:
        dbg(f"[Gaana] search page fetch failed: {e}")
        return []

    soup = BeautifulSoup(r.text, "html.parser")
    tracks, seen = [], set()
    for a in soup.select('a[href*="/song/"]'):
        href = a.get("href") or ""
        slug = href.split("/song/")[-1].strip("/").replace(".html", "")
        if not slug or "/" in slug or slug in seen:
            continue
        seen.add(slug)
        # Card anchors read "View details for <song>"; strip that lead-in.
        title = (a.get("title") or a.get("aria-label") or "").strip()
        title = re.sub(r"^View details for\s+", "", title, flags=re.I)
        tracks.append({
            "seokey": slug,
            "title": title or slug.replace("-", " ").title(),
        })
        if len(tracks) >= limit:
            break

    if not tracks:
        return []

    # Enrich concurrently — ~25 light HTML fetches finish in ~1-2s, still far
    # cheaper (and far more portable) than launching a browser.
    def enrich(t):
        try:
            meta = _gaana_song_page_meta(t["seokey"])
        except Exception:
            return t
        for k in ("artwork", "artist", "album", "duration"):
            if meta.get(k):
                t[k] = meta[k]
        if meta.get("title"):
            t["title"] = meta["title"]
        return t

    try:
        with ThreadPoolExecutor(max_workers=8) as ex:
            tracks = list(ex.map(enrich, tracks))
    except Exception as e:
        dbg(f"[Gaana] search enrichment failed: {e}")
    return tracks


def _gaana_search_playwright(query, limit=25):
    """Fallback search: render the Gaana search page and scrape song anchors."""
    from playwright.sync_api import sync_playwright

    tracks = []
    url = f"https://gaana.com/search/{quote_plus(query)}"
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=GAANA_LAUNCH_ARGS)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800},
            )
            context.route("**/*", _gaana_block_heavy)
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            try:
                page.wait_for_selector("a[href*='/song/']", timeout=12000)
            except Exception:
                pass
            page.wait_for_timeout(1500)

            raw = page.evaluate("""() => {
                const out = [];
                document.querySelectorAll("a[href*='/song/']").forEach(a => {
                    const img = a.querySelector('img') || (a.parentElement && a.parentElement.querySelector('img'));
                    out.push({
                        href: a.href,
                        title: (a.getAttribute('title') || a.textContent || '').trim(),
                        artwork: img ? (img.getAttribute('data-src') || img.src) : null,
                    });
                });
                return out;
            }""")

            seen = set()
            for it in raw:
                href = it.get("href") or ""
                if "/song/" not in href:
                    continue
                slug = href.split("/song/")[-1].rstrip("/").replace(".html", "")
                if not slug or slug in seen:
                    continue
                seen.add(slug)
                tracks.append({
                    "seokey": slug,
                    "title": it.get("title") or slug.replace("-", " ").title(),
                    "artwork": it.get("artwork"),
                })
                if len(tracks) >= limit:
                    break
        except Exception as e:
            dbg(f"[Gaana] Playwright search failed: {e}")
        finally:
            if 'browser' in locals():
                browser.close()
    return tracks


def get_gaana_search_json(query, limit=25):
    """Return Gaana search results shaped like the Pendujatt card structure."""
    results = {"songs": [], "albums": [], "artists": []}
    # HTTP-only on purpose: search runs in the same process as the Pendujatt
    # (Playwright) search, so launching a second Chromium here risks OOM-killing
    # the whole process on a small host — which would take Pendujatt's results
    # down with it. Gaana track playback still uses its own Playwright process.
    tracks = _gaana_search_http(query, limit)

    seen = set()
    for t in tracks:
        seokey = _gaana_seokey(t)
        if not seokey or seokey in seen:
            continue
        seen.add(seokey)
        raw_title = _gaana_pick(t, "title", "track_title", "name") or seokey.replace("-", " ").title()
        title = _clean_gaana_title(raw_title) or _clean_result_title(raw_title) or raw_title
        if len(title) < 2:
            continue
        results["songs"].append({
            "id": f"gaana__{seokey}",
            "title": title,
            "label": "Gaana",
            "poster": _gaana_artwork(t),
            "url": f"https://gaana.com/song/{seokey}",
            "source": "gaana",
            "artist": _gaana_artist_str(t),
        })
    return results


def _iso_duration_to_clock(iso):
    """Convert an ISO-8601 duration (e.g. PT3M45S) to m:ss. Returns 'N/A' on failure."""
    if not iso or not isinstance(iso, str):
        return "N/A"
    m = re.match(r'^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$', iso.strip(), re.IGNORECASE)
    if not m:
        return "N/A"
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    total = h * 3600 + mi * 60 + s
    if total <= 0:
        return "N/A"
    return f"{total // 60}:{total % 60:02d}"


def get_gaana_track_info_json(seokey):
    """
    Resolve a Gaana song's HLS (.m3u8) stream + metadata by rendering the song page
    with Playwright and intercepting the manifest request the player fires.
    Downloads are intentionally empty — Gaana tracks are play-only.
    """
    song_url = f"https://gaana.com/song/{seokey}"
    captured = {"m3u8": None}
    metadata = {
        "title": seokey.replace("-", " ").title(),
        "cover_image": None,
        "singer": "Unknown",
        "album": "Single",
        "composer": "Unknown",
        "starring": "N/A",
        "label": "Gaana",
        "duration": "N/A",
        "added_on": "N/A",
        "page_url": song_url,
    }

    def handle_request(request):
        try:
            u = request.url
        except Exception:
            return
        if ".m3u8" not in u.lower():
            return
        # Prefer a master/index manifest; otherwise keep the first .m3u8 seen.
        if captured["m3u8"] is None or "index.m3u8" in u.lower() or "master.m3u8" in u.lower():
            captured["m3u8"] = u

    # Metadata comes from the server-rendered page — no browser required. This
    # means a track still returns full details even if Chromium can't launch.
    http_meta = _gaana_song_page_meta(seokey)
    for key, field in (("title", "title"), ("artwork", "cover_image"),
                       ("artist", "singer"), ("album", "album"), ("duration", "duration")):
        if http_meta.get(key):
            metadata[field] = http_meta[key]
    if not metadata["cover_image"]:
        metadata["cover_image"] = GAANA_FALLBACK_POSTER

    launch_error = None

    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        dbg(f"[Gaana] Playwright unavailable: {e}")
        launch_error = f"Playwright is not installed: {e}"
        sync_playwright = None

    if sync_playwright is not None:
      with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=GAANA_LAUNCH_ARGS)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800},
            )
            # Block heavy resources to stay within the host's memory budget.
            # The manifest URL is still captured by handle_request (the request
            # event fires before the route abort), so blocking media is safe.
            context.route("**/*", _gaana_block_heavy)
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            page.on("request", handle_request)

            page.goto(song_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)

            # ── Scrape metadata: collect ALL JSON-LD blocks + og/meta tags ──
            try:
                scraped = page.evaluate("""() => {
                    const out = {};
                    out.ldTexts = Array.from(
                        document.querySelectorAll('script[type="application/ld+json"]')
                    ).map(s => s.textContent);
                    const og = (prop) => {
                        const el = document.querySelector(`meta[property="${prop}"]`)
                                || document.querySelector(`meta[name="${prop}"]`);
                        return el ? el.getAttribute('content') : null;
                    };
                    out.ogTitle   = og('og:title');
                    out.ogImage   = og('og:image');
                    out.ogDesc    = og('og:description');
                    out.metaDesc  = og('description');
                    out.pageTitle = document.title || null;
                    return out;
                }""")
            except Exception:
                scraped = {}
            if not isinstance(scraped, dict):
                scraped = {}

            # 1) Structured data (schema.org MusicRecording), if Gaana provides it
            ld = _find_music_ld(scraped.get("ldTexts"))
            if isinstance(ld, dict):
                if ld.get("name"):
                    metadata["title"] = _clean_gaana_title(ld["name"]) or ld["name"]
                img = ld.get("image")
                if isinstance(img, list) and img:
                    img = img[0]
                if isinstance(img, str) and img:
                    metadata["cover_image"] = img
                by = ld.get("byArtist")
                if isinstance(by, dict) and by.get("name"):
                    metadata["singer"] = by["name"]
                elif isinstance(by, list):
                    names = [b.get("name") for b in by if isinstance(b, dict) and b.get("name")]
                    if names:
                        metadata["singer"] = ", ".join(names)
                elif isinstance(by, str) and by.strip():
                    metadata["singer"] = by.strip()
                album = ld.get("inAlbum")
                if isinstance(album, dict) and album.get("name"):
                    metadata["album"] = album["name"]
                elif isinstance(album, str) and album.strip():
                    metadata["album"] = album.strip()
                dur = _iso_duration_to_clock(ld.get("duration"))
                if dur != "N/A":
                    metadata["duration"] = dur

            # 2) Description sentence — fills whatever structured data missed
            desc_fields = _parse_gaana_desc(scraped.get("ogDesc") or scraped.get("metaDesc"))
            if metadata["singer"] == "Unknown" and desc_fields.get("singer"):
                metadata["singer"] = desc_fields["singer"]
            if metadata["album"] == "Single" and desc_fields.get("album"):
                metadata["album"] = desc_fields["album"]
            if metadata["duration"] == "N/A" and desc_fields.get("duration"):
                metadata["duration"] = desc_fields["duration"]

            # 3) Title / cover fallbacks from Open Graph and <title>
            default_title = seokey.replace("-", " ").title()
            if metadata["title"] in (default_title, "", None):
                cleaned = _clean_gaana_title(scraped.get("ogTitle") or scraped.get("pageTitle") or "")
                if cleaned:
                    metadata["title"] = cleaned
            if not metadata["cover_image"] and scraped.get("ogImage"):
                metadata["cover_image"] = scraped["ogImage"]
            if not metadata["cover_image"]:
                metadata["cover_image"] = GAANA_FALLBACK_POSTER

            # ── Nudge the player so the HLS manifest request fires ──
            play_selectors = [
                "span.playPause", ".playIcon", ".play_c", "[data-value='play']",
                "button[aria-label='Play']", "[title='Play']", ".s_play", ".playCta",
            ]
            for sel in play_selectors:
                if captured["m3u8"]:
                    break
                try:
                    el = page.locator(sel).first
                    if el.count() and el.is_visible():
                        el.click(force=True, timeout=2000)
                        page.wait_for_timeout(1200)
                except Exception:
                    continue

            # ── Wait for the manifest to be requested ──
            for _ in range(60):
                if captured["m3u8"]:
                    break
                page.wait_for_timeout(250)

        except Exception as e:
            dbg(f"[Gaana] track extraction error: {e}")
            launch_error = str(e)
        finally:
            if 'browser' in locals():
                browser.close()

    stream_url = captured["m3u8"]
    # Surface the underlying reason rather than a generic failure — a browser that
    # can't start (missing binary or system libs on the host) looks identical to a
    # site change from the client's side otherwise.
    error = None
    if not stream_url:
        error = "Could not resolve Gaana stream manifest."
        if launch_error:
            error += f" (browser: {launch_error})"
    return {
        "success": bool(stream_url),
        "stream_url": stream_url,
        "downloads": {},          # Gaana is play-only — no downloadable file
        "metadata": metadata,
        "source": "gaana",
        "error": error,
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        flag = sys.argv[1]
        
        if flag == "--homepage":
            print(json.dumps(get_pendujatt_homepage_playwright()))
            sys.exit(0)
        elif flag == "--search":
            if len(sys.argv) < 3: sys.exit(1)
            query = sys.argv[2]
            # Pendujatt is the primary source; Gaana results are merged in.
            merged = get_pendujatt_search_json(query)
            merged.setdefault("songs", [])
            merged.setdefault("albums", [])
            merged.setdefault("artists", [])
            try:
                gaana = get_gaana_search_json(query)
                # Interleave the two song lists so Gaana tracks stay visible
                # instead of being buried after a long Pendujatt list.
                pj = merged["songs"]
                gn = gaana.get("songs", [])
                interleaved = []
                for i in range(max(len(pj), len(gn))):
                    if i < len(pj): interleaved.append(pj[i])
                    if i < len(gn): interleaved.append(gn[i])
                merged["songs"] = interleaved
            except Exception as e:
                dbg(f"[Gaana] merge into search failed: {e}")
            print(json.dumps(merged))
            sys.exit(0)
        elif flag == "--singer":
            if len(sys.argv) < 3: sys.exit(1)
            singer_results = get_pendujatt_search_json(sys.argv[2])
            print(json.dumps({"songs": singer_results.get("songs", [])}))
            sys.exit(0)
        elif flag == "--track":
            if len(sys.argv) < 3: sys.exit(1)
            track_id = sys.argv[2]
            # Accept both the new "gaana__" namespace and the legacy "gaana:" one
            # (older cached ids) so a stale client id still resolves.
            if track_id.startswith("gaana__") or track_id.startswith("gaana:"):
                seokey = track_id.split("__", 1)[-1] if "__" in track_id else track_id.split(":", 1)[-1]
                print(json.dumps(get_gaana_track_info_json(seokey)))
            else:
                print(json.dumps(get_pendujatt_track_info_json(track_id)))
            sys.exit(0)
            
        target = flag
    else:
        target = "https://pendujatt.com.se/"
    
    if "pendujatt.com" in target or not target.startswith("http"):
        if target.strip().rstrip("/") in ["https://pendujatt.com.se", "http://pendujatt.com.se"]:
            print(json.dumps(get_clean_stream(target)))
            sys.exit(0)
            
        extraction_result = get_clean_stream(target)
        stream_url, metadata = extraction_result if isinstance(extraction_result, tuple) else (extraction_result, None)
        
        if stream_url:
            stream_url = stream_url.replace(" ", "%20")
            print(f"\n[RESOLVED SERVER PATH]: {stream_url}")
            sys.exit(0)
        else:
            print("Error: Extraction target resource not found.", file=sys.stderr)
            sys.exit(1)
    else:
        stream_url = get_clean_stream(target)
        if stream_url:
            print(stream_url.strip())
            sys.exit(0)
        else:
            print("Error: Stream extraction timed out.", file=sys.stderr)
            sys.exit(1)
