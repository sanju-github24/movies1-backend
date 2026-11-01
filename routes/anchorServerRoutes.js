// =====================================================================
// AnchorHD server order — which sources the main player tries, and in what
// order. The frontend (utils/anchorTmdb.js) reads GET / and builds its provider
// list from it; the admin sets it with PUT /.
//
//   GET  /         { order:[key,...] }   public, cached — the enabled sources in order
//   PUT  /         { order:[key,...] }   admin only — save the order (omitted keys = disabled)
//
// Keys: own, castle, moviebox, languages, singularity, bingr, filmu.
// =====================================================================
import express from 'express';
import mongoose from 'mongoose';
import { requireAdmin, emailFrom } from './serverOrderRoutes.js';

export const SERVER_KEYS = ['own', 'castle', 'moviebox', 'languages', 'singularity', 'bingr', 'filmu'];
// Built-in order — Castle first, then MoviBox.
const DEFAULT_ORDER = ['own', 'castle', 'moviebox', 'languages', 'singularity', 'bingr', 'filmu'];

const schema = new mongoose.Schema({
  _id: { type: String, default: 'anchorServers' },
  order: { type: [String], default: [] },
  updatedBy: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });
const AnchorServerConfig = mongoose.models.anchorServerConfig
  || mongoose.model('anchorServerConfig', schema);

const router = express.Router();

router.get('/', async (_req, res) => {
  const doc = await AnchorServerConfig.findById('anchorServers').lean().catch(() => null);
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ order: doc?.order?.length ? doc.order : DEFAULT_ORDER, keys: SERVER_KEYS, default: DEFAULT_ORDER });
});

router.put('/', requireAdmin, async (req, res) => {
  const raw = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!raw) return res.status(400).json({ success: false, message: 'order must be an array of server keys' });
  // keep only known keys, no duplicates
  const order = [...new Set(raw.filter((k) => SERVER_KEYS.includes(k)))];
  const by = String(await emailFrom(req) || '');
  await AnchorServerConfig.findByIdAndUpdate('anchorServers',
    { order, updatedBy: by, updatedAt: new Date() }, { upsert: true });
  console.log(`🎬 AnchorHD server order → ${order.join(', ')} by ${by || 'admin'}`);
  res.json({ success: true, order });
});

export default router;
