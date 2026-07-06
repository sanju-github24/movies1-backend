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
from urllib.parse import quote_plus

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
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
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
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
# Playwright-Assisted Interactivity & Dynamic CSE Search Engine
# ─────────────────────────────────────────────────────────────────────────

def parse_and_select_pendujatt(html_content, current_url):
    """
    Parses artist, album, and song links from Pendujatt dynamically by tying
    anchor nodes together with their true visible text labels and thumbnails.
    """
    raw_links = re.findall(r'<a[^>]*?href=["\']((?:https://pendujatt\.com\.se)?/(?:song|album|artist)/[^"\'>\s]+)["\'][^>]*>(.*?)</a>', html_content, re.IGNORECASE | re.DOTALL)
    
    seen = set()
    unique_artists = []
    unique_albums = []
    unique_songs = []

    global_artist_poster = "No Artist Poster Available"
    artist_poster_match = re.search(r'src=["\']((?:https://[^"\']*?pendujatt\.com\.se)?/artist/[^"\']+?\.(?:jpg|jpeg|png))["\']', html_content, re.IGNORECASE)
    if artist_poster_match:
        global_artist_poster = artist_poster_match.group(1)

    for path, inner_html in raw_links:
        full_url = path if path.startswith("http") else "https://pendujatt.com.se" + path
        if full_url in seen:
            continue
            
        poster_url = global_artist_poster

        clean_title = re.sub(r'<[^>]*>', '', inner_html).strip()
        clean_title = clean_title.replace("Mp3 Song Download | PendJatt.Com.Se", "")
        clean_title = clean_title.replace("Mp3 Song Download", "")
        clean_title = clean_title.replace("Songs Download -", "").replace("All Mp3 Songs", "").strip()
        
        if not clean_title or len(clean_title) < 3:
            clean_title = full_url.split("/")[-1].replace("-", " ").replace(".html", "").title()

        seen.add(full_url)
        url_lower = full_url.lower()

        if "/artist/" in url_lower:
            if "artist/" not in current_url.lower():
                unique_artists.append((full_url, "artist", clean_title, poster_url))
        elif "/album/" in url_lower:
            if "album/" not in current_url.lower() and "artist/" not in current_url.lower():
                unique_albums.append((full_url, "album", clean_title, poster_url))
        elif "/song/" in url_lower:
            unique_songs.append((full_url, "song", clean_title, poster_url))

    print("\n=========================================")
    print("         PENDUJATT SELECTION MENU        ")
    print("=========================================")

    master_options = []

    if unique_artists:
        print("\n--- ARTISTS FOUND ---")
        for full_url, item_type, title, poster in unique_artists:
            master_options.append((full_url, item_type))
            print(f"[{len(master_options)}] (Artist) {title}")

    if unique_albums:
        print("\n--- ALBUMS FOUND ---")
        for full_url, item_type, title, poster in unique_albums:
            master_options.append((full_url, item_type))
            print(f"[{len(master_options)}] (Album) {title}")

    if unique_songs:
        print("\n--- TRACKS LIST ---")
        for full_url, item_type, title, poster in unique_songs:
            master_options.append((full_url, item_type))
            print(f"[{len(master_options)}] (Song) {title}")

    print("=========================================")

    if not master_options:
        return None

    while True:
        try:
            choice = input(f"\nSelect a numeric choice (1-{len(master_options)}) or 'q' to quit: ").strip()
            if choice.lower() == 'q':
                sys.exit(0)
            choice_idx = int(choice) - 1
            if 0 <= choice_idx < len(master_options):
                return master_options[choice_idx]
            else:
                print(f"Invalid range. Choose between 1 and {len(master_options)}.")
        except ValueError:
            print("Please provide a valid numeric selection.")


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
        
    # Fallback to standard 320/128 extraction if no results were matched
    if not results:
        fallback = extract_pendujatt_download_link(html_tree)
        if fallback:
            results["320kbps"] = fallback
            
    return results


