// controllers/cricfyController.js
// Cricfy live events for the /sports page. Signs the app's getData.php endpoint,
// decrypts the V2 payload, and returns matches + their stream servers.
// Ported from the decompiled app (app.cricfy.tv v7.3). Personal/research use.
import crypto from 'crypto';
import axios from 'axios';

const HOST = 'https://rtsplays.com';
const UA_API = 'Mozilla/5.0 CricfyTV/7.3';
const IST_MIN = 5 * 60 + 30;                    // IST = UTC + 5:30

// default signing token baked into the APK (array ^ 53)
const TOKEN = [13,83,1,82,93,84,12,84,83,83,80,80,82,82,2,86,92,82,84,83,81,82,86,2,93,80,82,83,94,80,83,84,92,86,92,82,81,82,82,4,93,84,83,83,93,80,94,82,80,80,92,82,86,83,82,84,93,80,81,83,93,80,83]
  .map((x) => String.fromCharCode(x ^ 53)).join('');

// query param codec: XOR each byte with 0x5A, hex-encode
const X = (s) => Buffer.from(String(s), 'utf8')
  .reduce((a, b) => a + ((b ^ 0x5A) & 0xff).toString(16).padStart(2, '0'), '');

// V2 content codec: pairwise-swap adjacent chars, then reverse the whole string
function swapRev(s) {
  const a = s.split('');
  for (let i = 0; i + 1 < a.length; i += 2) { const t = a[i]; a[i] = a[i + 1]; a[i + 1] = t; }
  a.reverse();
  return a.join('');
}
function decryptV2(data) {
  const raw = Buffer.from(String(data).trim(), 'base64').toString('utf8');
  const t = swapRev(raw);
  const MARK = 'abcdefghijklmnop';
  if (!t.endsWith(MARK)) throw new Error('V2 marker missing');
  const ct = Buffer.from(t.slice(0, -MARK.length).trim(), 'base64');
  const dec = crypto.createDecipheriv('aes-128-cbc',
    Buffer.from('WT1sdkEvUlR4ckd2'), Buffer.from('Q7sKcm9LR4VaX2pN'));
  let inner = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  inner = swapRev(inner).replace(/[^A-Za-z0-9+/=]/g, '').replace(/=/g, '');
  while (inner.length % 4) inner += '=';
  return Buffer.from(inner, 'base64').toString('utf8');
}
function smartDecrypt(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.startsWith('[') || t.startsWith('{') || t.startsWith('#EXT')) return t;
  return decryptV2(t);     // getData.php payloads are V2
}

async function getData(path) {
  const url = `${HOST}/data/getData.php?key=${X(path)}&hmac=${X(Math.floor(Date.now() / 1000) + '|' + TOKEN)}`;
  const r = await axios.get(url, {
    headers: { 'User-Agent': UA_API, Accept: 'text/plain, application/json, */*' },
    timeout: 20000, responseType: 'text', transformResponse: [(d) => d], validateStatus: () => true,
  });
  if (r.status >= 400) throw new Error('getData ' + r.status);
  return typeof r.data === 'string' ? r.data : String(r.data);
}

// ---- parsing helpers ----
function splitHeaders(link) {
  let url = link, ua = '', ref = '';
  const bar = link.indexOf('|');
  if (bar !== -1) {
    url = link.slice(0, bar);
    for (const p of link.slice(bar + 1).split('&')) {
      const eq = p.indexOf('=');
      if (eq === -1) continue;
      const k = p.slice(0, eq).toLowerCase(), v = p.slice(eq + 1);
      if (k === 'user-agent') ua = v; else if (k === 'referer') ref = v;
    }
  }
  return { url, ua, ref };
}
function parseUTC(d, t) {
  if (!d) return null;
  const s = `${d} ${t || '00:00:00'}`.trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);   // DD/MM/YYYY
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);          // YYYY-MM-DD
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return null;
}
function istLabel(startMs, nowMs) {
  if (!startMs) return 'Time TBA';
  const s = new Date(startMs + IST_MIN * 60000);
  const nI = new Date(nowMs + IST_MIN * 60000);
  let h = s.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const tt = `${h}:${String(s.getUTCMinutes()).padStart(2, '0')} ${ap}`;
  const dayOf = (x) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const diff = (dayOf(s) - dayOf(nI)) / 86400000;
  let day;
  if (diff === 0) day = 'Today'; else if (diff === 1) day = 'Tomorrow'; else if (diff === -1) day = 'Yesterday';
  else day = s.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  return `${day} ${tt} IST`;
}

let CACHE = { at: 0, data: null };

async function buildEvents() {
  const raw = JSON.parse(smartDecrypt(await getData('v2/events.txt')));
  const now = Date.now();
  const out = [];
  for (const e of raw) {
    let ev; try { ev = typeof e.event === 'string' ? JSON.parse(e.event) : e.event; } catch { continue; }
    if (['0', 'false', 'False'].includes(String(ev.visible ?? '1'))) continue;
    const d = ev.eventDetails || {}, tA = ev.teamA || {}, tB = ev.teamB || {};
    const a = tA.name || '', b = tB.name || '';
    const title = (a && b && a !== b) ? `${a} vs ${b}` : (d.eventName || a || 'Event');
    const st = parseUTC(ev.date, ev.time);
    const en = parseUTC(ev.end_date, ev.end_time) || (st ? st + 4 * 3600000 : null);
    const status = (st && en && st <= now && now <= en) ? 'live'
      : (st && now < st) ? 'upcoming'
      : (st && en && now > en) ? 'ended' : 'upcoming';
    let links; try { links = typeof e.links === 'string' ? JSON.parse(e.links) : e.links; } catch { links = []; }
    const servers = [];
    for (const s of (links || [])) {
      const { url, ua, ref } = splitHeaders(s.link || '');
      if (!url) continue;
      const low = url.toLowerCase();
      const kind = low.includes('.mpd') ? 'dash' : low.includes('.m3u8') ? 'hls' : 'other';
      servers.push({ name: s.name || 'Server', url, ua, ref, drm: s.api || '', kind });
    }
    if (!servers.length) continue;
    out.push({
      id: String(e.id ?? out.length),
      title, category: d.category || 'Other',
      poster: d.eventLogo || '', teamA: a, teamB: b,
      logoA: tA.logo || '', logoB: tB.logo || '',
      timeLabel: istLabel(st, now), status, live: status === 'live',
      startMs: st || 0, servers,
    });
  }
  const order = { live: 0, upcoming: 1, ended: 2 };
  out.sort((p, q) => order[p.status] - order[q.status]
    || (p.status === 'ended' ? q.startMs - p.startMs : p.startMs - q.startMs));
  return out;
}

export const events = async (req, res) => {
  try {
    if (CACHE.data && Date.now() - CACHE.at < 60000) return res.json(CACHE.data);
    const data = await buildEvents();
    CACHE = { at: Date.now(), data };
    res.set('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (e) {
    if (CACHE.data) return res.json(CACHE.data);            // serve stale on upstream hiccup
    res.status(502).json({ error: String(e.message || e) });
  }
};

// exported for an offline unit test
export const _internal = { decryptV2, smartDecrypt, X, TOKEN };
