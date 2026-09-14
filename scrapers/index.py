"""
BCCI / IPL / FIFA / MX Player stream extractor
─────────────────────────────────────────────
Strategy:
  BCCI & IPL → Pure HTTP via Page Data Engine (no browser, fast)
  StayLive   → SEO endpoint, then the Mux manifest it names
  FIFA       → Playwright forced headless=True (required for PBS token)
  MX Player  → Playwright; reads the SSR state, else clicks Play and captures
               the manifest the app itself fetches
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

# Real policy key, read from the account's own Brightcove player bundle. The
# value that used to live here was a placeholder and every Playback API call
# returned 401 INVALID_POLICY_KEY, so cricket video could never resolve.
FALLBACK_POLICY_KEY = (
    "BCpkADawqM1HAZVeYx6iS1Oqr12hCyvC8IGQSuDaTfRbJK_pYnfZoexbte9KOmx0moKY"
    "-9kcDMp-YPmJaBTdmZi_SYqnWJs-qANYeAOvpjncLe86hNPaG5XEdSCTTFk-ktvWxZhbK4Yel9UX"
)

# Brightcove rotates policy keys, so re-read it from the player bundle if the
# baked-in one is ever rejected. Cached per process — it never changes mid-run.
BC_PLAYER_JS = f"https://players.brightcove.net/{BC_ACCOUNT_ID}/default_default/index.min.js"
_policy_key_cache = {}


def _brightcove_live_policy_key():
    """Fetch the current policy key from the account's default player bundle."""
    if "key" in _policy_key_cache:
        return _policy_key_cache["key"]
    try:
        r = _HTTP.get(BC_PLAYER_JS, timeout=20)
        if r.status_code == 200:
            m = re.search(r"BCpk[A-Za-z0-9_\-\.]{40,}", r.text)
            if m:
                _policy_key_cache["key"] = m.group(0)
                dbg("[brightcove] refreshed policy key from player bundle")
                return m.group(0)
    except Exception as e:
        dbg("[brightcove] policy key refresh failed:", e)
    _policy_key_cache["key"] = None
    return None

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

        # A rejected key is recoverable: pull the current one and retry once.
        if r.status_code in (401, 403):
            live = _brightcove_live_policy_key()
            if live and live != policy_key:
                r = _HTTP.get(url, headers={"Accept": f"application/json;pk={live}"}, timeout=15)
                dbg(f"brightcove_api retry with live key status={r.status_code}")

        if r.status_code == 200:
            data = r.json()
            sources = data.get("sources", [])

            masters, renditions = [], []
            for src in sources:
                href = src.get("src", "")
                if "master.m3u8" in href and "rendition" not in href:
                    masters.append(href)
                elif "rendition.m3u8" in href:
                    renditions.append(href)

            # Brightcove lists each manifest under both http and https. The player
            # runs on an https page, so an http source is blocked as mixed content.
            for group, label in ((masters, "master"), (renditions, "rendition")):
                if not group:
                    continue
                secure = [h for h in group if h.startswith("https://")]
                chosen = (secure or group)[0]
                if label == "rendition":
                    dbg("Master index absent. Falling back to active rendition track.")
                return chosen

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
# STAYLIVE — IPL video (pure HTTP, no browser)
# ─────────────────────────────────────────────────────────────────────────
# IPL video no longer runs on Brightcove: iplt20.com/video is a StayLive SPA
# now, so the Brightcove path here can never resolve it. StayLive's own API
# hands back a ready-to-play Mux HLS URL, so this needs no browser at all.
#
# The Mux token is short-lived (~24h), so always resolve fresh — never cache
# the playback_url itself.

def _staylive_seo(target_url):
    """Pull the video's seo_string out of any StayLive URL shape."""
    m = re.search(r"/videos?/([A-Za-z0-9\-_]+)", target_url)
    if m:
        return m.group(1)
    # Bare seo_string (e.g. "s-ipl-2026-final-rcb-vs-gt-match-highlights-o1hffe")
    slug = target_url.rstrip("/").split("/")[-1].split("?")[0]
    return slug or None


