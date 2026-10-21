/* The names a title goes by, for looking it up on a site that lists it
   under one of them. "Fakes (Farzi)" — Prime's newer English name, with the
   one it was released under — and "A / B" are each two titles' worth:
   ["Fakes", "Farzi"]. A year in brackets is not a name. Anything else is
   itself: ["Jailer"]. */
export function titleNames(q) {
    const s = String(q || '').trim();
    const alt = s.match(/^(.+?)\s*\(([^()]*[a-z][^()]*)\)\s*$/i);
    if (alt && !/^(?:19|20)\d{2}$/.test(alt[2].trim())) return [alt[1].trim(), alt[2].trim()];
    const slash = s.split(/\s+\/\s+/);
    if (slash.length === 2) return slash.map((x) => x.trim());
    return s ? [s] : [];
}
