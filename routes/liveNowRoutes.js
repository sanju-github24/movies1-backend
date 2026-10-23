// =====================================================================
// Live now — what the admin has put on air, and the nightly shows' times
//
//   GET    /                 { events: [...running], shows: { slug: {...} } }   anyone
//   POST   /events           { title, link, poster?, sport? }                   the admin
//   DELETE /events/:id                                                           the admin
//   PUT    /shows/:slug      { enabled, channelLink, channelName,
//                              weekday: {start, end}, weekend: {start, end} }    the admin
//
// An event is live from when it is added until it is deleted. Its link is
// what plays: a tab link the live pages already use (…/?tab=live&id=757),
// or a stream's own .m3u8 / .mpd address.
//
// A show's entry overrides what the site has coded for it (Bigg Boss
// Kannada's 9:30–10:40): switched off, it is not live at all; its times and
// channel can be changed; a new slug adds a nightly show. Times are IST "HH:MM".
// =====================================================================

import express from 'express';
import mongoose from 'mongoose';
import { requireAdmin } from './serverOrderRoutes.js';

const router = express.Router();

const eventSchema = new mongoose.Schema({
    title: { type: String, required: true },
    link: { type: String, required: true },
    poster: { type: String, default: '' },
    sport: { type: String, default: '' },
}, { timestamps: true });
const LiveEvent = mongoose.models.liveEvent || mongoose.model('liveEvent', eventSchema);

const showSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    channelLink: { type: String, default: '' },
    channelName: { type: String, default: '' },
    weekday: { start: String, end: String },
    weekend: { start: String, end: String },
}, { timestamps: true });
const LiveShow = mongoose.models.liveShow || mongoose.model('liveShow', showSchema);

const clean = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const HTTPS = /^https:\/\/[^\s]+$/i;
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

let cached = null;   // { at, value } — read on every page load, written rarely
const forget = () => { cached = null; };

router.get('/', async (_req, res) => {
    if (cached && Date.now() - cached.at < 30e3) return res.json(cached.value);
    try {
        const [events, shows] = await Promise.all([
            LiveEvent.find().sort({ createdAt: -1 }).limit(50).lean(),
            LiveShow.find().lean(),
        ]);
        const value = {
            events: events.map((e) => ({ id: String(e._id), title: e.title, link: e.link, poster: e.poster, sport: e.sport, since: e.createdAt })),
            shows: Object.fromEntries(shows.map((s) => [s.slug, {
                name: s.name, enabled: s.enabled, channelLink: s.channelLink, channelName: s.channelName,
                weekday: s.weekday, weekend: s.weekend,
            }])),
        };
        cached = { at: Date.now(), value };
        res.set('Cache-Control', 'public, max-age=30');
        res.json(value);
    } catch {
        res.json({ events: [], shows: {} });   // nothing live is never a reason to break a page
    }
});

router.post('/events', requireAdmin, async (req, res) => {
    const title = clean(req.body?.title, 160);
    const link = clean(req.body?.link, 2000);
    const poster = clean(req.body?.poster, 2000);
    if (!title || !HTTPS.test(link)) return res.status(400).json({ success: false, message: 'A title and an https link are required' });
    if (poster && !HTTPS.test(poster)) return res.status(400).json({ success: false, message: 'The poster must be an https link' });
    const e = await LiveEvent.create({ title, link, poster, sport: clean(req.body?.sport, 40) });
    forget();
    res.json({ success: true, id: String(e._id) });
});

router.delete('/events/:id', requireAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false });
    await LiveEvent.deleteOne({ _id: req.params.id });
    forget();
    res.json({ success: true });
});

router.put('/shows/:slug', requireAdmin, async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!SLUG.test(slug)) return res.status(400).json({ success: false, message: 'Bad slug' });
    const b = req.body || {};
    const span = (x) => (x && HHMM.test(x.start) && HHMM.test(x.end) ? { start: x.start, end: x.end } : undefined);
    const update = { enabled: b.enabled !== false };
    if (b.name) update.name = clean(b.name, 120);
    if (b.channelLink) {
        if (!HTTPS.test(b.channelLink)) return res.status(400).json({ success: false, message: 'The channel must be an https link' });
        update.channelLink = clean(b.channelLink, 2000);
    }
    if (b.channelName) update.channelName = clean(b.channelName, 80);
    if (span(b.weekday)) update.weekday = span(b.weekday);
    if (span(b.weekend)) update.weekend = span(b.weekend);
    await LiveShow.findOneAndUpdate({ slug }, update, { upsert: true });
    forget();
    res.json({ success: true });
});

export default router;