def get_staylive_stream(target_url):
    """Resolve a StayLive video to its Mux .m3u8 playback URL over plain HTTP."""
    seo = _staylive_seo(target_url)
    if not seo:
        dbg("[StayLive] could not parse a seo_string from:", target_url)
        return None

    api = f"https://api.staylive.tv/videos/{seo}"
    try:
        r = _HTTP.get(api, headers={"Accept": "application/json"}, timeout=20)
        dbg(f"[StayLive] {api} -> {r.status_code}")
        if r.status_code != 200:
            return None
        msg = (r.json() or {}).get("message") or {}
    except Exception as e:
        dbg("[StayLive] api fetch failed:", e)
        return None

    # StayLive geo-fences some titles; the host's country decides this, so it can
    # pass locally and fail from a datacenter. Say so rather than looking generic.
    geo = msg.get("geo_restricted") or {}
    if geo and geo.get("allowed") is False:
        dbg(f"[StayLive] geo-blocked from this host (country={geo.get('currentCountry')})")
        return None

    playback = msg.get("playback_url")
    if not playback:
        dbg("[StayLive] response carried no playback_url")
        return None
    dbg(f"[StayLive] resolved '{msg.get('name')}' ({msg.get('duration')})")
    return playback


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
    
    if "staylive.tv" in target_lower:
        return get_staylive_stream(target_url)

    # A Mux URL is already the manifest — but its token expires in ~24h, so this
    # only helps a fresh one. Prefer passing the StayLive URL and resolving live.
    elif "stream.mux.com" in target_lower:
        return target_url

    elif "bcci.tv" in target_lower:
        domain_info = {"label": "BCCI", "origin": "https://www.bcci.tv", "referer": "https://www.bcci.tv/"}
        return get_cricket_stream_http(target_url, domain_info)

    elif "iplt20.com" in target_lower:
        # iplt20.com/video is a StayLive SPA now; the Brightcove path below is
        # kept only for legacy links that still carry a Brightcove video id.
        domain_info = {"label": "IPL", "origin": "https://www.iplt20.com", "referer": "https://www.iplt20.com/"}
        return get_cricket_stream_http(target_url, domain_info)
        
    else:
        return get_fifa_stream_playwright(target_url)

# ──────────────────────────────────────────────────────────────────────────
# MX Player manifest resolver (Playwright, like the cricket flows)
# ──────────────────────────────────────────────────────────────────────────
# MX serves the stream URL only to residential Indian IPs AND only to a real
# browser carrying its x-guard-key token. This loads the watch page in a real
# Chromium, reads the SSR state, and (crucially, for the case where the page
# comes back as an empty shell) clicks Play to force the app's own manifest
# fetch — then captures the .m3u8 / detail/video the browser produces.
MX_CDN = "https://d3sgzbosmwirao.cloudfront.net/"
MX_WORKER = "https://silent-scene-b9bb.sanjusanjay0444.workers.dev"

