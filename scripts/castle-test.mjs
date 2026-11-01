// scripts/castle-test.mjs
// Validate the Castle resolve chain end-to-end (search -> detail -> getVideo),
// decrypting the AES responses, and curl the m3u8 to confirm it's browser-direct
// playable (HTTP 200 + access-control-allow-origin:*).
//
//   node scripts/castle-test.mjs "418" 2026                  (movie)
//   node scripts/castle-test.mjs "Panchayat" 2020 1 3        (series: S1E3)
//   node scripts/castle-test.mjs --movieId 10205743820106943 [season] [episode]
import crypto from 'crypto';

const DOMAINS = (process.env.CASTLE_DOMAINS
  ? process.env.CASTLE_DOMAINS.split(',')
  : ['api.hwnou.com', 'api.hlowb.com', 'api.flwck.com', 'api.khmov.com', 'api.foxmvo.com', 'api.fszcxy.com', 'api.flucn.com']
).map((h) => h.trim()).filter(Boolean).map((h) => (/^https?:/i.test(h) ? h : `https://${h}`));
let origin = DOMAINS[0];

const PKG = 'com.external.castle', CHANNEL = 'IndiaA', APP_MARKET = 'GuanWang', VERSION = '2.1.2';
const NATIVE_SUFFIX = 'T!BgJB';
let securityKeyB64 = process.env.CASTLE_SECURITY_KEY || 'ZkpBVG0qa2dmSg==';
const DEVICE_ID = crypto.randomBytes(16).toString('hex'), GUID = crypto.randomBytes(16).toString('hex');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toLowerCase();
let guest = null;   // { uid, token, apikey }
function apikeyFromUid(uid) {
  const s = String(uid); const sum = [...s].reduce((a, c) => a + (Number(c) || 0), 0);
  const i = (sum + 1) % 8; return s.slice(s.length - i) + s.slice(0, 12 - i);
}
function signParams(obj) {
  const m = {};
  for (const [k, v] of Object.entries(obj)) { if (v == null) continue; m[k] = typeof v === 'object' ? JSON.stringify(v) : String(v); }
  return md5(Object.keys(m).sort().filter((k) => m[k] !== '' && m[k] !== 'null').map((k) => `${k}=${m[k]}`).join('&'));
}
const H = (nonce, ts) => {
  const h = { version: VERSION, clientType: '1', channel: CHANNEL, deviceId: DEVICE_ID, guid: GUID,
    timestamp: String(ts), nonce, 'User-Agent': 'okhttp/4.9.0' };
  if (guest?.token) h.Authorization = guest.token;
  return h;
};
const aesKey = (b64) => Buffer.concat([Buffer.from(b64, 'base64'), Buffer.from(NATIVE_SUFFIX)]).subarray(0, 16);
function decrypt(text, b64) {
  const k = aesKey(b64); const d = crypto.createDecipheriv('aes-128-cbc', k, k);
  return Buffer.concat([d.update(Buffer.from(text, 'base64')), d.final()]).toString('utf8');
}
// Quote 16+ digit ints so 17-digit movie/episode ids survive as strings
// (JSON.parse rounds them past Number.MAX_SAFE_INTEGER: …943 -> …944).
const jsonBig = (t) => JSON.parse(t.replace(/(?<=[:\[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '"$1"'));
function parse(text) {
  const t = (text || '').trim(); if (!t) return null;
  if (t[0] === '{' || t[0] === '[') return jsonBig(t);
  return jsonBig(decrypt(t, securityKeyB64).trim());
}
async function refreshKey() {
  try { const r = await fetch(`${origin}/v0.1/system/getSecurityKey/1`, { headers: H(crypto.randomBytes(16).toString('hex'), Date.now()) });
    const j = JSON.parse((await r.text()).trim()); if (j?.data) { securityKeyB64 = String(j.data); return true; } } catch {} return false;
}
async function ensureGuest() {
  if (guest?.token) return guest;
  const body = { channel: CHANNEL, channelName: CHANNEL, clientType: 1, countryCode: 'IN', deviceId: DEVICE_ID,
    deviceModel: 'Android', deviceName: 'Android', deviceType: 1, guid: GUID, invitationCode: '', packageName: PKG, token: '', userId: 0, version: VERSION };
  const resp = await call('POST', '/film-passport//v1.9.5/user/noPasswdLogin', { body });
  const u = resp?.data;
  if (u?.uid && u?.token) { guest = { uid: String(u.uid), token: u.token, apikey: apikeyFromUid(u.uid) }; console.log(`-> guest uid=${guest.uid}`); return guest; }
  throw new Error(`guest login failed: ${resp?.msg} (code ${resp?.code})`);
}
const longJson = (obj, keys) => keys.reduce((s, k) => s.replace(new RegExp(`"${k}":"(\\d+)"`), `"${k}":$1`), JSON.stringify(obj));
async function call(method, path, { params, body, longKeys } = {}, retried = false) {
  const order = [origin, ...DOMAINS.filter((o) => o !== origin)];
  for (const o of order) {
    try {
      const u = new URL(o + path);
      for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
      const nonce = crypto.randomBytes(16).toString('hex'), ts = Date.now();
      const headers = { ...H(nonce, ts) };
      if (body) { headers['Content-Type'] = 'application/json;charset=utf-8';
        if (guest?.apikey) headers.sign = signParams({ ...body, apikey: guest.apikey, nonce, timestamp: String(ts) }); }
      const r = await fetch(u, { method, headers, body: body ? (longKeys ? longJson(body, longKeys) : JSON.stringify(body)) : undefined });
      if (r.status !== 200) continue;
      let obj; try { obj = parse(await r.text()); } catch (e) {
        if (!retried && await refreshKey()) return call(method, path, { params, body, longKeys }, true);
        continue;
      }
      if (obj && 'code' in obj) { origin = o; return obj; }
    } catch {}
  }
  throw new Error('no live Castle host');
}
const jlog = (l, o) => console.log(`\n=== ${l} ===\n` + JSON.stringify(o, null, 1).slice(0, 1400));

(async () => {
  const args = process.argv.slice(2);
  const mi = args.indexOf('--movieId');
  const season = mi >= 0 ? args[mi + 2] : args[2];
  const episode = mi >= 0 ? args[mi + 3] : args[3];
  let movieId = mi >= 0 ? args[mi + 1] : '';
  const title = mi < 0 ? args[0] : null, year = mi < 0 ? args[1] : null;

  if (!movieId) {
    const s = await call('GET', '/film-api/v2.1.2/movie/searchByKeyword', {
      params: { keyword: title, page: 1, size: 20, mode: 1, secure: 0, channel: CHANNEL, appMarket: APP_MARKET, packageName: PKG, clientType: 1 },
    });
    const rows = s?.data?.rows || [];
    jlog(`search "${title}" via ${origin}`, { code: s?.code, hits: rows.map((r) => ({ id: r.id, title: r.title, yr: String(r.publishTime || '').slice(0, 10) })) });
    const hit = rows.find((r) => String(r.title || '').toLowerCase().includes(String(title).toLowerCase())) || rows[0];
    if (!hit) return console.log('no search hit');
    movieId = String(hit.id);
    console.log(`-> movieId=${movieId} (${hit.title})`);
  }

  const detResp = await call('GET', '/film-api/v2.1.2/movie', { params: { movieId, clientType: 1, packageName: PKG } });
  jlog('detail RAW', { code: detResp?.code, msg: detResp?.msg, dataKeys: detResp?.data && typeof detResp.data === 'object' ? Object.keys(detResp.data) : null });
  let D = detResp?.data || {};
  jlog('episodes[0] FULL', (D.episodes || [])[0] || '(no episodes)');
  jlog('movie-level langs', { languages: D.languages, firstLanguage: D.firstLanguage, resolution: D.resolution, indiaResolutionLabel: D.indiaResolutionLabel });
  if (season != null) {
    const s = (D.seasons || []).find((x) => Number(x.number) === Number(season));
    if (s?.movieId && String(s.movieId) !== String(movieId)) {
      movieId = String(s.movieId);
      D = (await call('GET', '/film-api/v2.1.2/movie', { params: { movieId, clientType: 1, packageName: PKG } }))?.data || {};
      console.log(`-> season ${season} movieId=${movieId}`);
    }
  }
  const eps = D.episodes || [];
  const ep = episode != null ? (eps.find((e) => Number(e.number) === Number(episode)) || eps[Number(episode) - 1]) : eps[0];
  jlog('detail', {
    title: D.title, seasons: (D.seasons || []).map((s) => ({ n: s.number, movieId: s.movieId })),
    episodeCount: eps.length, episodeId: ep?.id, number: ep?.number,
    languages: (ep?.tracks || []).map((t) => ({ id: t.languageId, name: t.languageName, def: t.isDefault })),
    resolutions: (ep?.videos || []).map((v) => ({ r: v.resolution, label: v.resolutionDescription })),
  });
  if (!ep) return console.log('no episode in detail');

  const langId = (ep.tracks?.find((t) => t.isDefault) || ep.tracks?.[0])?.languageId;
  // 1080p is premiumProPermission (VIP-only) — take the best free one.
  const vids = ep.videos || [];
  const free = vids.filter((v) => !v.premiumProPermission);
  const topRes = (free.length ? free : vids).map((v) => v.resolution).sort((a, b) => b - a)[0] || 1;
  const APK_SIGN_KEY = process.env.CASTLE_APK_SIGN_KEY || 'ED0955EB04E67A1D9F3305B95454FED485261475';
  const getVideo = () => call('POST', '/film-api/v2.0.7/movie/getVideo2', {
    params: { clientType: 1, packageName: PKG, channel: CHANNEL, lang: 'en-US' },
    body: {
      appMarket: APP_MARKET, woolUser: 'false', isp: 'Android', useVipCdn: 'false',
      movieId: String(movieId), episodeId: String(ep.id), isNewUser: 'true',
      resolution: String(topRes), mode: '1', clientType: '1', apkSignKey: APK_SIGN_KEY,
      androidVersion: '11', networkType: 'NETWORK_WIFI', packageName: PKG,
    },
  });
  let gv = await getVideo();
  jlog(`getVideo (resolution ${topRes})`, gv);
  if (gv?.data?.permissionDenied) {
    // The reward-ad unlock the app reports when its ad finishes.
    const ul = await call('POST', '/film-api/v2.0.6/usermovie/adUnlock', {
      body: { movieId: String(movieId), episodeId: String(ep.id), guid: GUID, packageName: PKG, channel: CHANNEL, clientType: 1 },
      longKeys: ['movieId', 'episodeId'],
    });
    jlog('adUnlock', ul);
    gv = await getVideo();
    jlog('getVideo after unlock', gv);
  }
  const vb = gv?.data || {};
  const url = vb.videoUrl || (vb.videoUrls || [])[0];
  if (!url) return console.log('\nNO videoUrl — getVideo may need the `sign` header. Paste the getVideo output above.');

  console.log(`\n-> m3u8: ${url}`);
  const head = await fetch(url, { headers: { Origin: 'https://www.1anchormovies.buzz' } });
  console.log(`\n=== playability ===\nHTTP ${head.status}  CORS: ${head.headers.get('access-control-allow-origin')}  type: ${head.headers.get('content-type')}`);
  console.log(head.status === 200 && head.headers.get('access-control-allow-origin') === '*'
    ? '\nBROWSER-DIRECT PLAYABLE — safe to ship.'
    : '\nCheck status/CORS above.');
})();
