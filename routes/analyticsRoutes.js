// =====================================================================
// Site analytics — our own visitor tracking, read on Admin → Analytics
//
//   POST /collect          a page view, a heartbeat or a leave, from the site   public
//                          ("forget": the admin's browser — its visits are deleted)
//        { t: "view"|"ping"|"leave"|"forget", sid, vid, nv, path, title, ref, sw, sh,
//          lang, tz, utm: { source, medium, campaign }, u, d }
//   GET  /summary?days=30  the dashboard: online now, today against yesterday,
//                          visitors per day, and where / on what they came    admin
//   GET  /live             everyone on the site right now, with details       admin
//   GET  /sessions?limit=&before=&country=&device=&q=   recent visits          admin
//   GET  /watch?days=30    watch time in AnchorHD: totals, per day, most-watched  admin
//   GET  /watch/title?slug=&days=30   one title: its episodes, who watched     admin
//
// Watch time ("watch" beacons from AnchorHD's player): the seconds a title
// actually played — paused and skipped-over time is not counted — and how far
// in the viewer got, one record per visit per title (per episode for a
// series). "Viewers" of a title are distinct visitors, so a rewatch or a
// second tab is one viewer.
//
// One document per visit (a "session": one browser tab's stay, sid), keyed by
// the visitor (vid, kept in the browser, so a returning visitor is counted
// once a day). Where a visitor is comes from the IP Cloudflare hands us
// (CF-Connecting-IP) — its country header, then an offline GeoIP lookup for
// the region and city, so no visitor's IP goes to a third party. The device
// is read from the user agent. Visits are kept 90 days, then Mongo drops them.
//
// "Online" is a visit heard from in the last 90 s: a page sends a heartbeat
// every 30 s while it is open and visible, and a leave when it is closed.
// Days are counted in IST — the site's audience, and the admin's clock.
// =====================================================================

import express from 'express';
import mongoose from 'mongoose';
import geoip from 'geoip-lite';
import { UAParser } from 'ua-parser-js';
import { requireAdmin } from './serverOrderRoutes.js';

const router = express.Router();

const pageSchema = new mongoose.Schema({ p: String, t: String, at: Date }, { _id: false });
const sessionSchema = new mongoose.Schema({
    sid: { type: String, unique: true },
    vid: { type: String, index: true },
    newVisitor: Boolean,
    startedAt: { type: Date, index: true },
    lastSeen: { type: Date, index: true },
    endedAt: Date,
    activeSec: { type: Number, default: 0 },
    ip: String,
    country: String, countryCode: String, region: String, city: String, ll: [Number], tz: String,
    deviceType: String, vendor: String, model: String,
    browser: String, browserVer: String, os: String, osVer: String,
    screen: String, lang: String,
    ref: String, refDomain: String,
    utmSource: String, utmMedium: String, utmCampaign: String,
    user: String,
    entry: String, currentPath: String, currentTitle: String,
    pageCount: { type: Number, default: 0 },
    pages: [pageSchema],
}, { versionKey: false });
sessionSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 86400, name: 'ttl90' });
const Visit = mongoose.models.analyticsSession || mongoose.model('analyticsSession', sessionSchema);

const watchSchema = new mongoose.Schema({
    sid: String, vid: { type: String, index: true }, key: String,
    slug: { type: String, index: true }, title: String, contentType: String,
    season: Number, episode: Number, epTitle: String, tmdbId: String, poster: String, source: String,
    startedAt: Date, lastAt: { type: Date, index: true },
    seconds: { type: Number, default: 0 }, maxPos: { type: Number, default: 0 }, duration: Number,
}, { versionKey: false });
watchSchema.index({ sid: 1, key: 1 }, { unique: true });
watchSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 86400, name: 'ttl90' });
const Watch = mongoose.models.analyticsWatch || mongoose.model('analyticsWatch', watchSchema);

const IST_MS = 330 * 60e3;
const ONLINE_MS = 90e3;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || 'sanjusanjay0444@gmail.com').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|prerender|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|axios|node-fetch|go-http/i;
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (cc) => { try { return cc ? regionName.of(cc) : ''; } catch { return cc || ''; } };
const clip = (s, n) => String(s ?? '').slice(0, n);