def get_pendujatt_download(target_or_query):
    """Headless Playwright interaction matrix resolving async search layouts, artists, and tracks."""
    from playwright.sync_api import sync_playwright

    url = target_or_query
    is_listing_hub = False
    
    if not url.startswith("http"):
        dbg(f"[Pendujatt] Processing search request: {target_or_query}")
        url = f"https://pendujatt.com.se/search.php?q={quote_plus(target_or_query)}#gsc.tab=0&gsc.q={quote_plus(target_or_query)}&gsc.page=1"
        is_listing_hub = True
    elif "search.php" in url or "/album/" in url or "/artist/" in url:
        is_listing_hub = True

    # FAST-PATH BYPASS: Direct song link bypass executed via rapid pure HTTP
    if not is_listing_hub and "/song/" in url:
        try:
            dbg("[Pendujatt] Fast track direct URL detected. Running pure HTTP engine...")
            html = _fetch_page(url)
            resolved = extract_pendujatt_download_link(html)
            if resolved:
                details = get_pendujatt_song_details(html, url)
                if details:
                    print("\n--- METADATA TRACK DETAILS ---")
                    print(json.dumps(details, indent=4))
                    print("------------------------------")
                return (resolved, details)
        except Exception as e:
            dbg(f"Direct fast path fallback failed: {e}")

    # SLOW-PATH: Load browser to parse listing hubs (search grids, albums, or artist track lists)
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
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            
            dbg(f"[Pendujatt] Initializing layout navigation: {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            
            if "search.php" in page.url:
                page.wait_for_selector(".gs-title, a.gs-title, a.gs-image", timeout=10000)
                page.wait_for_timeout(1500)
            elif "/artist/" in page.url or "/album/" in page.url:
                page.wait_for_timeout(1000)

            while "search.php" in page.url or "/album/" in page.url or "/artist/" in page.url:
                html_content = page.content()
                selection = parse_and_select_pendujatt(html_content, page.url)
                
                if not selection:
                    print("Error: No valid elements discovered inside current menu view layer.")
                    browser.close()
                    return None
                    
                chosen_url, item_type = selection
                dbg(f"[Pendujatt] Branching browser location route to: {chosen_url} ({item_type})")
                page.goto(chosen_url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(1500)
                
                if item_type == "song":
                    break

            full_dom_html = page.content()
            resolved_url = extract_pendujatt_download_link(full_dom_html)
            details = get_pendujatt_song_details(full_dom_html, page.url)
            
            if resolved_url:
                resolved_tuple = (resolved_url, details)
                if details:
                    print("\n--- METADATA TRACK DETAILS ---")
                    print(json.dumps(details, indent=4))
                    print("------------------------------")

        except Exception as e:
            dbg(f"[Pendujatt] Playwright engine runtime error: {e}")
        finally:
            if 'browser' in locals():
                browser.close()

    return resolved_tuple


def get_pendujatt_song_details(html, song_url):
    """Parses metadata cleanly using descriptive elements from the layout."""
    try:
        cover_match = re.search(r'property="og:image"\s+content=["\']([^"\']+)["\']', html)
        cover_url = cover_match.group(1) if cover_match else None

        # Extract details from table
        rows = re.findall(r'<td class="td1">\s*(.*?)\s*</td>\s*<td>\s*(.*?)\s*</td>', html, re.IGNORECASE | re.DOTALL)
        table_data = {}
        for k, v in rows:
            clean_k = re.sub(r'<[^>]*>', '', k).strip().lower()
            clean_v = re.sub(r'<[^>]*>', '', v).strip()
            table_data[clean_k] = clean_v

        # Extract description paragraph
        description_text = ""
        paragraphs = re.findall(r'<p[^>]*?>(.*?)</p>', html, re.IGNORECASE | re.DOTALL)
        for p in paragraphs:
            clean_p = re.sub(r'<[^>]*>', '', p).strip()
            if 'sung by' in clean_p or 'composed By' in clean_p:
                description_text = clean_p
                break

        # Song title / name
        title = table_data.get("song name")
        if not title:
            title_match = re.search(r'<title>([^<]+)</title>', html)
            title = title_match.group(1).split(" - ")[0].strip() if title_match else "Unknown"
            for suffix in ["Mp3 Song Download", "PendJatt.Com.Se", "PendJatt", "Mp3 Song", "Download"]:
                title = re.sub(rf'\b{suffix}\b', '', title, flags=re.IGNORECASE).strip()
            title = re.sub(r'\s+', ' ', title).strip()

        # Singer
        singer = table_data.get("singer")
        if not singer:
            singer_match = re.search(r'sung by\s+([^,|\n.]+)', description_text, re.IGNORECASE)
            singer = singer_match.group(1).strip() if singer_match else "Unknown"

        # Album
        album = table_data.get("album")
        if not album:
            album_match = re.search(r'From\s+["\']([^"\']+)["\']', description_text, re.IGNORECASE)
            album = album_match.group(1).strip() if album_match else "Single"

        # Composer / Music Director
        composer = "Unknown"
        composer_match = re.search(r'composed By\s+([^,|\n.]+)', description_text, re.IGNORECASE)
        if composer_match:
            composer = composer_match.group(1).strip()
            if ' and ' in composer.lower():
                parts = re.split(r'\s+and\s+', composer, flags=re.IGNORECASE)
                truncated = []
                for p in parts:
                    if any(k in p.lower() for k in ['lyrics', 'written', 'music']):
                        break
                    truncated.append(p)
                composer = ' and '.join(truncated).strip()

        # Starring / Lyricist
        starring = "N/A"
        starring_match = re.search(r'Lyrics written by\s+([^,|\n.]+)', description_text, re.IGNORECASE)
        if starring_match:
            starring = starring_match.group(1).strip()

        return {
            "title": title,
            "cover_image": cover_url,
            "singer": singer,
            "album": album,
            "composer": composer,
            "starring": starring,
            "label": table_data.get("label", "N/A"),
            "duration": table_data.get("duration", "N/A"),
            "added_on": table_data.get("added on", "N/A"),
            "page_url": song_url
        }
    except Exception:
        return None


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
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0.0.0 Safari/537.36"
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
# Core Routing Hub Entry Point
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


def get_pendujatt_search_json(query):
    """Launches Playwright headless browser to run search or listing parse, and returns a dictionary of match objects."""
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
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            page = context.new_page()
            page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            page = context.new_page()
            
            dbg(f"[Pendujatt] Navigating search/listing URL: {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            
            if is_direct_listing:
                page.wait_for_timeout(1000)
                html_content = page.content()
                
                default_poster = None
                cover_match = re.search(r'property="og:image"\s+content=["\']([^"\']+)["\']', html_content)
                if cover_match:
                    default_poster = cover_match.group(1)
                
                if not default_poster:
                    cover_class_match = re.search(r'<img[^>]*?class=["\']cover[^"\']*?["\'][^>]*?src=["\']([^"\']+)["\']', html_content, re.IGNORECASE)
                    if cover_class_match:
                        default_poster = cover_class_match.group(1)
                
                if not default_poster:
                    img_srcs = re.findall(r'<img[^>]*?src=["\']([^"\']+)["\']', html_content, re.IGNORECASE)
                    for src in img_srcs:
                        if "/uploads/album/" in src or "/uploads/artist/" in src:
                            if "/static/load.png" not in src:
                                default_poster = src
                                break
                                
                if not default_poster:
                    default_poster = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=150&q=80"
                
                results["metadata"] = {"poster": default_poster}
                
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(html_content, 'html.parser')
                
                # Check for .song-list divs (typical of artist page)
                song_list_divs = soup.find_all(class_='song-list')
                if song_list_divs:
                    for div in song_list_divs:
                        link = div.find('a', href=True)
                        if not link:
                            continue
                        href = link['href']
                        if '/song/' not in href:
                            continue
                        slug = href.split('/song/')[-1].replace('.html', '')
                        
                        # Find title
                        title_el = div.find(class_='songname')
                        title = title_el.text.strip() if title_el else ""
                        if not title:
                            img = div.find('img')
                            title = img.get('alt', '').replace(' mp3 song', '').strip() if img else slug.replace('-', ' ').title()
                            
                        # Find poster image specific to this song
                        img = div.find('img')
                        poster = None
                        if img:
                            poster = img.get('data-src') or img.get('src')
                            if poster == '/static/load.png':
                                poster = img.get('data-src')
                        if not poster or poster.startswith('/'):
                            poster = default_poster
                            
                        results["songs"].append({
                            "id": slug,
                            "title": title,
                            "label": "Mp3 Song",
                            "poster": poster,
                            "url": href if href.startswith("http") else "https://pendujatt.com.se" + href
                        })
                else:
                    # Fallback to generic link parsing (typical of album page or generic listings)
                    song_matches = re.findall(r'href=["\']((?:https://pendujatt\.com\.se)?/song/([^"\'>\s]+))["\'][^>]*>(.*?)</a>', html_content, re.IGNORECASE | re.DOTALL)
                    seen_songs = set()
                    for full_path, slug, inner_html in song_matches:
                        full_url = full_path if full_path.startswith("http") else "https://pendujatt.com.se" + full_path
                        if full_url in seen_songs:
                            continue
                        seen_songs.add(full_url)
                        
                        clean_title = re.sub(r'<[^>]*>', '', inner_html).strip()
                        for suffix in [
                            "Mp3 Song Download | PendJatt.Com.Se",
                            "Mp3 Song Download",
                            "Mp3 Songs Download - PendJatt.Com.Se",
                            "Songs Download -",
                            "All Mp3 Songs"
                        ]:
                            clean_title = clean_title.replace(suffix, "")
                        clean_title = re.sub(r'\s+', ' ', clean_title).strip()
                        if not clean_title or len(clean_title) < 2:
                            clean_title = slug.replace("-", " ").title()
                            
                        results["songs"].append({
                            "id": slug,
                            "title": clean_title,
                            "label": "Mp3 Song",
                            "poster": default_poster,
                            "url": full_url
                        })
            else:
                # ── Collect all paginated results ──────────────────────────────
                def scrape_page_items(pg):
                    """Scrape all result items from the current loaded page."""
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
                    """Deduplicate and categorize items into results dict."""
                    for item in raw_items:
                        full_url = item.get("url", "")
                        if not full_url or full_url in seen:
                            continue
                        seen.add(full_url)

                        title = item.get("title", "")
                        for suffix in [
                            "Mp3 Song Download | PendJatt.Com.Se",
                            "Mp3 Song Download",
                            "Mp3 Songs Download - PendJatt.Com.Se",
                            "Songs Download -",
                            "All Mp3 Songs"
                        ]:
                            title = title.replace(suffix, "")
                        title = re.sub(r'<[^>]*>', '', title).strip()
                        title = re.sub(r'\s+', ' ', title).strip()

                        poster = item.get("poster") or "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=150&q=80"
                        url_lower = full_url.lower()

                        if "/artist/" in url_lower:
                            slug = full_url.split("/artist/")[-1].replace(".html", "")
                            results["artists"].append({"id": slug, "title": title, "poster": poster, "url": full_url})
                        elif "/album/" in url_lower:
                            slug = full_url.split("/album/")[-1].replace(".html", "")
                            results["albums"].append({"id": slug, "title": title, "poster": poster, "url": full_url})
                        elif "/song/" in url_lower:
                            slug = full_url.split("/song/")[-1].replace(".html", "")
                            results["songs"].append({"id": slug, "title": title, "label": "Mp3 Song", "poster": poster, "url": full_url})

                # Wait for first page to load
                try:
                    page.wait_for_selector(".gs-title, a.gs-title, a.gs-image", timeout=10000)
                except Exception:
                    pass
                page.wait_for_timeout(1500)

                seen = set()

                # Scrape page 1
                raw_items = scrape_page_items(page)
                process_items(raw_items, seen, results)

                # Find total number of pagination pages (max 10 from CSE)
                total_pages = page.evaluate("""() => {
                    const pages = document.querySelectorAll('.gsc-cursor-page');
                    return pages.length;
                }""")

                dbg(f"[Search] Found {total_pages} pages of results")

                # Paginate remaining pages by navigating directly to each page URL
                encoded_q = quote_plus(query)
                for pg_num in range(2, min(total_pages + 1, 11)):
                    try:
                        page_url = f"https://pendujatt.com.se/search.php?q={encoded_q}#gsc.tab=0&gsc.q={encoded_q}&gsc.page={pg_num}"
                        page.goto(page_url, wait_until="domcontentloaded", timeout=20000)
                        try:
                            page.wait_for_selector(".gs-title, a.gs-title", timeout=8000)
                        except Exception:
                            break  # no more results
                        page.wait_for_timeout(1000)
                        raw_items = scrape_page_items(page)
                        if not raw_items:
                            break
                        process_items(raw_items, seen, results)
                    except Exception as e:
                        dbg(f"[Search] Page {pg_num} error: {e}")
                        break

        except Exception as e:
            dbg(f"Search error: {e}")
        finally:
            if 'browser' in locals():
                browser.close()
    return results


def get_pendujatt_track_info_json(id_or_url):
    """Fetches direct download/stream link and metadata for a song slug or URL without prompt or browser when possible."""
    if not id_or_url.startswith("http"):
        url = f"https://pendujatt.com.se/song/{id_or_url}"
    else:
        url = id_or_url
        
    try:
        html = _fetch_page(url)
        downloads = extract_all_pendujatt_download_links(html)
        
        stream_url = None
        for br in ["320kbps", "192kbps", "128kbps", "96kbps", "48kbps"]:
            if br in downloads:
                stream_url = downloads[br]
                break
        if not stream_url and downloads:
            stream_url = list(downloads.values())[0]
            
        details = get_pendujatt_song_details(html, url)
        return {
            "success": True if downloads else False,
            "stream_url": stream_url,
            "downloads": downloads,
            "metadata": details
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        flag = sys.argv[1]
        
        if flag == "--homepage":
            homepage_data = get_pendujatt_homepage_playwright()
            print(json.dumps(homepage_data))
            sys.exit(0)
            
        elif flag == "--search":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing search query"}))
                sys.exit(1)
            query = sys.argv[2]
            search_results = get_pendujatt_search_json(query)
            print(json.dumps(search_results))
            sys.exit(0)

        elif flag == "--singer":
            # Returns songs list for a given singer name (used for recommendations)
            if len(sys.argv) < 3:
                print(json.dumps({"songs": [], "error": "Missing singer name"}))
                sys.exit(1)
            singer_name = sys.argv[2]
            singer_results = get_pendujatt_search_json(singer_name)
            # Return only songs (no albums/artists noise) for clean recommendations
            print(json.dumps({"songs": singer_results.get("songs", [])}))
            sys.exit(0)
            
        elif flag == "--track":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing track ID or URL"}))
                sys.exit(1)
            track_id = sys.argv[2]
            track_info = get_pendujatt_track_info_json(track_id)
            print(json.dumps(track_info))
            sys.exit(0)
            
        # Fallback to standard flow if the argument is a URL or query for manual run
        target = flag
    else:
        target = "https://pendujatt.com.se/"
    
    # Check if target is a Pendujatt URL or local track request
    if "pendujatt.com" in target or not target.startswith("http"):
        if target.strip().rstrip("/") in ["https://pendujatt.com.se", "http://pendujatt.com.se"]:
            homepage_data = get_clean_stream(target)
            print(json.dumps(homepage_data))
            sys.exit(0)
            
        extraction_result = get_clean_stream(target)
        
        if isinstance(extraction_result, tuple):
            stream_url, metadata = extraction_result
        else:
            stream_url, metadata = extraction_result, None
        
        if stream_url:
            stream_url = stream_url.replace(" ", "%20")
            print(f"\n[RESOLVED SERVER PATH]: {stream_url}")
            
            if metadata and metadata.get("title"):
                clean_name = re.sub(r'[^a-zA-Z0-9\s\-_\(\)]', '', metadata["title"]).strip()
                clean_name = re.sub(r'\s+', ' ', clean_name)
                local_filename = f"{clean_name}.mp3"
            else:
                local_filename = "Song.mp3"
                
            download_choice = input(f"\nWould you like to download this file locally as '{local_filename}'? (y/n): ").strip().lower()
            if download_choice == 'y':
                try:
                    print("Initializing clean file retrieval track...")
                    response = _HTTP.get(stream_url, stream=True, timeout=60)
                    response.raise_for_status()
                    
                    with open(local_filename, 'wb') as music_file:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk: music_file.write(chunk)
                                
                    print(f"✔️ Success! File saved locally in your workspace as: '{local_filename}'")
                    sys.exit(0)
                except Exception as download_error:
                    print(f"❌ Local storage retrieval engine failed: {download_error}", file=sys.stderr)
                    sys.exit(1)
        else:
            print("Error: Extraction target resource not found or timed out.", file=sys.stderr)
            sys.exit(1)
    else:
        # Standard BCCI / IPL / FIFA stream flow - print ONLY the clean stream URL
        stream_url = get_clean_stream(target)
        if stream_url:
            print(stream_url.strip())
            sys.exit(0)
        else:
            print("Error: Stream extraction timed out.", file=sys.stderr)
            sys.exit(1)
