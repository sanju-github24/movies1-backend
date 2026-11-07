// =====================================================================
// Scan to sign in — a signed-in phone signs a new browser in.
//
//   POST /create          the sign-in page asks for a code
//                           → { id, secret, expiresIn }
//                         The QR carries only the id; the secret never leaves
//                         the browser that asked, so nobody who merely sees
//                         the QR can collect the session.
//   POST /:id/poll        { secret } — that browser waits for an answer
//                           → { status: 'pending' | 'expired' }
//                           → { status: 'approved', token_hash }   (once)
//   GET  /:id/info        Bearer <the phone's Supabase token> — what the
//                         approve page shows: which browser is asking
//   POST /:id/approve     Bearer — the phone says yes
//   POST /:id/deny        Bearer — the phone says no
//
// "Approved" mints a ONE-TIME Supabase login token for the phone's account
// (admin.generateLink — no mail is sent). The new browser trades it with
// supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) and gets its
// OWN session: no refresh token is ever copied between devices.
//
// Codes live in memory for two minutes and work once. Needs SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY; without them /create answers 503 and the page
// simply leaves the QR out.
// =====================================================================

import express from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

const TTL = 120_000;          // a code lives two minutes
const MAX_CODES = 5000;       // memory ceiling under abuse
const store = new Map();      // id → { secretHash, exp, status, tokenHash, ua, created }

const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => {
    const x = Buffer.from(a); const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

let _admin;
const admin = () => {
    if (_admin !== undefined) return _admin;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    _admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
    return _admin;
};

/* A small per-IP counter (per minute), enough to stop a loop from filling the
   store or hammering Supabase. */
const hits = new Map();
const tooMany = (req, bucket, max) => {
    const k = `${bucket}:${req.ip}`;
    const now = Date.now();
    const h = hits.get(k);
    if (!h || now - h.t > 60_000) { hits.set(k, { t: now, n: 1 }); return false; }
    return ++h.n > max;
};

const sweep = () => {
    const now = Date.now();
    for (const [id, e] of store) if (e.exp < now) store.delete(id);
    for (const [k, h] of hits) if (now - h.t > 60_000) hits.delete(k);
};
setInterval(sweep, 30_000).unref?.();

const deviceOf = (ua = '') => {
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'a device';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    return `${br} on ${os}`;
};

const live = (id) => {
    const e = store.get(id);
    if (!e) return null;
    if (e.exp < Date.now()) { store.delete(id); return null; }
    return e;
};

/* The phone's Supabase access token → its user (or null). */
async function userFrom(req) {
    const a = admin();
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!a || !token) return null;
    const { data, error } = await a.auth.getUser(token);
    return error ? null : data?.user || null;
}

router.post('/create', (req, res) => {
    if (!admin()) return res.status(503).json({ error: 'unavailable' });
    if (tooMany(req, 'create', 20)) return res.status(429).json({ error: 'slow_down' });
    if (store.size >= MAX_CODES) sweep();
    if (store.size >= MAX_CODES) return res.status(429).json({ error: 'busy' });
    const id = rnd(12);
    const secret = rnd(24);
    store.set(id, { secretHash: sha(secret), exp: Date.now() + TTL, status: 'pending', ua: String(req.headers['user-agent'] || '').slice(0, 300) });
    res.set('Cache-Control', 'no-store');
    res.json({ id, secret, expiresIn: TTL / 1000 });
});

router.post('/:id/poll', (req, res) => {
    if (tooMany(req, 'poll', 120)) return res.status(429).json({ status: 'pending' });
    res.set('Cache-Control', 'no-store');
    const e = live(req.params.id);
    // A wrong secret looks exactly like an expired code: nothing to learn from it.
    if (!e || !sameHash(e.secretHash, sha(req.body?.secret || ''))) return res.json({ status: 'expired' });
    if (e.status === 'approved') {
        store.delete(req.params.id);                  // single use
        return res.json({ status: 'approved', token_hash: e.tokenHash });
    }
    res.json({ status: 'pending', expiresIn: Math.max(0, Math.round((e.exp - Date.now()) / 1000)) });
});

router.get('/:id/info', async (req, res) => {
    if (tooMany(req, 'info', 60)) return res.status(429).json({ error: 'slow_down' });
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: 'sign_in_required' });
    const e = live(req.params.id);
    if (!e || e.status !== 'pending') return res.status(404).json({ error: 'expired' });
    res.set('Cache-Control', 'no-store');
    res.json({ device: deviceOf(e.ua), email: user.email || '', expiresIn: Math.max(0, Math.round((e.exp - Date.now()) / 1000)) });
});

router.post('/:id/approve', async (req, res) => {
    if (tooMany(req, 'approve', 20)) return res.status(429).json({ error: 'slow_down' });
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: 'sign_in_required' });
    if (!user.email) return res.status(400).json({ error: 'no_email' });
    const e = live(req.params.id);
    if (!e || e.status !== 'pending') return res.status(404).json({ error: 'expired' });
    try {
        const { data, error } = await admin().auth.admin.generateLink({ type: 'magiclink', email: user.email });
        const hashed = data?.properties?.hashed_token;
        if (error || !hashed) throw new Error(error?.message || 'no token');
        e.status = 'approved';
        e.tokenHash = hashed;
        e.exp = Math.min(e.exp, Date.now() + 30_000);   // the waiting browser has half a minute to collect it
        res.json({ ok: true });
    } catch (err) {
        console.error('[qr-login] approve failed:', err.message);
        res.status(500).json({ error: 'failed' });
    }
});

router.post('/:id/deny', async (req, res) => {
    const user = await userFrom(req);
    if (!user) return res.status(401).json({ error: 'sign_in_required' });
    store.delete(req.params.id);
    res.json({ ok: true });
});

export default router;