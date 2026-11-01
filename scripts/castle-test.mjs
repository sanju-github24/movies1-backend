// scripts/castle-test.mjs
// Validate the Castle resolve chain end-to-end from the VPS (or any box that can
// reach se.mnbvcxzas.com). Prints the m3u8 URL and curls it to confirm it's
// browser-direct playable (HTTP 200 + access-control-allow-origin:*).
//
//   node scripts/castle-test.mjs "418" 2026                  (movie)
//   node scripts/castle-test.mjs "Panchayat" 2020 1 3        (series: S1E3)
//   node scripts/castle-test.mjs --movieId 10205743820106943 [season] [episode]
//
// If getVideo returns an empty/!ok payload, the guest (no-sign) path is being
// rejected and we need to add the `sign` header — tell me the exact response.
import crypto from 'crypto';

const DOMAIN = process.env.CASTLE_DOMAIN || 'https://se.mnbvcxzas.com';
const PKG = 'com.external.castle', VERSION = '2.1.2', CHANNEL = 'IndiaA', APP_MARKET = 'GuanWang';
const DEVICE_ID = crypto.randomBytes(16).toString('hex');
const GUID = crypto.randomBytes(16).toString('hex');
const H = () => ({
  version: VERSION, clientType: '1', channel: CHANNEL, deviceId: DEVICE_ID, guid: GUID,
  timestamp: String(Date.now()), nonce: crypto.randomBytes(16).toString('hex'),
  'User-Agent': 'okhttp/4.9.0',
});
const jlog = (label, o) => console.log(`\n=== ${label} ===\n` + JSON.stringify(o, null, 1).slice(0, 1200));

async function getJ(path, params) {
  const u = new URL(DOMAIN + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: H() });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function postJ(path, body) {
  const r = await fetch(DOMAIN + path, {
    method: 'POST',
    headers: { ...H(), 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const args = process.argv.slice(2);
  let movieId = '';
  const mi = args.indexOf('--movieId');
  // --movieId <id> [season] [episode]   |   "<title>" <year> [season] [episode]
  const season = mi >= 0 ? args[mi + 2] : args[2];
  const episode = mi >= 0 ? args[mi + 3] : args[3];
  if (mi >= 0) movieId = args[mi + 1];
  const title = mi < 0 ? args[0] : null;
  const year = mi < 0 ? args[1] : null;

  if (!movieId) {
    const s = await getJ('/film-api/v2.1.2/movie/searchByKeyword', {
      keyword: title, page: 1, size: 20, mode: 1, clientType: 1, packageName: PKG, appMarket: APP_MARKET,
    });
    jlog(`search "${title}" (HTTP ${s.status})`, s.body);
    const d = s.body?.data || s.body || {};
    const list = d.list || d.records || d.films || d.content || [];
    const hit = list.find((m) => String(m.title || m.name || '').toLowerCase().includes(String(title).toLowerCase())) || list[0];
    if (!hit) return console.log('no search hit — paste the search body above');
    movieId = String(hit.movieId || hit.id);
    console.log(`\n-> picked movieId=${movieId} (${hit.title || hit.name})`);
  }

  let det = await getJ('/film-api/v2.1.2/movie', { movieId, clientType: 1, packageName: PKG });
  let D = det.body?.data || det.body || {};
  // Series: each season is its own movieId — hop to the requested season.
  if (season != null) {
    const s = (D.seasons || []).find((x) => Number(x.number) === Number(season));
    if (s?.movieId && String(s.movieId) !== String(movieId)) {
      movieId = String(s.movieId);
      det = await getJ('/film-api/v2.1.2/movie', { movieId, clientType: 1, packageName: PKG });
      D = det.body?.data || det.body || {};
      console.log(`\n-> season ${season} movieId=${movieId}`);
    }
  }
  const eps = D.episodes || [];
  const ep = episode != null
    ? (eps.find((e) => Number(e.number) === Number(episode)) || eps[Number(episode) - 1])
    : eps[0];
  jlog(`detail (HTTP ${det.status})`, {
    title: D.title, seasons: (D.seasons || []).map((s) => ({ n: s.number, movieId: s.movieId })),
    episodeCount: eps.length, episodeId: ep?.id, episodeNumber: ep?.number,
    languages: (ep?.tracks || []).map((t) => ({ id: t.languageId, name: t.languageName, def: t.isDefault })),
    resolutions: (ep?.videos || []).map((v) => ({ r: v.resolution, label: v.resolutionDescription })),
  });
  if (!ep) return console.log('no episode in detail');

  const langId = (ep.tracks?.find((t) => t.isDefault) || ep.tracks?.[0])?.languageId;
  const topRes = (ep.videos || []).map((v) => v.resolution).sort((a, b) => b - a)[0] || 1;
  const gv = await postJ('/film-api/v2.0.7/movie/getVideo', {
    movieId: String(movieId), episodeId: String(ep.id), resolution: topRes, languageId: langId,
    clientType: 1, channel: CHANNEL, appMarket: APP_MARKET, mode: 1,
    download: false, useVipCdn: false, secure: 0, networkType: 'WIFI', androidVersion: '11',
  });
  jlog(`getVideo (HTTP ${gv.status})`, gv.body);
  const vb = gv.body?.data || gv.body || {};
  const url = vb.videoUrl || (vb.videoUrls || [])[0];
  if (!url) return console.log('\nNO videoUrl — guest path likely rejected (needs sign). Paste the getVideo body above.');

  console.log(`\n-> m3u8: ${url}`);
  const head = await fetch(url, { headers: { Origin: 'https://www.1anchormovies.buzz' } });
  console.log(`\n=== playability ===\nHTTP ${head.status}`);
  console.log('access-control-allow-origin:', head.headers.get('access-control-allow-origin'));
  console.log('content-type:', head.headers.get('content-type'));
  console.log(head.status === 200 && head.headers.get('access-control-allow-origin') === '*'
    ? '\nBROWSER-DIRECT PLAYABLE (CORS open, no referer) — safe to wire into the player.'
    : '\nNeeds a closer look (status/CORS above).');
})();