const clientIp = (req) => {
    const raw = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '';
    return String(raw).trim().replace(/^::ffff:/, '');
};

/* Where: Cloudflare's country is the most reliable (it is theirs, from the
   edge the visitor reached); the city and region come from the offline
   database, and only when it agrees on the country. */
function placeOf(req, ip) {
    const cf = String(req.headers['cf-ipcountry'] || '').toUpperCase();
    const g = ip ? geoip.lookup(ip) : null;
    const cc = (/^[A-Z]{2}$/.test(cf) && cf !== 'XX' && cf !== 'T1') ? cf : (g?.country || '');
    const same = g && (!cc || g.country === cc);
    return {
        countryCode: cc, country: countryName(cc),
        region: same ? (g.region || '') : '', city: same ? (g.city || '') : '',
        ll: same && Array.isArray(g.ll) ? g.ll : [], tz: same ? (g.timezone || '') : '',
    };
}

function deviceOf(ua) {
    const r = new UAParser(ua).getResult();
    const type = r.device.type === 'mobile' ? 'Mobile' : r.device.type === 'tablet' ? 'Tablet'
        : r.device.type === 'smarttv' ? 'TV' : r.device.type === 'console' ? 'Console'
        : /Mobi|Android(?!.*Tablet)/i.test(ua) ? 'Mobile' : 'Desktop';
    return {
        deviceType: type, vendor: r.device.vendor || '', model: r.device.model || '',
        browser: r.browser.name || 'Other', browserVer: (r.browser.version || '').split('.')[0],
        os: r.os.name || 'Other', osVer: r.os.version || '',
    };
}

