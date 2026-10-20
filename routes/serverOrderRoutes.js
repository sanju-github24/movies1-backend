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
import userAuth from '../middleware/userAuth.js';
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

async function requireAdmin(req, res, next) {
    try {
        const user = await userModel.findById(req.user?.userId).select('email');
        if (user && ADMIN_EMAILS.includes(String(user.email).toLowerCase())) return next();
    } catch { /* not found */ }
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

router.put('/:slug', userAuth, requireAdmin, async (req, res) => {
    const slug = String(req.params.slug || '');
    const order = Array.isArray(req.body?.order) ? req.body.order.map(String).filter((x) => ID.test(x)).slice(0, 40) : null;
    if (!SLUG.test(slug) || !order) return res.status(400).json({ success: false, message: 'A slug and an order are required' });
    await ServerOrder.findOneAndUpdate({ slug }, { order, updatedBy: req.user.userId }, { upsert: true });
    cache.set(slug, { at: Date.now(), order });
    res.json({ success: true, order });
});

router.delete('/:slug', userAuth, requireAdmin, async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!SLUG.test(slug)) return res.status(400).json({ success: false });
    await ServerOrder.deleteOne({ slug });
    cache.delete(slug);
    res.json({ success: true, order: [] });
});

export default router;
