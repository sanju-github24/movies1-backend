// =====================================================================
// Server order, per title — set by the admin on the watch page
//
//   GET /:slug          { order: ["ourhls", "tamilmv", …] }   anyone; [] when none is set
//   PUT /:slug          { order: [...] }                       the admin only
//   DELETE /:slug                                              the admin only: back to the default
//
// The admin drags a title's servers into the order they should be tried in;
// the watch page shows them that way and Watch Now starts with the first one
// the title has. Kept in MongoDB, beside the accounts, so every copy of this
// backend serves the same order.
// =====================================================================

import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import userModel from '../models/usermodel.js';

const router = express.Router();

const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || 'sanjusanjay0444@gmail.com')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

const serverOrderSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, index: true },
    order: { type: [String], default: [] },
    updatedBy: { type: String, default: '' },
}, { timestamps: true });
const ServerOrder = mongoose.models.serverOrder || mongoose.model('serverOrder', serverOrderSchema);

const SLUG = /^[a-z0-9][a-z0-9-]{0,200}$/i;
const ID = /^[a-z0-9_-]{1,40}$/i;

// Read often, written rarely: kept briefly in memory.
const cache = new Map();   // slug → { at, order }

/* The site has two sign-ins: its own (a JWT, in a cookie or as a Bearer) and
   Supabase's (Google). The admin may be signed in with either, so either
   token is accepted, and the email behind it decides. */
const supabase = process.env.SUPABASE_URL
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false } })
    : null;
async function emailFrom(req) {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    for (const token of [bearer, req.cookies?.token].filter(Boolean)) {
        try {
            const d = jwt.verify(token, process.env.JWT_SECRET);
            const u = d?.userId && await userModel.findById(d.userId).select('email');
            if (u?.email) return u.email;
        } catch { /* not ours — perhaps Supabase's */ }
        if (supabase) {
            try {
                const { data } = await supabase.auth.getUser(token);
                if (data?.user?.email) return data.user.email;
            } catch { /* not that either */ }
        }
    }
    return '';
}
async function requireAdmin(req, res, next) {
    const email = String(await emailFrom(req)).toLowerCase();
    if (!email) return res.status(401).json({ success: false, message: 'Please sign in again' });
    if (ADMIN_EMAILS.includes(email)) return next();
    res.status(403).json({ success: false, message: 'Admins only' });
}

router.get('/:slug', async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!SLUG.test(slug)) return res.status(400).json({ order: [] });
    const hit = cache.get(slug);
    if (hit && Date.now() - hit.at < 60e3) return res.json({ order: hit.order });
    try {
        const doc = await ServerOrder.findOne({ slug }).lean();
        const order = doc?.order || [];
        cache.set(slug, { at: Date.now(), order });
        if (cache.size > 5000) cache.delete(cache.keys().next().value);
        res.json({ order });
    } catch {
        res.json({ order: [] });   // no order is never a reason to break the page
    }
});

router.put('/:slug', requireAdmin, async (req, res) => {
    const slug = String(req.params.slug || '');
    const order = Array.isArray(req.body?.order) ? req.body.order.map(String).filter((x) => ID.test(x)).slice(0, 40) : null;
    if (!SLUG.test(slug) || !order) return res.status(400).json({ success: false, message: 'A slug and an order are required' });
    await ServerOrder.findOneAndUpdate({ slug }, { order }, { upsert: true });
    cache.set(slug, { at: Date.now(), order });
    res.json({ success: true, order });
});

router.delete('/:slug', requireAdmin, async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!SLUG.test(slug)) return res.status(400).json({ success: false });
    await ServerOrder.deleteOne({ slug });
    cache.delete(slug);
    res.json({ success: true, order: [] });
});

export default router;
