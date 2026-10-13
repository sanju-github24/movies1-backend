// =====================================================================
// Trending — a Top 10 that follows what people are actually watching
//
//   POST /api/trending/hit   { slug }   a title was opened/played
//   GET  /api/trending?limit=10         the current Top N, enriched
//
// Every open is a vote. A vote's weight halves every HALF_LIFE, so the row
// reflects what is hot now, not what was ever popular — a title stops
// trending once people stop watching it. Counts live in a JSON file so they
// survive a restart; the enriched list (poster, logo, etc.) is read from
// watch_html and cached for a minute.
// =====================================================================

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'trending.json');
const HALF_LIFE_MS = 3 * 24 * 3600e3;      // a vote is worth half as much three days on
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  { auth: { persistSession: false } },
);

// slug -> { score, at } where score is decayed to the moment `at`.
let hits = {};
try { hits = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }

const decay = (h, now) => (h ? h.score * Math.pow(0.5, (now - h.at) / HALF_LIFE_MS) : 0);

let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(hits)); } catch (e) { console.warn('trending not saved:', e.message); }
  }, 2000);
};

router.post('/hit', express.json(), (req, res) => {
  const slug = String(req.body?.slug || req.query.slug || '');
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'bad slug' });
  const now = Date.now();
  hits[slug] = { score: decay(hits[slug], now) + 1, at: now };
  // Keep the file from growing without bound: drop long-cold titles.
  if (Object.keys(hits).length > 500) {
    for (const [s, h] of Object.entries(hits)) if (decay(h, now) < 0.05) delete hits[s];
  }
  save();
  res.status(204).end();
});

let cache = { at: 0, value: null };
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);
  const now = Date.now();
  if (cache.value && now - cache.at < 60e3) return res.json(cache.value.slice(0, limit));

  const ranked = Object.entries(hits)
    .map(([slug, h]) => ({ slug, score: decay(h, now) }))
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (!ranked.length) { res.set('Cache-Control', 'public, max-age=60'); return res.json([]); }

  // Enrich from watch_html — the table a watch page is built from.
  const slugs = ranked.map((r) => r.slug);
  const { data } = await supabase
    .from('watch_html')
    .select('slug, title, poster, cover_poster, title_logo, content_type, imdb_rating, trailer_codes, genres')
    .in('slug', slugs);
  const bySlug = new Map((data || []).map((w) => [w.slug, w]));

  const list = ranked.map((r, i) => {
    const w = bySlug.get(r.slug) || {};
    return {
      id: `trend_${r.slug}`,
      slug: r.slug,
      rank: i + 1,
      title: w.title || r.slug,
      poster: w.poster || '/default-poster.jpg',
      cover_poster: w.cover_poster || w.poster || '',
      title_logo: w.title_logo || null,
      content_type: w.content_type || 'movie',
      imdbRating: w.imdb_rating != null ? String(w.imdb_rating) : null,
      trailer_key: w.trailer_codes || null,
      language: w.language || [],
      genres: w.genres || [],
    };
  }).filter((m) => m.cover_poster || m.poster);   // need an image to show

  cache = { at: now, value: list };
  res.set('Cache-Control', 'public, max-age=60');
  res.json(list.slice(0, limit));
});

export default router;