def resolve_mx_manifest(web_url):
    from playwright.sync_api import sync_playwright
    launch_args = [
        "--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-gpu",
        "--mute-audio", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required",
        "--disable-features=IsolateOrigins,site-per-process",
    ]
    hits = {"m3u8": None, "hls_path": None, "title": None}
    diag = {"mxs": False, "api_calls": [], "detail_status": None, "detail_has_stream": None, "detail_snippet": None}

    def take_hls(path):
        if path and not hits["hls_path"]:
            hits["hls_path"] = path

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=launch_args)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")

        def on_request(r):
            u = r.url
            if ".m3u8" in u and not hits["m3u8"]:
                hits["m3u8"] = u              # the real manifest the player loaded
            if "api.mxplayer.in/v1/" in u and len(diag["api_calls"]) < 25:
                diag["api_calls"].append(u.split("api.mxplayer.in/v1/web/")[-1].split("?")[0][:60])
        def on_response(r):
            if "detail/video" in r.url:        # the app's own fetch (carries guard token)
                try:
                    diag["detail_status"] = r.status
                    body = r.text()
                    diag["detail_snippet"] = diag["detail_snippet"] or body[:120]
                    d = json.loads(body)
                    diag["detail_has_stream"] = bool((((d or {}).get("stream") or {}).get("hls") or {}).get("high"))
                    hits["title"] = hits["title"] or (d or {}).get("title")
                    take_hls((((d or {}).get("stream") or {}).get("hls") or {}).get("high"))
                except Exception:
                    pass
        page.on("request", on_request)
        page.on("response", on_response)

        # Boot the SPA on the homepage first (sets device cookies + guard token),
        # THEN navigate to the target so its client-side detail/video fetch fires
        # even when the SSR page comes back as a datacenter shell.
        try:
            page.goto("https://www.mxplayer.in/", wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)
        except Exception as e:
            dbg(f"[MX] home nav: {e}")
        try:
            page.goto(web_url, wait_until="networkidle", timeout=60000)
        except Exception as e:
            dbg(f"[MX] nav: {e}")
        page.wait_for_timeout(3000)

        # Fast path: the SSR state (residential full page) already holds the stream.
        try:
            mxs = page.evaluate("() => window.__mxs__ ? JSON.stringify(window.__mxs__) : null")
            if mxs:
                diag["mxs"] = True
                d = json.loads(mxs)
                ents = d.get("entities") or {}
                m = re.search(r"-([0-9a-f]{24,})(?:$|[/?])", web_url)
                item = (ents.get(m.group(1)) if m else None) or next(
                    (v for v in ents.values() if isinstance(v, dict) and v.get("title") and v.get("type")), None)
                if item:
                    hits["title"] = hits["title"] or item.get("title")
                    take_hls((((item.get("stream") or {}).get("hls") or {}).get("high")))
        except Exception as e:
            dbg(f"[MX] mxs read: {e}")

        # If we still have no stream (e.g. datacenter shell), force the player to
        # fetch it: click the big Play control and wait for the manifest request.
        if not (hits["m3u8"] or hits["hls_path"]):
            for sel in ['button:has-text("Play")', '[data-testid*="play" i]',
                        'button[aria-label*="play" i]', '.player-play', 'video']:
                try:
                    el = page.query_selector(sel)
                    if el:
                        el.click(timeout=2000)
                        page.wait_for_timeout(3500)
                        if hits["m3u8"] or hits["hls_path"]:
                            break
                except Exception:
                    pass
            page.wait_for_timeout(2500)

        browser.close()

    manifest = hits["m3u8"] or (MX_CDN + hits["hls_path"] if hits["hls_path"] else None)
    if not manifest:
        return {"success": False, "error": "No manifest captured", "diag": diag}
    return {
        "success": True,
        "title": hits["title"],
        "manifest": manifest,
        # Path ends in .m3u8 so the StreamX player detects HLS (it strips the query
        # for type detection); the worker ignores the path and reads ?url=.
        "playUrl": f"{MX_WORKER}/hls/index.m3u8?url={quote_plus(manifest)}",
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        flag = sys.argv[1]

        if flag == "--mx":
            if len(sys.argv) < 3:
                print(json.dumps({"success": False, "error": "Missing MX web url"})); sys.exit(1)
            print(json.dumps(resolve_mx_manifest(sys.argv[2])))
            sys.exit(0)

        target = flag
    else:
        print("Error: pass a stream url, or --mx <url>.", file=sys.stderr)
        sys.exit(1)

    stream_url = get_clean_stream(target)
    if stream_url:
        print(stream_url.strip() if isinstance(stream_url, str) else json.dumps(stream_url))
        sys.exit(0)
    else:
        print("Error: Stream extraction timed out.", file=sys.stderr)
        sys.exit(1)
