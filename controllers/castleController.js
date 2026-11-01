// controllers/castleController.js
// Castle (com.external.castle / com.gxgx.daqiandy "IndiaA" v2.1.2) as a CDN-direct
// fallback movie source. We call their film API only to RESOLVE a title -> an HLS
// m3u8 URL; the video then plays DIRECT from their Cloudflare/OSS CDN to the
// viewer (CORS: *, no Referer, segments disguised as .jpg). No video touches the
// VPS — only these small JSON calls do. Ported from the decompiled app for
// personal/research use.
//
// Chain (all on the resolved content domain, default se.mnbvcxzas.com):
//   1. GET  film-api/v2.1.2/movie/searchByKeyword   -> match title/year -> movieId
//   2. GET  film-api/v2.1.2/movie?movieId=&clientType=1&packageName=
//                                                    -> episodes[], tracks[] (langs), videos[] (resolutions)
//   3. POST film-api/v2.0.7/movie/getVideo (VideoBody) -> VideoBean.videoUrl (m3u8)
//
// Signing: GET requests are never signed. The POST (getVideo) is signed with a
// `sign` header ONLY when a user is logged in; as an anonymous guest (how the app
// plays with no account) there is no sign. We call as a guest.
import crypto from 'crypto';
import axios from 'axios';

const DOMAIN = process.env.CASTLE_DOMAIN || 'https://se.mnbvcxzas.com';
const PKG = 'com.external.castle';
const VERSION = '2.1.2';
const CHANNEL = 'IndiaA';       // UMENG_CHANNEL header
const APP_MARKET = 'GuanWang';  // appMarket query/body param
const CLIENT_TYPE = 1;          // 1 = Android

const rndHex = (n) => crypto.randomBytes(n).toString('hex');

// Common headers the app's OkHttp interceptor (yb/f) adds to every request.
// deviceId/guid are per-install ids; the server does not bind them for reads,
// so a stable random pair per process is fine.
const DEVICE_ID = process.env.CASTLE_DEVICE_ID || rndHex(16);
const GUID = process.env.CASTLE_GUID || rndHex(16);

function baseHeaders() {
  return {
    version: VERSION,
    clientType: String(CLIENT_TYPE),
    channel: CHANNEL,
    deviceId: DEVICE_ID,
    guid: GUID,
    timestamp: String(Date.now()),
    nonce: rndHex(16),
    'User-Agent': 'okhttp/4.9.0',
  };
}

const client = axios.create({ timeout: 15000, validateStatus: () => true });

// ---- 1. search title -> movieId --------------------------------------------
async function search(keyword) {
  const url = `${DOMAIN}/film-api/v2.1.2/movie/searchByKeyword`;
  const r = await client.get(url, {
    headers: baseHeaders(),
    params: {
      keyword, page: 1, size: 20, mode: 1,
      clientType: CLIENT_TYPE, packageName: PKG, appMarket: APP_MARKET,
    },
  });
  if (r.status !== 200 || !r.data) return [];
  // BaseResp { code, msg, data: { list|records|films:[ { id/movieId, title, ... } ] } }
  const d = r.data.data || r.data;
  const list = d.list || d.records || d.films || d.content || (Array.isArray(d) ? d : []);
  return (list || []).map((m) => ({
    movieId: String(m.movieId || m.id || ''),
    title: m.title || m.name || '',
    year: pickYear(m),
    type: m.movieType ?? m.type,
  })).filter((m) => m.movieId);
}

function pickYear(m) {
  const s = String(m.publishTime || m.year || m.releaseTime || m.showTime || '');
  const y = s.match(/(19|20)\d{2}/);
  return y ? Number(y[0]) : null;
}

