import asyncio
import nest_asyncio
import sys
import json
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup

nest_asyncio.apply()

# ============================================================
# 🎬 1TAMILMV SCRAPER
# ============================================================

async def scrape_1tamilmv(movie_name, target_language="Kannada"):
    base_url = "https://www.1tamilmv.ltd"
    search_url = f"{base_url}/search/?q={movie_name.replace(' ', '+')}"

    # scraper.py
    async with async_playwright() as p:
        browser = await p.chromium.launch(
         headless=True,
        args=[
            "--no-sandbox", 
            "--disable-setuid-sandbox", 
            "--disable-dev-shm-usage"
         ]
      )
        page = await browser.new_page()

        try:
            await page.goto(search_url, wait_until="networkidle", timeout=30000)
            soup = BeautifulSoup(await page.content(), 'html.parser')

            target_link = None
            for a in soup.select("#results a.sRow"):
                if movie_name.lower() in a.text.lower() and target_language.lower() in a.text.lower():
                    target_link = a['href']
                    break

            if not target_link:
                await browser.close()
                return []

            await page.goto(target_link, wait_until="domcontentloaded")
            movie_soup = BeautifulSoup(await page.content(), 'html.parser')

            all_versions = []
            magnet_btns = movie_soup.find_all('a', class_='skyblue-button')

            for btn in magnet_btns:
                parent = btn.find_parent('p') or btn.find_parent('div')

                label_tag = btn.find_previous('strong')
                label = label_tag.get_text(strip=True) if label_tag else "Unknown Quality"
                label = label.replace("TamilMV Official Telegram Channel :-Click Here", "").strip()

                magnet = btn.get('href')

                direct_tag = parent.find('a', class_='download-button') if parent else None
                direct_link = direct_tag.get('href') if direct_tag else "Not Available"

                torrent_link = "Not Available"
                if parent:
                    torrent_tag = parent.find('a', class_='ipsAttachLink_block', attrs={'data-fileext': 'torrent'})
                    if not torrent_tag:
                        all_attachments = parent.find_all('a', class_='ipsAttachLink_block')
                        for attach in all_attachments:
                            href = attach.get('href', '')
                            if ("attachment.php" in href or ".torrent" in href) and ".gif" not in href.lower():
                                torrent_tag = attach
                                break
                    if torrent_tag:
                        torrent_link = torrent_tag.get('href')

                all_versions.append({
                    "source": "1TamilMV",
                    "quality": label,
                    "magnet": magnet,
                    "direct_link": direct_link,
                    "torrent_file": torrent_link,
                    "seeders": "N/A",
                    "leechers": "N/A",
                    "info": ""
                })

            await browser.close()
            return all_versions

        except Exception as e:
            await browser.close()
            return []


# ============================================================
# 🏴‍☠️ PIRATEBAY SCRAPER
# ============================================================

async def scrape_piratebay(movie_name):
    base_url = "https://thepiratebay0.org"
    search_query = movie_name.replace(' ', '%20')
    search_url = f"{base_url}/search/{search_query}/1/99/0"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_extra_http_headers({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        })

        try:
            await page.goto(search_url, wait_until="domcontentloaded", timeout=45000)
            soup = BeautifulSoup(await page.content(), 'html.parser')

            rows = soup.select("#searchResult tr")[1:]
            results = []

            for row in rows:
                name_div = row.select_one(".detName")
                if not name_div:
                    continue

                movie_title = name_div.get_text(strip=True)
                magnet_tag = row.find('a', href=lambda x: x and x.startswith('magnet:'))
                magnet_link = magnet_tag['href'] if magnet_tag else "No Magnet Found"

                cells = row.find_all('td', align="right")
                seeders  = cells[0].get_text(strip=True) if len(cells) > 0 else "0"
                leechers = cells[1].get_text(strip=True) if len(cells) > 1 else "0"

                desc_tag = row.select_one(".detDesc")
                description = desc_tag.get_text(strip=True) if desc_tag else ""

                results.append({
                    "source": "PirateBay",
                    "quality": movie_title,
                    "magnet": magnet_link,
                    "direct_link": "Not Available",
                    "torrent_file": "Not Available",
                    "seeders": seeders,
                    "leechers": leechers,
                    "info": description
                })

            await browser.close()
            return results

        except Exception as e:
            await browser.close()
            return []


# ============================================================
# 🚀 COMBINED RUNNER
# ============================================================

async def run_search(movie_name, language="Kannada", source="both"):
    if source == "1tamilmv":
        return await scrape_1tamilmv(movie_name, language)
    elif source == "piratebay":
        return await scrape_piratebay(movie_name)
    else:
        # Run both concurrently
        tmv_results, tpb_results = await asyncio.gather(
            scrape_1tamilmv(movie_name, language),
            scrape_piratebay(f"{movie_name} {language}")
        )
        return tmv_results + tpb_results


# ============================================================
# 🌉 EXPRESS BRIDGE  (node: python3 scraper.py <movie> <lang> <source>)
# ============================================================

if __name__ == "__main__":
    movie_name = sys.argv[1] if len(sys.argv) > 1 else "777 Charlie"
    language   = sys.argv[2] if len(sys.argv) > 2 else "Kannada"
    source     = sys.argv[3] if len(sys.argv) > 3 else "both"   # both | 1tamilmv | piratebay

    try:
        results = asyncio.run(run_search(movie_name, language, source))
        print(json.dumps(results))
    except Exception as e:
        print(json.dumps([{"error": str(e)}]))
