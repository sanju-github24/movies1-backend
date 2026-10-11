// =====================================================================
// Live radio — India's FM and online stations, by language
//
//   GET /api/radio/stations?lang=kannada   (lang empty → all of India)
//     { stations: [{ stationuuid, name, url_resolved, favicon, tags, state,
//                    country, codec, bitrate, lastcheckok, clickcount }],
//       cached: <iso time the list was fetched> }
//   GET /api/radio/click/:uuid  → tells the directory a station was played
//
// The list comes from Radio Browser (radio-browser.info), an open directory
// of public station streams; the streams themselves are the stations' own
// and play in the visitor's browser, not through here.
//
// The directory is run by volunteers and goes down — every mirror at once,
// sometimes — so the browser never asks it directly. This keeps each list
// for six hours, and keeps the last good one on disk to serve for as long
// as the directory is unreachable, restarts included.
// =====================================================================

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'radio-cache.json');
const FRESH_MS = 6 * 3600e3;
const MIRRORS = ['de1', 'de2', 'fi1', 'nl1', 'at1', 'all'].map((h) => `https://${h}.api.radio-browser.info`);
const LANGS = new Set(['', 'kannada', 'hindi', 'tamil', 'telugu', 'malayalam', 'english', 'marathi', 'bengali', 'punjabi', 'gujarati']);
const UA = 'AnchorMovies/1.0 (+https://www.1anchormovies.buzz)';
const KEEP = ['stationuuid', 'name', 'url_resolved', 'favicon', 'tags', 'state', 'country', 'codec', 'bitrate', 'lastcheckok', 'clickcount'];

let disk = {};
try { disk = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(disk)); } catch (e) { console.warn('radio cache not saved:', e.message); } };

async function directory(p) {
  let last;
  for (const base of MIRRORS) {
    try {
      const r = await fetch(base + p, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (r.ok) return await r.json();
      last = new Error(`${new URL(base).host} ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}

const inflight = new Map();
async function stations(lang) {
  const q = new URLSearchParams({ countrycode: 'IN', hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '150' });
  if (lang) q.set('language', lang);
  const rows = await directory(`/json/stations/search?${q}`);
  return rows.map((s) => Object.fromEntries(KEEP.map((k) => [k, s[k]])));
}

router.get('/stations', async (req, res) => {
  const lang = String(req.query.lang || '').toLowerCase();
  if (!LANGS.has(lang)) return res.status(400).json({ error: 'unknown language' });
  const kept = disk[lang];
  const send = (entry, stale) => {
    res.set('Cache-Control', `public, max-age=${stale ? 300 : 1800}`);
    res.json({ stations: entry.stations, cached: new Date(entry.at).toISOString(), stale: !!stale });
  };
  if (kept && Date.now() - kept.at < FRESH_MS) return send(kept);
  try {
    if (!inflight.has(lang)) inflight.set(lang, stations(lang).finally(() => inflight.delete(lang)));
    const list = await inflight.get(lang);
    if (list.length) { disk[lang] = { at: Date.now(), stations: list }; save(); }
    return send(disk[lang] || { at: Date.now(), stations: list });
  } catch (e) {
    if (kept) return send(kept, true);           // the directory is down: last good list
    console.warn(`radio directory unreachable (${lang || 'all'}):`, e.message);
    return res.status(503).json({ error: 'The station directory is down right now. Try again in a few minutes.' });
  }
});

router.get('/click/:uuid', (req, res) => {
  const uuid = String(req.params.uuid || '');
  if (/^[0-9a-f-]{36}$/i.test(uuid)) directory(`/json/url/${uuid}`).catch(() => {});
  res.status(204).end();
});

export default router;