// Choose the best search hit for a title (+ optional year).
function bestMatch(hits, title, year) {
  if (!hits.length) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(title);
  let best = null, bestScore = -1;
  for (const h of hits) {
    let score = 0;
    const ht = norm(h.title);
    if (ht === t) score += 100;
    else if (ht.includes(t) || t.includes(ht)) score += 60;
    if (year && h.year && Math.abs(h.year - year) <= 1) score += 30;
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return bestScore >= 60 ? best : null;
}

// ---- 2. detail -> episodes / languages / resolutions -----------------------
async function detail(movieId) {
  const url = `${DOMAIN}/film-api/v2.1.2/movie`;
  const r = await client.get(url, {
    headers: baseHeaders(),
    params: { movieId, clientType: CLIENT_TYPE, packageName: PKG },
  });
  if (r.status !== 200 || !r.data) return null;
  return r.data.data || r.data;
}

// ---- 3. getVideo -> the m3u8 URL -------------------------------------------
// VideoBody as the app builds it; extra fields are harmless. Guest = no sign.
async function getVideo({ movieId, episodeId, resolution, languageId, nextEpisodeId }) {
  const url = `${DOMAIN}/film-api/v2.0.7/movie/getVideo`;
  const body = {
    movieId: String(movieId),
    episodeId: String(episodeId),
    resolution: Number(resolution) || 1,
    languageId: languageId != null ? Number(languageId) : null,
    nextEpisodeId: nextEpisodeId != null ? String(nextEpisodeId) : null,
    clientType: CLIENT_TYPE,
    channel: CHANNEL,
    appMarket: APP_MARKET,
    mode: 1,
    download: false,
    useVipCdn: false,
    secure: 0,
    networkType: 'WIFI',
    androidVersion: '11',
  };
  const r = await client.post(url, body, {
    headers: { ...baseHeaders(), 'Content-Type': 'application/json;charset=utf-8' },
  });
  if (r.status !== 200 || !r.data) return null;
  return r.data.data || r.data; // VideoBean
}

// Pull playable HLS URLs out of a VideoBean (videoUrl + videoUrls mirrors).
function urlsFromVideoBean(vb) {
  if (!vb) return [];
  const out = [];
  if (vb.videoUrl) out.push(vb.videoUrl);
  if (Array.isArray(vb.videoUrls)) out.push(...vb.videoUrls);
  // de-dup, keep only http(s)
  return [...new Set(out)].filter((u) => /^https?:\/\//i.test(u));
}

// Map a detail bean to a chosen episode + the language/resolution options.
// `episode` (1-based number) picks a series episode; absent → first (a movie).
function playTargets(det, episode) {
  const eps = det.episodes || [];
  let ep = null;
  if (episode != null) {
    ep = eps.find((e) => Number(e.number) === Number(episode))
      || eps[Number(episode) - 1] || null;
  }
  if (!ep) ep = eps[0] || null;
  if (!ep) return null;
  const langs = (ep.tracks || []).map((t) => ({
    id: t.languageId, name: t.languageName, code: t.abbreviate, isDefault: !!t.isDefault,
  }));
  // resolutions, highest first (resolution int: higher = better)
  const res = (ep.videos || []).map((v) => ({
    resolution: v.resolution, label: v.resolutionDescription,
  })).sort((a, b) => (b.resolution || 0) - (a.resolution || 0));
  return { episodeId: String(ep.id), langs, res };
}

// For a series, each season is its own movieId. Given the parent detail and a
// season number, return the movieId whose detail holds that season's episodes.
function seasonMovieId(det, season) {
  if (season == null) return null;
  const seasons = det.seasons || [];
  const s = seasons.find((x) => Number(x.number) === Number(season));
  return s && s.movieId ? String(s.movieId) : null;
}

// GET /api/castle/resolve?title=418&year=2026[&lang=1018][&movieId=...]
//   series: add &season=1&episode=3
// Returns { ok, title, movieId, languages, servers:[{label,url,kind:'hls'}] }.
export const resolve = async (req, res) => {
  try {
    const { title, year, movieId: mid, lang, season, episode } = req.query;
    const seasonN = season != null && season !== '' ? Number(season) : null;
    const episodeN = episode != null && episode !== '' ? Number(episode) : null;
    let movieId = mid ? String(mid).replace(/[^0-9]/g, '') : '';

    if (!movieId) {
      if (!title) return res.status(400).json({ error: 'title or movieId required' });
      const hits = await search(title);
      const m = bestMatch(hits, title, year ? Number(year) : null);
      if (!m) return res.json({ ok: false, reason: 'no match', candidates: hits.slice(0, 5) });
      movieId = m.movieId;
    }

    let det = await detail(movieId);
    if (!det) return res.status(502).json({ error: 'detail failed', movieId });

    // Series: hop to the requested season's own movieId when it isn't this one.
    if (seasonN != null) {
      const smid = seasonMovieId(det, seasonN);
      if (smid && smid !== movieId) {
        const sdet = await detail(smid);
        if (sdet) { det = sdet; movieId = smid; }
      }
    }

    const tgt = playTargets(det, episodeN);
    if (!tgt) return res.json({ ok: false, reason: 'no episode', movieId, title: det.title });

    // Pick language: requested -> default -> first.
    const wantLang = lang ? Number(lang)
      : (tgt.langs.find((l) => l.isDefault) || tgt.langs[0] || {}).id;
    // Top 2 resolutions as the 2 fallback servers.
    const picks = (tgt.res.length ? tgt.res : [{ resolution: 1, label: 'HD' }]).slice(0, 2);

    const servers = [];
    for (const p of picks) {
      const vb = await getVideo({
        movieId, episodeId: tgt.episodeId, resolution: p.resolution, languageId: wantLang,
      });
      for (const u of urlsFromVideoBean(vb)) {
        servers.push({ label: `Castle ${p.label || p.resolution}`, url: u, kind: 'hls' });
        break; // one URL per resolution is enough; the rest are mirrors
      }
      if (servers.length >= 2) break;
    }

    res.set('Cache-Control', 'no-store'); // auth_key/expire URLs are short-lived
    res.json({
      ok: servers.length > 0,
      movieId,
      title: det.title,
      languages: tgt.langs,
      servers,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};

export default { resolve };
