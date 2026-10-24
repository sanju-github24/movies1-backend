// =====================================================================
// The domains of the sites we read from — changeable by the admin
//
// 1TamilMV, HDHub4u and India4Movies move to a new domain whenever the old
// one is blocked or seized. Each used to be a constant here (or an env var on
// the box), so a move meant an edit and a redeploy on every copy of the
// backend. Now the admin types the new one on Admin → Source domains; it is
// kept in MongoDB, so the Delhi primary and the Render standby both pick it
// up within a minute, and nothing is redeployed.
//
// With no override set, a site uses its env var, else the default below.
// =====================================================================

import mongoose from 'mongoose';
import { EventEmitter } from 'node:events';

export const SITES = {
    tamilmv: { name: '1TamilMV', env: 'TAMILMV_BASE', fallback: 'https://www.1tamilmv.capital',
        test: '/', looks: /1TamilMV|ipsTopic|ipsDataItem/i },
    hdhub: { name: 'HDHub4u', env: 'HDHUB_BASE', fallback: 'https://new8.hdhub4u.cl',
        test: '/', looks: /hdhub4u/i },
    i4m: { name: 'India4Movies', env: 'I4M_BASE', fallback: 'https://go6.india4movies.net',
        test: '/wp-json/wp/v2/posts?per_page=1&_fields=id,link', looks: /^\s*\[\s*\{\s*"id"/ },
};

const schema = new mongoose.Schema({
    site: { type: String, required: true, unique: true, index: true },
    base: { type: String, required: true },
    updatedBy: { type: String, default: '' },
}, { timestamps: true });
const SiteDomain = mongoose.models.siteDomain || mongoose.model('siteDomain', schema);

/* Told when a domain changes, so a list built from the old one (the fresh
   releases) can be rebuilt now instead of at its next hourly run. */
export const domainEvents = new EventEmitter();

const overrides = new Map();   // site -> { base, updatedBy, updatedAt }

export const defaultBase = (site) => (process.env[SITES[site].env] || SITES[site].fallback).replace(/\/+$/, '');
export const overrideOf = (site) => overrides.get(site) || null;
/** The domain to use for a site right now — the admin's, else the default. */
export const domainOf = (site) => overrides.get(site)?.base || defaultBase(site);

async function load() {
    try {
        const docs = await SiteDomain.find({ site: { $in: Object.keys(SITES) } }).lean();
        const before = new Map([...overrides].map(([k, v]) => [k, v.base]));
        overrides.clear();
        for (const d of docs) overrides.set(d.site, { base: d.base, updatedBy: d.updatedBy, updatedAt: d.updatedAt });
        /* Another copy of the backend may have made the change: anything that
           moved is announced here too, not only on the copy that saved it. */
        for (const site of Object.keys(SITES)) {
            if ((before.get(site) || null) !== (overrides.get(site)?.base || null)) domainEvents.emit('change', site, domainOf(site));
        }
    } catch { /* keep what we had; the defaults still work */ }
}
if (mongoose.connection.readyState === 1) load();
mongoose.connection.on('open', load);
setInterval(load, 60e3).unref?.();

/* What the admin typed, as an origin: "1tamilmv.foo", "www.1tamilmv.foo/",
   or a full post link all become "https://www.1tamilmv.foo". */
export function normalizeBase(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try {
        const u = new URL(s);
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return null;
        return `${u.protocol}//${u.host}`.toLowerCase();
    } catch { return null; }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Ask a domain whether it is the site: reachable, and what it says it is. */
export async function probe(site, base) {
    const t = Date.now();
    try {
        const res = await fetch(`${base}${SITES[site].test}`, {
            headers: { 'User-Agent': UA, Accept: site === 'i4m' ? 'application/json' : 'text/html' },
            redirect: 'follow', signal: AbortSignal.timeout(12000),
        });
        const body = (await res.text()).slice(0, 200_000);
        const finalOrigin = (() => { try { return new URL(res.url).origin; } catch { return base; } })();
        return {
            ok: res.ok, status: res.status, ms: Date.now() - t,
            looksRight: res.ok && SITES[site].looks.test(body),
            /* A domain that only forwards to another: the admin is told where it
               went, since that one is what should be saved. */
            redirectedTo: finalOrigin !== base ? finalOrigin : null,
        };
    } catch (e) {
        return { ok: false, status: 0, ms: Date.now() - t, looksRight: false, error: e.name === 'TimeoutError' ? 'no answer in 12 s' : e.message };
    }
}

export async function setDomain(site, base, updatedBy = '') {
    await SiteDomain.findOneAndUpdate({ site }, { base, updatedBy }, { upsert: true });
    overrides.set(site, { base, updatedBy, updatedAt: new Date() });
    domainEvents.emit('change', site, base);
}

export async function clearDomain(site) {
    await SiteDomain.deleteOne({ site });
    overrides.delete(site);
    domainEvents.emit('change', site, domainOf(site));
}