const domainOf = (ref) => { try { return ref ? new URL(ref).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
const OWN = /(^|\.)1anchormovies\.(buzz|live|com)$/i;

/* A visitor's tab sends a few requests a minute at most; anything far past
   that from one address is not a person. */
const hits = new Map();
const tooMany = (ip) => {
    const now = Date.now(), m = Math.floor(now / 60e3);
    const h = hits.get(ip);
    if (!h || h.m !== m) { hits.set(ip, { m, n: 1 }); if (hits.size > 50000) hits.clear(); return false; }
    return ++h.n > 120;
};

/* sendBeacon posts as text/plain (no CORS preflight), so the body is parsed here. */
router.post('/collect', express.text({ type: '*/*', limit: '8kb' }), async (req, res) => {
    // Answered once written, so a tab's view, heartbeat and leave land in order.
    await record(req).catch(() => { /* a malformed beacon is dropped */ });
    res.status(204).end();
});

async function record(req) {
    {
        const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const ua = String(req.headers['user-agent'] || '');
        const ip = clientIp(req);
        if (!ID.test(b.sid || '') || !ID.test(b.vid || '') || BOT.test(ua) || tooMany(ip)) return;
        /* The admin is not a visitor. Their browser asks to be forgotten once
           (every visit it sent goes), and a signed-in admin is never stored. */
        if (b.t === 'forget') { await Promise.all([Visit.deleteMany({ vid: b.vid }), Watch.deleteMany({ vid: b.vid })]); return; }
        if (b.u && ADMIN_EMAILS.includes(String(b.u).toLowerCase())) {
            await Promise.all([Visit.deleteMany({ $or: [{ sid: b.sid }, { vid: b.vid }] }), Watch.deleteMany({ vid: b.vid })]);
            return;
        }
        const now = new Date();
        const path = clip(b.path, 300) || '/';
        const title = clip(b.title, 200);
        const active = Math.max(0, Math.min(Number(b.d) || 0, 120));

        if (b.t === 'view') {
            const ref = clip(b.ref, 500);
            const refDomain = domainOf(ref);
            await Visit.updateOne({ sid: b.sid }, {
                $setOnInsert: {
                    sid: b.sid, vid: b.vid, newVisitor: !!b.nv, startedAt: now, ip,
                    ...placeOf(req, ip), ...deviceOf(ua),
                    screen: b.sw && b.sh ? `${Number(b.sw) | 0}×${Number(b.sh) | 0}` : '',
                    lang: clip(b.lang, 20),
                    ref: OWN.test(refDomain) ? '' : ref, refDomain: OWN.test(refDomain) ? '' : refDomain,
                    utmSource: clip(b.utm?.source, 80), utmMedium: clip(b.utm?.medium, 80), utmCampaign: clip(b.utm?.campaign, 80),
                    entry: path,
                },
                $set: { lastSeen: now, currentPath: path, currentTitle: title, endedAt: null, ...(b.u ? { user: clip(b.u, 120) } : {}) },
                $inc: { pageCount: 1, activeSec: active },
                $push: { pages: { $each: [{ p: path, t: title, at: now }], $slice: -60 } },
            }, { upsert: true });
        } else if (b.t === 'watch') {
            /* Seconds played since the last beacon (sent every 30 s), so a
               value past a few minutes is not one. */
            const sec = Math.max(0, Math.min(Number(b.sec) || 0, 300));
            const slug = clip(b.slug, 200);
            if (!slug || !sec) return;
            const season = Number(b.season) > 0 ? Math.floor(Number(b.season)) : null;
            const episode = Number(b.episode) > 0 ? Math.floor(Number(b.episode)) : null;
            const key = `${slug}|${season || ''}|${episode || ''}`;
            const pos = Math.max(0, Number(b.pos) || 0);
            const dur = Number(b.dur) > 0 && Number(b.dur) < 86400 ? Number(b.dur) : null;
            await Promise.all([
                Watch.updateOne({ sid: b.sid, key }, {
                    $setOnInsert: { sid: b.sid, vid: b.vid, key, slug, season, episode, startedAt: now },
                    $set: {
                        lastAt: now, title: clip(b.title, 200), contentType: b.type === 'tv' ? 'tv' : 'movie',
                        epTitle: clip(b.epTitle, 200), tmdbId: clip(b.tmdbId, 20), poster: clip(b.poster, 400), source: clip(b.source, 80),
                        ...(dur ? { duration: dur } : {}),
                    },
                    $inc: { seconds: sec },
                    $max: { maxPos: pos },
                }, { upsert: true }),
                Visit.updateOne({ sid: b.sid }, { $set: { lastSeen: now, endedAt: null } }),
            ]);
        } else if (b.t === 'ping' || b.t === 'leave') {
            await Visit.updateOne({ sid: b.sid }, {
                $set: { lastSeen: now, ...(b.t === 'leave' ? { endedAt: now } : { endedAt: null }), ...(b.path ? { currentPath: path, currentTitle: title } : {}) },
                $inc: { activeSec: active },
            });
        }
    }
}

// ---------- admin ----------
router.use(requireAdmin);

const istDayStart = (t = Date.now()) => new Date(Math.floor((t + IST_MS) / 86400e3) * 86400e3 - IST_MS);
const durationExpr = { $divide: [{ $subtract: ['$lastSeen', '$startedAt'] }, 1000] };

async function totals(from, to) {
    const [r] = await Visit.aggregate([
        { $match: { startedAt: { $gte: from, $lt: to } } },
        { $group: {
            _id: null, sessions: { $sum: 1 }, visitors: { $addToSet: '$vid' }, views: { $sum: '$pageCount' },
            dur: { $avg: durationExpr }, bounces: { $sum: { $cond: [{ $lte: ['$pageCount', 1] }, 1, 0] } },
            newV: { $sum: { $cond: ['$newVisitor', 1, 0] } },
        } },
        { $project: { _id: 0, sessions: 1, visitors: { $size: '$visitors' }, views: 1, avgDuration: { $round: ['$dur', 0] }, bounceRate: { $cond: [{ $gt: ['$sessions', 0] }, { $round: [{ $multiply: [{ $divide: ['$bounces', '$sessions'] }, 100] }, 1] }, 0] }, newVisitors: '$newV' } },
    ]);
    return r || { sessions: 0, visitors: 0, views: 0, avgDuration: 0, bounceRate: 0, newVisitors: 0 };
}

const top = (field, n = 12, extra = {}) => [
    { $group: { _id: field, sessions: { $sum: 1 }, visitors: { $addToSet: '$vid' }, ...extra } },
    { $project: { _id: 0, key: '$_id', sessions: 1, visitors: { $size: '$visitors' }, ...Object.fromEntries(Object.keys(extra).map((k) => [k, 1])) } },
    { $sort: { visitors: -1, sessions: -1 } }, { $limit: n },
];

router.get('/summary', async (req, res) => {
    try {
        const days = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
        const now = Date.now();
        const today = istDayStart(now);
        const yesterday = new Date(today.getTime() - 86400e3);
        const from = new Date(today.getTime() - (days - 1) * 86400e3);
        const tz = '+05:30';

        const [online, todayT, yestT, rangeT, [facets]] = await Promise.all([
            Visit.countDocuments({ lastSeen: { $gte: new Date(now - ONLINE_MS) }, endedAt: null }),
            totals(today, new Date(now + 1)),
            totals(yesterday, new Date(yesterday.getTime() + Math.min(now - today.getTime(), 86400e3))),   // yesterday up to this time of day
            totals(from, new Date(now + 1)),
            Visit.aggregate([
                { $match: { startedAt: { $gte: from } } },
                { $facet: {
                    daily: [
                        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: tz } }, sessions: { $sum: 1 }, visitors: { $addToSet: '$vid' }, views: { $sum: '$pageCount' }, newV: { $sum: { $cond: ['$newVisitor', 1, 0] } } } },
                        { $project: { _id: 0, day: '$_id', sessions: 1, views: 1, visitors: { $size: '$visitors' }, newVisitors: '$newV' } },
                        { $sort: { day: 1 } },
                    ],
                    hours: [
                        { $group: { _id: { $hour: { date: '$startedAt', timezone: tz } }, sessions: { $sum: 1 } } },
                        { $project: { _id: 0, hour: '$_id', sessions: 1 } }, { $sort: { hour: 1 } },
                    ],
                    countries: top({ code: '$countryCode', name: '$country' }, 20),
                    cities: [{ $match: { city: { $nin: ['', null] } } }, ...top({ city: '$city', region: '$region', code: '$countryCode' }, 20)],
                    devices: top('$deviceType', 6),
                    browsers: top('$browser', 8),
                    os: top('$os', 8),
                    models: [{ $match: { model: { $nin: ['', null] } } }, ...top({ vendor: '$vendor', model: '$model' }, 10)],
                    referrers: top({ $cond: [{ $in: ['$refDomain', ['', null]] }, 'Direct / none', '$refDomain'] }, 12),
                    campaigns: [{ $match: { utmSource: { $nin: ['', null] } } }, ...top({ source: '$utmSource', medium: '$utmMedium', campaign: '$utmCampaign' }, 10)],
                    entries: top('$entry', 10),
                    pages: [
                        { $unwind: '$pages' },
                        { $group: { _id: '$pages.p', views: { $sum: 1 }, title: { $last: '$pages.t' }, visitors: { $addToSet: '$vid' } } },
                        { $project: { _id: 0, key: '$_id', title: 1, views: 1, visitors: { $size: '$visitors' } } },
                        { $sort: { views: -1 } }, { $limit: 15 },
                    ],
                    languages: top('$lang', 8),
                    screens: top('$screen', 8),
                    points: [
                        { $match: { 'll.1': { $exists: true } } },
                        { $group: { _id: { lat: { $round: [{ $arrayElemAt: ['$ll', 0] }, 1] }, lon: { $round: [{ $arrayElemAt: ['$ll', 1] }, 1] } }, n: { $sum: 1 }, city: { $first: '$city' } } },
                        { $project: { _id: 0, lat: '$_id.lat', lon: '$_id.lon', n: 1, city: 1 } }, { $sort: { n: -1 } }, { $limit: 400 },
                    ],
                } },
            ]),
        ]);

        // Every day in the range, a zero for one with no visits.
        const byDay = new Map(facets.daily.map((d) => [d.day, d]));
        const daily = Array.from({ length: days }, (_, i) => {
            const day = new Date(from.getTime() + i * 86400e3 + IST_MS).toISOString().slice(0, 10);
            return byDay.get(day) || { day, sessions: 0, views: 0, visitors: 0, newVisitors: 0 };
        });
        const hours = Array.from({ length: 24 }, (_, h) => facets.hours.find((x) => x.hour === h)?.sessions || 0);

        res.json({ success: true, generatedAt: new Date(now), days, online, today: todayT, yesterday: yestT, range: rangeT, ...facets, daily, hours });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

const PUBLIC_FIELDS = '-_id sid vid newVisitor startedAt lastSeen endedAt activeSec ip country countryCode region city tz deviceType vendor model browser browserVer os osVer screen lang ref refDomain utmSource utmMedium utmCampaign user entry currentPath currentTitle pageCount pages';

router.get('/live', async (_req, res) => {
    try {
        const now = Date.now();
        const [visits, recent] = await Promise.all([
            Visit.find({ lastSeen: { $gte: new Date(now - ONLINE_MS) }, endedAt: null }).sort({ lastSeen: -1 }).limit(300).select(PUBLIC_FIELDS).lean(),
            // Page views in the last 30 minutes, per minute — the live chart.
            Visit.aggregate([
                { $match: { lastSeen: { $gte: new Date(now - 30 * 60e3) } } },
                { $unwind: '$pages' },
                { $match: { 'pages.at': { $gte: new Date(now - 30 * 60e3) } } },
                { $group: { _id: { $floor: { $divide: [{ $subtract: [new Date(now), '$pages.at'] }, 60e3] } }, views: { $sum: 1 } } },
            ]),
        ]);
        const perMinute = Array.from({ length: 30 }, (_, i) => recent.find((r) => r._id === 29 - i)?.views || 0);
        // What each of them is playing in AnchorHD right now (heard from in the last 90 s).
        const playing = await Watch.find({ sid: { $in: visits.map((v) => v.sid) }, lastAt: { $gte: new Date(now - ONLINE_MS) } })
            .select('-_id sid slug title season episode epTitle seconds maxPos duration lastAt').lean();
        const bySid = new Map(playing.map((w) => [w.sid, w]));
        res.json({ success: true, generatedAt: new Date(now), online: visits.length, watching: playing.length,
            visits: visits.map((v) => ({ ...v, pages: v.pages.slice(-15), playing: bySid.get(v.sid) || null })), perMinute });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/sessions', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
        const q = {};
        if (req.query.before) q.startedAt = { $lt: new Date(req.query.before) };
        if (req.query.country) q.countryCode = String(req.query.country).toUpperCase().slice(0, 2);
        if (req.query.device) q.deviceType = String(req.query.device).slice(0, 20);
        if (req.query.q) {
            const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60), 'i');
            q.$or = [{ city: rx }, { country: rx }, { ip: rx }, { 'pages.p': rx }, { 'pages.t': rx }, { refDomain: rx }, { user: rx }, { model: rx }];
        }
        const visits = await Visit.find(q).sort({ startedAt: -1 }).limit(limit).select(PUBLIC_FIELDS).lean();
        const watched = await Watch.find({ sid: { $in: visits.map((v) => v.sid) } }).sort({ startedAt: 1 })
            .select('-_id sid slug title season episode epTitle seconds maxPos duration startedAt').lean();
        const bySid = new Map();
        for (const w of watched) (bySid.get(w.sid) || bySid.set(w.sid, []).get(w.sid)).push(w);
        res.json({ success: true, visits: visits.map((v) => ({ ...v, watched: bySid.get(v.sid) || [] })), next: visits.length === limit ? visits[visits.length - 1].startedAt : null });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

/* A play "finished" when it reached the last 10 % (credits included). */
const finishedExpr = { $cond: [{ $and: [{ $gt: ['$duration', 0] }, { $gte: [{ $divide: ['$maxPos', '$duration'] }, 0.9] }] }, 1, 0] };

router.get('/watch', async (req, res) => {
    try {
        const days = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
        const now = Date.now();
        const today = istDayStart(now);
        const from = new Date(today.getTime() - (days - 1) * 86400e3);
        const tz = '+05:30';
        const [[f], watchingNow] = await Promise.all([
            Watch.aggregate([
                { $match: { startedAt: { $gte: from } } },
                { $facet: {
                    totals: [{ $group: { _id: null, seconds: { $sum: '$seconds' }, viewers: { $addToSet: '$vid' }, plays: { $sum: 1 }, titles: { $addToSet: '$slug' } } },
                        { $project: { _id: 0, seconds: 1, plays: 1, viewers: { $size: '$viewers' }, titles: { $size: '$titles' } } }],
                    today: [{ $match: { startedAt: { $gte: today } } },
                        { $group: { _id: null, seconds: { $sum: '$seconds' }, viewers: { $addToSet: '$vid' }, plays: { $sum: 1 } } },
                        { $project: { _id: 0, seconds: 1, plays: 1, viewers: { $size: '$viewers' } } }],
                    daily: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: tz } }, seconds: { $sum: '$seconds' }, viewers: { $addToSet: '$vid' } } },
                        { $project: { _id: 0, day: '$_id', seconds: 1, viewers: { $size: '$viewers' } } }, { $sort: { day: 1 } }],
                    titles: [
                        { $sort: { lastAt: 1 } },
                        { $group: { _id: '$slug', title: { $last: '$title' }, poster: { $last: '$poster' }, contentType: { $last: '$contentType' },
                            viewers: { $addToSet: '$vid' }, plays: { $sum: 1 }, seconds: { $sum: '$seconds' }, finished: { $sum: finishedExpr },
                            episodes: { $addToSet: '$key' }, lastAt: { $max: '$lastAt' } } },
                        { $project: { _id: 0, slug: '$_id', title: 1, poster: 1, contentType: 1, plays: 1, seconds: 1, lastAt: 1,
                            viewers: { $size: '$viewers' }, episodes: { $size: '$episodes' },
                            completion: { $round: [{ $multiply: [{ $divide: ['$finished', '$plays'] }, 100] }, 0] } } },
                        { $addFields: { avgPerViewer: { $round: [{ $divide: ['$seconds', { $max: ['$viewers', 1] }] }, 0] } } },
                        { $sort: { viewers: -1, seconds: -1 } }, { $limit: 60 },
                    ],
                } },
            ]),
            Watch.countDocuments({ lastAt: { $gte: new Date(now - ONLINE_MS) } }),
        ]);
        const byDay = new Map(f.daily.map((d) => [d.day, d]));
        const daily = Array.from({ length: days }, (_, i) => {
            const day = new Date(from.getTime() + i * 86400e3 + IST_MS).toISOString().slice(0, 10);
            return byDay.get(day) || { day, seconds: 0, viewers: 0 };
        });
        res.json({ success: true, days, watchingNow,
            totals: f.totals[0] || { seconds: 0, plays: 0, viewers: 0, titles: 0 },
            today: f.today[0] || { seconds: 0, plays: 0, viewers: 0 }, daily, titles: f.titles });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/watch/title', async (req, res) => {
    try {
        const slug = clip(req.query.slug, 200);
        if (!slug) return res.status(400).json({ success: false, message: 'slug is required' });
        const days = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
        const from = new Date(istDayStart().getTime() - (days - 1) * 86400e3);
        const match = { slug, startedAt: { $gte: from } };
        const [episodes, recent] = await Promise.all([
            Watch.aggregate([
                { $match: match },
                { $group: { _id: { s: '$season', e: '$episode' }, epTitle: { $last: '$epTitle' }, viewers: { $addToSet: '$vid' }, plays: { $sum: 1 }, seconds: { $sum: '$seconds' }, finished: { $sum: finishedExpr } } },
                { $project: { _id: 0, season: '$_id.s', episode: '$_id.e', epTitle: 1, plays: 1, seconds: 1, viewers: { $size: '$viewers' },
                    completion: { $round: [{ $multiply: [{ $divide: ['$finished', '$plays'] }, 100] }, 0] } } },
                { $sort: { season: 1, episode: 1 } },
            ]),
            // Who watched, newest first, with where and on what (from their visit).
            Watch.aggregate([
                { $match: match }, { $sort: { lastAt: -1 } }, { $limit: 60 },
                { $lookup: { from: Visit.collection.name, localField: 'sid', foreignField: 'sid', as: 'v',
                    pipeline: [{ $project: { _id: 0, city: 1, region: 1, country: 1, countryCode: 1, deviceType: 1, vendor: 1, model: 1, browser: 1, os: 1, user: 1, refDomain: 1, utmSource: 1 } }] } },
                { $project: { _id: 0, vid: 1, season: 1, episode: 1, epTitle: 1, seconds: 1, maxPos: 1, duration: 1, source: 1, startedAt: 1, lastAt: 1, visit: { $first: '$v' } } },
            ]),
        ]);
        res.json({ success: true, slug, episodes, recent });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

export default router;
