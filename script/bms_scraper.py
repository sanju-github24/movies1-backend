import sys
import json
import requests
from bs4 import BeautifulSoup
import re
import time
import random

# =========================
# Google Custom Search config
# =========================
GOOGLE_API_KEY = "AIzaSyA2PqeGd-X3jYCDUX12P8H8TcFyaaYKDJc"
GOOGLE_CX = "31ea24d83bf9d43ba"

# Toggle Google fallback for actor images
USE_GOOGLE_IMAGES = False  

# Default fallback avatar
DEFAULT_ACTOR_IMAGE = "/user.png"

# Default headers for requests
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0 Safari/537.36"
}


def safe_request(url, params=None, retries=2, delay=1):
    """Make a request with retries and backoff"""
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=10)
            if resp.status_code == 200 and resp.text.strip():
                return resp
            else:
                print(f"Retry {attempt+1}/{retries}: HTTP {resp.status_code}", file=sys.stderr)
        except Exception as e:
            print(f"Request error: {e}", file=sys.stderr)

        # small delay, not too long
        time.sleep(delay * (attempt + 1) + random.uniform(0, 0.5))

    return None


def fetch_actor_image(actor_name):
    """Fetch actor image using Google Custom Search API"""
    if not actor_name:
        return None
    try:
        query = re.sub(r'[^a-zA-Z0-9\s]', '', actor_name).strip() + " actor"
        url = "https://www.googleapis.com/customsearch/v1"
        params = {
            "q": query,
            "cx": GOOGLE_CX,
            "searchType": "image",
            "imgSize": "large",
            "num": 1,
            "key": GOOGLE_API_KEY
        }
        resp = safe_request(url, params)
        if not resp:
            return None

        data = resp.json()
        if "items" in data and len(data["items"]) > 0:
            return data["items"][0].get("link")

        return None
    except Exception as e:
        print(f"Google image fetch error for {actor_name}: {e}", file=sys.stderr)
        return None


def fetch_release_date_google(movie_title):
    """Fetch release date from Google search snippets"""
    try:
        url = "https://www.googleapis.com/customsearch/v1"
        params = {
            "q": f"{movie_title} release date India",
            "cx": GOOGLE_CX,
            "num": 3,
            "key": GOOGLE_API_KEY
        }
        resp = safe_request(url, params)
        if not resp:
            return "N/A"

        data = resp.json()
        if "items" in data:
            for item in data["items"]:
                text = (item.get("snippet", "") + " " + item.get("title", "")).strip()
                patterns = [
                    r"\b\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{4}\b",
                    r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4}\b",
                    r"\b\d{4}-\d{2}-\d{2}\b"
                ]
                for pattern in patterns:
                    match = re.search(pattern, text)
                    if match:
                        return match.group(0)

        return "N/A"
    except Exception as e:
        print(f"Google release date fetch error: {e}", file=sys.stderr)
        return "N/A"


def scrape_bms(bms_slug):
    """Scrape BookMyShow movie details"""
    try:
        url = f"https://in.bookmyshow.com/movies/bengaluru/{bms_slug}"
        response = safe_request(url)
        if not response:
            return {"success": False, "error": "Failed to fetch BMS page"}

        soup = BeautifulSoup(response.text, "html.parser")

        # Title
        title_tag = soup.find("h1")
        title = title_tag.text.strip() if title_tag else bms_slug

        # Rating
        rating_tag = soup.select_one("h5.sc-ycjzp1-4")
        rating = rating_tag.text.strip() if rating_tag else "N/A"

        # Format + Language
        format_lang_tags = soup.select("a.sc-2k6tnd-2.eUdyhJ")
        format_language = [tag.text.strip() for tag in format_lang_tags] if format_lang_tags else []

        # Release Date (Google fetch)
        release_date = fetch_release_date_google(title)

        # Cast
        cast = []
        cast_blocks = soup.select("a.sc-17p4id8-0.chrvLp") or []
        for block in cast_blocks:
            try:
                name_tag = block.select_one("h5")
                role_tag = block.select("h5")
                if not name_tag:
                    continue
                name = name_tag.get_text(strip=True)
                role = role_tag[1].get_text(strip=True).replace("as ", "") if len(role_tag) > 1 else None

                # Try BMS image first
                img_tag = block.select_one("img")
                image = img_tag["src"] if img_tag and img_tag.get("src") else None

                # Fallback: Google image (only if enabled)
                if not image and USE_GOOGLE_IMAGES:
                    image = fetch_actor_image(name)

                cast.append({
                    "name": name,
                    "role": role,
                    "image": image if image else DEFAULT_ACTOR_IMAGE
                })
            except Exception as e:
                print(f"Error processing cast block: {e}", file=sys.stderr)
                continue

        # Poster
        poster_tag = soup.select_one("img[src*='/movies/images/mobile/thumbnail/']")
        poster = poster_tag["src"] if poster_tag else None
        if not poster:
            poster = "/default-poster.png"  # fallback

        # Background (backdrop) image
        background = None
        bg_tag = soup.select_one("img[src*='/movies/images/cover/']")  # typical BMS backdrop
        if not bg_tag:
            # Sometimes stored in inline style
            style_tag = soup.select_one("[style*='background-image']")
            if style_tag:
                match = re.search(r'url\(([^)]+)\)', style_tag["style"])
                if match:
                    background = match.group(1)
        if not background:
            background = poster  # fallback to poster if no background found

        return {
            "success": True,
            "movie": {
                "title": title,
                "rating": rating,
                "releaseDate": release_date,
                "formatLanguage": format_language,
                "cast": cast,
                "poster": poster,
                "background": background  # ✅ new field
            }
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No slug provided"}))
        sys.exit(1)

    bms_slug = sys.argv[1]
    result = scrape_bms(bms_slug)
    print(json.dumps(result, ensure_ascii=False, indent=2))
