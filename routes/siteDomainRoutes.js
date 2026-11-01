// =====================================================================
// Source domains — set by the admin when a site moves
//
//   GET    /             every site: the domain in use, the default, who changed it   admin only
//   POST   /:site/test   { base? }  is that domain (or the current one) the site?     admin only
//   PUT    /:site        { base, force? }  use this domain from now on                admin only
//   DELETE /:site        back to the default                                         admin only
//
// A domain that does not answer, or answers as something else, is refused
// unless `force` is set — a typo should not take a source offline. See
// utils/siteDomains.js for how the change reaches every copy of the backend.
// =====================================================================

import express from 'express';
import { requireAdmin, emailFrom } from './serverOrderRoutes.js';
import { SITES, domainOf, defaultBase, overrideOf, normalizeBase, probe, setDomain, clearDomain } from '../utils/siteDomains.js';
import { currentBase as hdhubBase } from './hdhubRoutes.js';

const router = express.Router();
router.use(requireAdmin);

const known = (site) => Object.prototype.hasOwnProperty.call(SITES, site);

async function row(site) {
    const o = overrideOf(site);
    return {
        site, name: SITES[site].name,
        /* HDHub4u also finds its own domain of the day; that is what it uses
           when the admin has not set one. */
        current: site === 'hdhub' ? await hdhubBase() : domainOf(site),
        default: defaultBase(site),
        override: o ? { base: o.base, updatedBy: o.updatedBy, updatedAt: o.updatedAt } : null,
    };
}

router.get('/', async (_req, res) => {
    res.json({ sites: await Promise.all(Object.keys(SITES).map(row)) });
});

router.post('/:site/test', async (req, res) => {
    const { site } = req.params;
    if (!known(site)) return res.status(404).json({ success: false, message: 'No such site' });
    const base = req.body?.base ? normalizeBase(req.body.base) : (site === 'hdhub' ? await hdhubBase() : domainOf(site));
    if (!base) return res.status(400).json({ success: false, message: 'That is not a domain' });
    res.json({ success: true, base, ...(await probe(site, base)) });
});

/* POST /:site/fetch — when a source is down, find a working domain on demand
   instead of hunting for it by hand. Probes the known candidates best-first
   (HDHub4u's live domain-of-the-day, the current override, the env/default, the
   built-in fallback) and, if one answers as the real site, switches to it. */
router.post('/:site/fetch', async (req, res) => {
    const { site } = req.params;
    if (!known(site)) return res.status(404).json({ success: false, message: 'No such site' });

    const current = site === 'hdhub' ? await hdhubBase() : domainOf(site);
    const cands = [];
    if (site === 'hdhub') { try { cands.push(await hdhubBase()); } catch { /* lookup down */ } }
    const o = overrideOf(site);
    if (o?.base) cands.push(o.base);
    cands.push(defaultBase(site));
    if (SITES[site].fallback) cands.push(SITES[site].fallback);

    const seen = new Set();
    const tried = [];
    let working = null;
    for (const raw of cands) {
        const base = normalizeBase(raw);
        if (!base || seen.has(base)) continue;
        seen.add(base);
        const check = await probe(site, base);
        tried.push({ base, ...check });
        if (check.ok && check.looksRight) { working = base; break; }
    }

    let applied = false;
    if (working && working !== current) {
        await setDomain(site, working, `${await emailFrom(req) || 'admin'} (fetch)`);
        console.log(`🌐 ${SITES[site].name} domain (fetch) → ${working}`);
        applied = true;
    }
    res.json({
        success: !!working, found: working, applied, tried,
        message: working
            ? (applied ? `Switched to ${working}` : `Already on a working domain (${working})`)
            : 'None of the known domains answered — enter one manually',
        site: await row(site),
    });
});

router.put('/:site', async (req, res) => {
    const { site } = req.params;
    if (!known(site)) return res.status(404).json({ success: false, message: 'No such site' });
    const base = normalizeBase(req.body?.base);
    if (!base) return res.status(400).json({ success: false, message: 'Type a domain, like www.1tamilmv.example' });
    const check = await probe(site, base);
    if (!req.body?.force && !(check.ok && check.looksRight)) {
        const why = !check.ok
            ? (check.status ? `answered ${check.status}` : (check.error || 'did not answer'))
            : `answered, but does not look like ${SITES[site].name}`;
        return res.status(422).json({ success: false, needsForce: true, check, base,
            message: `${base} ${why}${check.redirectedTo ? ` (it forwards to ${check.redirectedTo})` : ''}` });
    }
    const by = String(await emailFrom(req) || '');
    await setDomain(site, base, by);
    console.log(`🌐 ${SITES[site].name} domain → ${base}${req.body?.force ? ' (saved without a passing check)' : ''} by ${by || 'admin'}`);
    res.json({ success: true, check, site: await row(site) });
});

router.delete('/:site', async (req, res) => {
    const { site } = req.params;
    if (!known(site)) return res.status(404).json({ success: false, message: 'No such site' });
    await clearDomain(site);
    res.json({ success: true, site: await row(site) });
});

export default router;
