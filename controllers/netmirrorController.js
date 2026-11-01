// controllers/netmirrorController.js
// NetMirror as a fallback movie source. Resolves net27.cc's embed-tmdb REST API
// (keyed by TMDB id) to its signed, CORS-open .mp4 CDN links, and returns the
// top 2 by resolution. The video plays DIRECT from their CDN (hakunaymatata) —
// we only make the small JSON resolve call here, no video through this box.
import axios from 'axios';

const BASE = 'https://net27.cc/api/embed-tmdb';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://videodownloader.site/',
  'Accept': 'application/json',
};

// GET /api/netmirror/:tmdbId            → movie
// GET /api/netmirror/:tmdbId?type=tv&s=1&e=1  → episode
export const resolve = async (req, res) => {
  try {
    const tmdbId = String(req.params.tmdbId || '').replace(/[^0-9]/g, '');
    if (!tmdbId) return res.status(400).json({ error: 'tmdbId required' });
    const { type, s, e } = req.query;
    let url = `${BASE}/${tmdbId}`;
    if (type === 'tv') url += `?type=tv&s=${encodeURIComponent(s || 1)}&e=${encodeURIComponent(e || 1)}`;

    const r = await axios.get(url, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
    if (r.status !== 200 || !r.data || r.data.ok !== true) {
      return res.status(502).json({ error: `netmirror ${r.status}`, note: r.data?.error || '' });
    }
    const d = r.data;
    const streams = (Array.isArray(d.streams) ? d.streams : [])
      .filter((x) => x && x.url)
      .sort((a, b) => (Number(b.resolution) || 0) - (Number(a.resolution) || 0));
    // Top 2 distinct resolutions; fall back to the default mp4 if the list is thin.
    const top = streams.slice(0, 2).map((x) => ({ label: `${x.resolution}p`, url: x.url, resolution: Number(x.resolution) || 0 }));
    if (top.length === 0 && d.mp4) top.push({ label: `${d.resolution || 'HD'}p`, url: d.mp4, resolution: Number(d.resolution) || 0 });

    res.set('Cache-Control', 'no-store');   // the ?sign=&t= URLs are short-lived
    res.json({
      ok: top.length > 0,
      title: d.title, year: d.year,
      servers: top,                          // the 2 fallback servers
      hls: d.fallbackHls || null,            // HLS fallback if mp4 is blocked
      captions: Array.isArray(d.captions) ? d.captions : [],
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
