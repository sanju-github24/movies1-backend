"""
BCCI / IPL / FIFA m3u8 stream extractor
───────────────────────────────────────
Strategy:
  BCCI & IPL → Pure HTTP via Page Data Engine (no browser, fast, bulletproof)
  FIFA       → Playwright forced headless=True  (required for PBS token)
"""

import sys
import re
import json
import requests

DEBUG = True  # set False to silence diagnostics

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

def _fetch_page(target_url, domain_info):
    """Return HTML of the video page directly, setting appropriate context headers."""
    headers = {
        "Origin": domain_info["origin"],
        "Referer": domain_info["referer"]
    }
    r = _HTTP.get(target_url, headers=headers, timeout=20)
    dbg(f"[{domain_info['label']}] page fetch status:", r.status_code, "len:", len(r.text))
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
        domain_info = {
            "label": "BCCI",
            "origin": "https://www.bcci.tv",
            "referer": "https://www.bcci.tv/"
        }
        return get_cricket_stream_http(target_url, domain_info)
        
    elif "iplt20.com" in target_lower:
        domain_info = {
            "label": "IPL",
            "origin": "https://www.iplt20.com",
            "referer": "https://www.iplt20.com/"
        }
        return get_cricket_stream_http(target_url, domain_info)
        
    else:
        return get_fifa_stream_playwright(target_url)


if __name__ == "__main__":
    # Test fallback target defaults to an IPL link or passed argument
    target = sys.argv[1] if len(sys.argv) > 1 else "https://www.iplt20.com/video/69205/ipl-2026-q2-gt-vs-rr---match-highlights"
    stream_url = get_clean_stream(target)
    if stream_url:
        print(stream_url)
        sys.exit(0)
    else:
        print("Error: Stream extraction timed out.", file=sys.stderr)
        sys.exit(1)