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

// The app rotates through a pool of API hosts (ServerConfig domain list) and
// picks a live one; they change over time. We try them in order and remember
// the one that answers. Override/extend with CASTLE_DOMAINS (comma-separated
// hosts or full origins). `se.mnbvcxzas.com` was the stale bootstrap host — the
// real content hosts are the api.* pool below.
const DEFAULT_DOMAINS = [
  'api.hwnou.com', 'api.hlowb.com', 'api.flwck.com',
  'api.khmov.com', 'api.foxmvo.com', 'api.fszcxy.com', 'api.flucn.com',
];
const DOMAINS = (process.env.CASTLE_DOMAINS
  ? process.env.CASTLE_DOMAINS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_DOMAINS
).map((h) => (/^https?:\/\//i.test(h) ? h.replace(/\/+$/, '') : `https://${h}`));
let liveOrigin = DOMAINS[0];   // remembered working host

const PKG = 'com.external.castle';
const VERSION = '2.1.2';
const CHANNEL = 'IndiaA';       // UMENG_CHANNEL header
const APP_MARKET = 'GuanWang';  // appMarket query/body param
const CLIENT_TYPE = 1;          // 1 = Android

const rndHex = (n) => crypto.randomBytes(n).toString('hex');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();

// Common headers the app's OkHttp interceptor (yb/f) adds to every request.
// deviceId/guid are per-install ids; the login binds the guest token to them,
// so the same pair is reused for the whole process.
// `let`: the ad unlock is counted per guid, so once the server stops granting
// unlocks we rotate to a fresh "install" (see getVideoUnlocked).
let DEVICE_ID = process.env.CASTLE_DEVICE_ID || rndHex(16);
let GUID = process.env.CASTLE_GUID || rndHex(16);

// A guest session. The app logs in anonymously (noPasswdLogin) on first launch
// and signs every POST with the returned uid+token; GET stays unauthenticated.
let guest = null;   // { uid, token, apikey }

// apikey derivation from the uid (yb/f.java): sum the digits, i = (sum+1)%8,
// then apikey = last-i digits + first-(12-i) digits of the uid.
function apikeyFromUid(uid) {
  const s = String(uid);
  const sum = [...s].reduce((a, c) => a + (Number(c) || 0), 0);
  const i = (sum + 1) % 8;
  return s.slice(s.length - i) + s.slice(0, 12 - i);
}

// The sign over a request (w.h): sorted "k=v&" of the fields, skipping empty
// values, md5 lowercase. For a POST it's the body fields + apikey + nonce + ts.
function signParams(obj) {
  const m = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    m[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  const s = Object.keys(m).sort()
    .filter((k) => m[k] !== '' && m[k] !== 'null')
    .map((k) => `${k}=${m[k]}`).join('&');
  return md5(s);
}

function baseHeaders(nonce, ts) {
  const h = {
    version: VERSION,
    clientType: String(CLIENT_TYPE),
    channel: CHANNEL,
    deviceId: DEVICE_ID,
    guid: GUID,
    timestamp: String(ts),
    nonce,
    'User-Agent': 'okhttp/4.9.0',
  };
  if (guest && guest.token) h.Authorization = guest.token;   // yb/a interceptor
  return h;
}

const client = axios.create({ timeout: 15000, validateStatus: () => true, responseType: 'text', transformResponse: [(x) => x] });

// --- Response decryption ----------------------------------------------------
// Most responses come back base64(AES-128-CBC/PKCS5). The key = the server
// "security key" (base64) decoded, then a 6-char native suffix appended, and
// that 16-byte string is used as BOTH the AES key and the IV (ac/w.java e()).
// A plaintext response already starts with "{" and is returned as-is.
const NATIVE_SUFFIX = 'T!BgJB';                         // DqNativeSignUtil.signKeyFromJNI()
let securityKeyB64 = process.env.CASTLE_SECURITY_KEY || 'ZkpBVG0qa2dmSg==';

function aesKey(secB64) {
  // base64-decode the security key, append the native suffix → 16 bytes.
  const k = Buffer.concat([Buffer.from(secB64, 'base64'), Buffer.from(NATIVE_SUFFIX, 'utf8')]);
  return k.subarray(0, 16);
}
function decryptBody(text, secB64) {
  const key = aesKey(secB64);
  const d = crypto.createDecipheriv('aes-128-cbc', key, key); // IV == key
  return Buffer.concat([d.update(Buffer.from(text, 'base64')), d.final()]).toString('utf8');
}
// Movie/episode ids are 17-digit snowflakes — bigger than Number.MAX_SAFE_INTEGER,
// so a plain JSON.parse silently rounds them (…943 -> …944) and the detail call
// then 500s ("Movie doesn't exist"). Quote any 16+ digit integer so it survives
// as a string before parsing.
function jsonBig(text) {
  return JSON.parse(text.replace(/(?<=[:\[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '"$1"'));
}
// Turn a raw response body into an object: plaintext JSON as-is, else decrypt.
function parseBody(text) {
  const t = (text || '').trim();
  if (!t) return null;
  if (t[0] === '{' || t[0] === '[') return jsonBig(t);
  // encrypted — try the current key, then a freshly-fetched one.
  try { return jsonBig(decryptBody(t, securityKeyB64).trim()); }
  catch { return { __encrypted: t }; }   // signal caller to refresh the key
}

// Fetch the current security key (its own response is plaintext).
async function refreshSecurityKey() {
  try {
    const r = await client.get(`${liveOrigin}/v0.1/system/getSecurityKey/1`, { headers: baseHeaders(rndHex(16), Date.now()) });
    const j = JSON.parse((r.data || '').trim());
    if (j && j.data) { securityKeyB64 = String(j.data); return true; }
  } catch { /* keep the old key */ }
  return false;
}

// Make a request against the host pool: try the remembered host first, then the
// rest, until one answers with a usable BaseResp. A POST is signed (yb/f): the
// `sign` header is md5 over the body fields + apikey + nonce + timestamp, with
// the SAME nonce/timestamp carried in the headers.
// `longKeys` names body fields the app sends as a Java long: 17-digit ids that
// a JS Number can't hold, so they go out as bare digits in the JSON text.
const longJson = (obj, keys) => keys.reduce(
  (s, k) => s.replace(new RegExp(`"${k}":"(\\d+)"`), `"${k}":$1`), JSON.stringify(obj));

async function callPool(method, path, { params, data, longKeys } = {}, _retried = false) {
  const order = [liveOrigin, ...DOMAINS.filter((o) => o !== liveOrigin)];
  let lastErr = null;
  for (const origin of order) {
    try {
      const nonce = rndHex(16); const ts = Date.now();
      const headers = { ...baseHeaders(nonce, ts) };
      if (data) {
        headers['Content-Type'] = 'application/json;charset=utf-8';
        if (guest && guest.apikey) {
          headers.sign = signParams({ ...data, apikey: guest.apikey, nonce, timestamp: String(ts) });
        }
      }
      const r = await client.request({
        method, url: `${origin}${path}`, params,
        data: data ? (longKeys ? longJson(data, longKeys) : JSON.stringify(data)) : undefined, headers,
      });
      if (r.status !== 200 || !r.data) { lastErr = `${origin} -> ${r.status}`; continue; }
      const body = parseBody(r.data);
      if (body && body.__encrypted) {
        if (!_retried && await refreshSecurityKey()) {
          return callPool(method, path, { params, data, longKeys }, true);  // retry once with fresh key
        }
        lastErr = `${origin} -> undecryptable`; continue;
      }
      if (body && typeof body === 'object' && 'code' in body) { liveOrigin = origin; return body; }
      lastErr = `${origin} -> unexpected body`;
    } catch (e) { lastErr = `${origin} -> ${e.message}`; }
  }
  const err = new Error(`no live Castle host (${lastErr})`); err.pool = true;
  throw err;
}

// Anonymous guest login (noPasswdLogin) — returns a User{uid, token}. The first
// call is unsigned (no guest yet); afterwards every POST is signed. Cached for
// the process.
async function ensureGuest() {
  if (guest && guest.token) return guest;
  const body = {
    channel: CHANNEL, channelName: CHANNEL, clientType: CLIENT_TYPE,
    countryCode: 'IN', deviceId: DEVICE_ID, deviceModel: 'Android',
    deviceName: 'Android', deviceType: 1, guid: GUID, invitationCode: '',
    packageName: PKG, token: '', userId: 0, version: VERSION,
  };
  const resp = await callPool('post', '/film-passport//v1.9.5/user/noPasswdLogin', { data: body });
  const u = resp && resp.data;
  if (u && u.uid && u.token) {
    guest = { uid: String(u.uid), token: u.token, apikey: apikeyFromUid(u.uid) };
    return guest;
  }
  throw new Error(`guest login failed: ${resp && resp.msg} (code ${resp && resp.code})`);
}

// ---- 1. search title -> movieId --------------------------------------------
async function search(keyword) {
  const resp = await callPool('get', '/film-api/v2.1.2/movie/searchByKeyword', {
    params: {
      keyword, page: 1, size: 20, mode: 1, secure: 0,
      channel: CHANNEL, appMarket: APP_MARKET, packageName: PKG, clientType: CLIENT_TYPE,
    },
  });
  const d = resp.data || {};
  // SearchKeyWordBean { rows:[ SearchKeyWord{ id, title, publishTime, movieType } ] }
  const list = d.rows || d.list || d.records || (Array.isArray(d) ? d : []);
  return (list || []).map((m) => ({
    movieId: String(m.id || m.movieId || ''),
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

// Choose the best search hit for a title (+ optional year). Castle's own search
// already ranks relevant hits, so this just picks the closest — token-based and
// forgiving, so sequels, subtitles, a trailing year, filler words ("The",
// "Movie", a language name) or minor spelling differences still match, instead
// of only an exact string.
const MATCH_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'part', 'movie', 'film', 'full', 'hd',
  'hindi', 'tamil', 'telugu', 'kannada', 'malayalam', 'bengali', 'season', 'vol', 'volume']);
function matchNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')            // drop "(2024)", "(Hindi)" etc.
    .replace(/\b(19|20)\d{2}\b/g, ' ')   // drop a bare year
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const matchToks = (s) => matchNorm(s).split(' ').filter((w) => w && !MATCH_STOP.has(w));
function bestMatch(hits, title, year) {
  if (!hits.length) return null;
  const t = matchNorm(title);
  const q = new Set(matchToks(title));
  let best = null, bestScore = -1;
  for (const h of hits) {
    const ht = matchNorm(h.title);
    const hs = new Set(matchToks(h.title));
    let score;
    if (ht === t) score = 100;
    else {
      let inter = 0;
      for (const w of q) if (hs.has(w)) inter++;
      const dice = (q.size + hs.size) ? (2 * inter) / (q.size + hs.size) : 0;
      score = Math.round(dice * 70)
        + (q.size && inter === q.size ? 25 : 0)            // every query word is present
        + (ht.startsWith(t) || t.startsWith(ht) ? 10 : 0)
        + (t && (ht.includes(t) || t.includes(ht)) ? 10 : 0);
    }
    if (year && h.year && Math.abs(h.year - year) <= 1) score += 15;   // tiebreaker, not a gate
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return bestScore >= 40 ? best : null;
}

// ---- 2. detail -> episodes / languages / resolutions -----------------------
async function detail(movieId) {
  const resp = await callPool('get', '/film-api/v2.1.2/movie', {
    params: { movieId, clientType: CLIENT_TYPE, packageName: PKG },
  });
  return resp.data || null;
}

// ---- 3. getVideo -> the m3u8 URL -------------------------------------------
// VideoBody as the app builds it; extra fields are harmless. Guest = no sign.
// An app signing-cert SHA1 the server accepts (not strictly validated — the
// emulator install's own cert works too). Overridable via env.
const APK_SIGN_KEY = process.env.CASTLE_APK_SIGN_KEY || 'ED0955EB04E67A1D9F3305B95454FED485261475';

// The real play call is getVideo2 — anonymous (NO sign / NO Authorization), with
// query params AND a JSON body whose values are ALL strings (it's a
// HashMap<String,String>). Captured from the running app. Passing `languageId`
// (as the app does when a language is picked) returns that language's stream;
// omitting it gives the title's default/first language.
async function getVideo({ movieId, episodeId, resolution, languageId }) {
  const body = {
    appMarket: APP_MARKET,
    woolUser: 'false',
    isp: 'Android',
    useVipCdn: 'false',
    movieId: String(movieId),
    episodeId: String(episodeId),
    isNewUser: 'true',
    resolution: String(Number(resolution) || 1),
    mode: '1',
    clientType: '1',
    apkSignKey: APK_SIGN_KEY,
    androidVersion: '11',
    networkType: 'NETWORK_WIFI',
    packageName: PKG,
    ...(languageId != null ? { languageId: String(languageId) } : {}),
  };
  const resp = await callPool('post', '/film-api/v2.0.7/movie/getVideo2', {
    params: { clientType: 1, packageName: PKG, channel: CHANNEL, lang: 'en-US' },
    data: body,
  });
  return resp.data || null; // VideoBean
}

// ---- 3b. ad unlock -----------------------------------------------------------
// A new guid gets `permissionDenied:true` from getVideo2 until it has "watched"
// the reward ad. When the ad finishes the app just reports it
// (FilmDetailViewModel.saveFilmAdUnLock -> usermovie/adUnlock, FilmAdUnLockBody);
// from then on getVideo2 returns the URL for that guid.
const unlocked = new Set();   // `${movieId}:${episodeId}` already unlocked for GUID

async function adUnlock(movieId, episodeId) {
  const body = {
    movieId: String(movieId), episodeId: String(episodeId), guid: GUID,
    packageName: PKG, channel: CHANNEL, clientType: CLIENT_TYPE,
  };
  const resp = await callPool('post', '/film-api/v2.0.6/usermovie/adUnlock', {
    data: body, longKeys: ['movieId', 'episodeId'],
  });
  return !!resp && resp.code === 200;
}

// getVideo, and on permissionDenied: unlock, then ask again. If the unlock is
// refused or doesn't stick (that guid's count is used up), start over as a
// fresh install once.
async function getVideoUnlocked(args) {
  let vb = await getVideo(args);
  if (urlsFromVideoBean(vb).length || !(vb && vb.permissionDenied)) return vb;
  const key = `${args.movieId}:${args.episodeId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 || unlocked.has(key)) {
      DEVICE_ID = rndHex(16); GUID = rndHex(16); guest = null; unlocked.clear();
    }
    if (!(await adUnlock(args.movieId, args.episodeId))) continue;
    unlocked.add(key);
    vb = await getVideo(args);
    if (urlsFromVideoBean(vb).length) return vb;
  }
  return vb;
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
    resolution: v.resolution, label: v.resolutionDescription, premium: !!v.premiumProPermission,
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

    // Best free resolution. A premiumProPermission tier (1080p) is VIP-only and
    // stays permissionDenied, so never offer it.
    const free = tgt.res.filter((r) => !r.premium);
    const topRes = (free[0] || tgt.res[0] || { resolution: 1 }).resolution;

    // One server PER LANGUAGE — getVideo2 returns that language's stream when
    // given its languageId. The player reads the language from each server's
    // name (default/first language first). A title with no language tracks, or a
    // single one, just yields one server.
    const wantLangs = lang ? tgt.langs.filter((l) => String(l.id) === String(lang)) : tgt.langs;
    const langList = (wantLangs.length ? wantLangs : [{ id: undefined, name: '', code: '' }]).slice(0, 8);

    // getVideo2 signs a fresh URL (rotating host + auth_key) every call, so two
    // languages that are really the SAME file only match on the path. Dedup by
    // path: distinct paths = real per-language audio; one path = a single stream
    // for the whole title (the player reads any embedded audio from the manifest).
    const contentPath = (u) => { try { return new URL(u).pathname; } catch { return u; } };
    const servers = [];
    const seen = new Set();
    for (const l of langList) {
      const vb = await getVideoUnlocked({
        movieId, episodeId: tgt.episodeId, resolution: topRes, languageId: l.id,
      });
      const u = urlsFromVideoBean(vb)[0];
      if (!u) continue;
      const key = contentPath(u);
      if (seen.has(key)) continue;         // same file as a language already added
      seen.add(key);
      servers.push({ label: l.name || det.firstLanguage || 'HD', lang: l.code || '', url: u, kind: 'hls' });
    }
    // All languages collapsed to one file → it's a single stream; don't label it
    // with just the first language (the manifest's own audio tracks, if any, win).
    if (servers.length === 1 && langList.length > 1) servers[0].label = det.firstLanguage || 'Castle';

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
