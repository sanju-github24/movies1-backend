// =====================================================================
// 🎵 JIOSAAVN API — a port of github.com/anxkhn/jiosaavn-api
//
// That project is a FastAPI wrapper over jiosaavn.com/api.php: it calls the
// five `__call=` endpoints below, decrypts the DES-encrypted media URL each
// song carries, and hands back the song object with a playable `media_url`.
// It is ported here rather than deployed alongside us so the music pages need
// one service instead of two, and so a song lookup is a function call rather
// than a hop through Python.
//
// Routes mirror the upstream ones one-for-one, mounted under /api/saavn:
//   GET /song/?query=&lyrics=&songdata=   search
//   GET /song/get?song_id=&lyrics=        one song
//   GET /album/?query=&lyrics=            album by id or URL
//   GET /playlist/?query=&lyrics=         playlist by id or URL
//   GET /lyrics/?query=                   lyrics by song id or URL
//   GET /ping                             health of the upstream endpoints
//
// And three of our own, over the same api.php (api_version 4):
//   GET /songs?query=&page=&n=            song search, a page at a time
//   GET /playlists?query=&page=&n=        playlist search ("kannada love songs")
//   GET /radio?song_id= | &stationid=     songs like this one, as a station
//   GET /radio?artist=&language=          an artist's station (their songs in that language)
//   GET /artists?names=a,b,c              each artist's id and photo
//   GET /artist?id=&page=                 an artist's page: songs (50 a page), albums, similar artists
// =====================================================================

import express from 'express';
import crypto from 'crypto';

const router = express.Router();

const BASE_URL = process.env.SAAVN_BASE_URL || 'https://www.jiosaavn.com/api.php';
const REQUEST_TIMEOUT = 10_000;

// api.php serves a trimmed web-player response to browser user-agents —
// autocomplete drops from 5 songs to 3 — so the API calls go out as a plain
// client, the way upstream's `requests` does. Only the HTML page fetches (used
// to turn a share link into an id) send a browser UA, which those pages want.
const API_UA = 'okhttp/4.9.0';
const PAGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function saavnGet(params) {
    const url = `${BASE_URL}?${new URLSearchParams({ _format: 'json', _marker: '0', ...params })}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': API_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!res.ok) throw new Error(`JioSaavn answered ${res.status} for ${params.__call}`);
    return res.json();
}

// ── Media URL decryption ────────────────────────────────────────────────
// Upstream uses single DES-ECB with the key "38346591". OpenSSL 3 dropped
// single DES, but triple DES with all three subkeys equal is the same cipher —
// EDE with K1=K2=K3 collapses to one DES pass — so des-ede3-ecb with the key
// repeated three times decrypts exactly what pyDes produced.
const DES_KEY = Buffer.from('38346591'.repeat(3));

export function decryptUrl(encrypted) {
    try {
        const d = crypto.createDecipheriv('des-ede3-ecb', DES_KEY, null);
        const out = Buffer.concat([d.update(Buffer.from(String(encrypted).trim(), 'base64')), d.final()]).toString('utf8');
        return out.replace('_96.mp4', '_320.mp4');
    } catch (e) {
        throw new Error(`URL decryption failed: ${e.message}`);
    }
}

// JioSaavn double-encodes a handful of entities in its titles and artist lists.
function formatString(s) {
    return String(s ?? '')
        .replace(/&quot;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'");
}

// Artwork ships at 150x150 (50x50 from search); every size is served.
function upscaleImage(url) {
    return String(url || '').replace(/\d+x\d+(?=\.[a-z]+$)/i, '500x500');
}

// ── Core lookups ────────────────────────────────────────────────────────

/** The whole lyrics payload — the words, and who they belong to. */
async function getLyricsPayload(songId) {
    const data = await saavnGet({
        __call: 'lyrics.getLyrics', ctx: 'web6dot0', api_version: '4', lyrics_id: songId,
    });
    if (!data?.lyrics) return null;
    return {
        // Lines are separated by <br>, and the text carries the same escaped
        // entities the rest of the catalogue does.
        lyrics: formatString(data.lyrics),
        copyright: formatString(data.lyrics_copyright || '').replace(/&copy;/g, '©'),
    };
}

export async function getLyrics(songId) {
    return (await getLyricsPayload(songId))?.lyrics || null;
}

/**
 * Decrypt the media URL and tidy the text fields, in place.
 *
 * `trustHasLyrics` decides whether the song's own has_lyrics flag may be used
 * to skip the lyrics request. JioSaavn sets that flag per request — from some
 * IPs it is "false" for every track, including ones lyrics.getLyrics then
 * answers in full — so a single-song lookup ignores it and just asks. An album
 * or playlist keeps trusting it: ignoring it there means one lyrics request per
 * track, fifty of them for a chart.
 */
export async function formatSongData(data, includeLyrics = false, trustHasLyrics = true) {
    if (data.encrypted_media_url) {
        try {
            let mediaUrl = decryptUrl(data.encrypted_media_url);
            // A song without a 320k master only exists at 160k; asking for the
            // higher bitrate would 404.
            if (data['320kbps'] !== 'true') mediaUrl = mediaUrl.replace('_320.mp4', '_160.mp4');
            data.media_url = mediaUrl;
        } catch {
            data.media_url = null;
        }
    } else {
        data.media_url = null;
    }

    for (const field of ['song', 'music', 'singers', 'starring', 'album', 'primary_artists']) {
        data[field] = formatString(data[field]);
    }
    data.image = upscaleImage(data.image);
    data.copyright_text = String(data.copyright_text || '').replace(/&copy;/g, '©');

    if (includeLyrics && (!trustHasLyrics || data.has_lyrics === 'true')) {
        try { data.lyrics = await getLyrics(data.id); } catch { data.lyrics = null; }
    } else {
        data.lyrics = null;
    }
    return data;
}

export async function getSong(songId, includeLyrics = false) {
    const data = await saavnGet({ __call: 'song.getDetails', cc: 'in', pids: songId });
    // song.getDetails keys the response by the pid, but has answered with a
    // {songs:[…]} envelope in the past — accept either.
    const raw = data?.[songId] || (Array.isArray(data?.songs) ? data.songs[0] : null);
    if (!raw) return null;
    // One song, so ask for the lyrics rather than believing the flag.
    return formatSongData(raw, includeLyrics, false);
}

async function autocomplete(query) {
    return saavnGet({ __call: 'autocomplete.get', cc: 'in', includeMetaTags: '1', query });
}

export async function searchSongs(query, { includeLyrics = false, fullData = true } = {}) {
    const data = await autocomplete(query);
    const results = data?.songs?.data || [];
    if (!fullData) {
        // Shape the autocomplete rows like song objects so callers see one
        // schema either way — only media_url is missing until a full lookup.
        return results.map(s => ({
            id: s.id,
            song: formatString(s.title),
            album: formatString(s.album),
            image: upscaleImage(s.image),
            primary_artists: formatString(s.more_info?.primary_artists || ''),
            singers: formatString(s.more_info?.singers || ''),
            language: s.more_info?.language || '',
            perma_url: s.url || '',
            media_url: null,
            lyrics: null,
        }));
    }
    const songs = await Promise.all(results.map(s => getSong(s.id, includeLyrics).catch(() => null)));
    return songs.filter(Boolean);
}

/**
 * Everything one search call returns.
 *
 * Extension over upstream, which exposes only the songs. It is the same single
 * `autocomplete.get` request — upstream simply discards the album and artist
 * lists that come back in the same payload, and the search page has tabs for
 * them, so there is no reason to throw them away and no extra request to make.
 */
export async function searchAll(query) {
    const data = await autocomplete(query);
    const songs = (data?.songs?.data || []).map(s => {
        const title = formatString(s.title);
        const album = formatString(s.album);
        const artist = formatString(s.more_info?.primary_artists || s.more_info?.singers || '');
        return {
            id: s.id,
            title,
            poster: upscaleImage(s.image),
            // A single's album is its own title; showing that twice on one row
            // says nothing, so fall back to the artists.
            label: album && album !== title ? album : (artist || 'Single'),
            artist,
            url: s.url || '',
        };
    });
    const albums = (data?.albums?.data || []).map(a => ({
        id: a.id,
        title: formatString(a.title),
        poster: upscaleImage(a.image),
        label: formatString(a.description || a.music || ''),
        url: a.url || '',
    }));
    const artists = (data?.artists?.data || []).map(a => ({
        id: a.id,
        title: formatString(a.title),
        poster: upscaleImage(a.image),
        label: a.description || 'Artist',
        url: a.url || '',
    }));
    return { songs, albums, artists };
}

export async function getAlbum(albumId, includeLyrics = false) {
    const album = await saavnGet({ __call: 'content.getAlbumDetails', cc: 'in', albumid: albumId });
    if (!album || !album.songs) return null;
    album.image = upscaleImage(album.image);
    album.name = formatString(album.name);
    album.primary_artists = formatString(album.primary_artists);
    for (const song of album.songs) await formatSongData(song, includeLyrics);
    return album;
}

export async function getPlaylist(listId, includeLyrics = false) {
    const playlist = await saavnGet({ __call: 'playlist.getDetails', cc: 'in', listid: listId });
    if (!playlist || !playlist.songs) return null;
    playlist.firstname = formatString(playlist.firstname);
    playlist.listname = formatString(playlist.listname);
    for (const song of playlist.songs) await formatSongData(song, includeLyrics);
    return playlist;
}

// ── Paged search and song radio (api_version 4) ─────────────────────────
// The autocomplete above answers five songs and no pages. These are the calls
// JioSaavn's own web player makes: search a page at a time, and a "station"
// seeded with a song that keeps answering with songs like it — the same
// language, mostly well played — for as long as it is asked.

const v4 = (params) => saavnGet({ api_version: '4', ctx: 'web6dot0', ...params });

/** A version-4 song row → the card the music pages render. */
function v4Card(s) {
    const mi = s?.more_info || {};
    const primary = (mi.artistMap?.primary_artists || []).map(a => a.name).filter(Boolean).join(', ');
    const title = formatString(s?.title);
    const album = formatString(mi.album || '');
    const artist = formatString(primary || mi.music || s?.subtitle || '');
    return {
        id: s?.id,
        title,
        poster: upscaleImage(s?.image),
        label: album && album !== title ? album : (artist || 'Single'),
        artist: artist || 'Unknown Artist',
        language: s?.language || '',
        plays: Number(s?.play_count) || 0,
    };
}

const pageOf = (q) => Math.max(1, parseInt(q.page || q.p || '1', 10) || 1);
const sizeOf = (q, max = 40) => Math.min(max, Math.max(1, parseInt(q.n || '20', 10) || 20));

export async function searchSongsPaged(query, page = 1, n = 20) {
    const data = await v4({ __call: 'search.getResults', q: query, p: String(page), n: String(n) });
    return { total: Number(data?.total) || 0, page, results: (data?.results || []).filter(r => r?.id).map(v4Card) };
}

export async function searchPlaylists(query, page = 1, n = 20) {
    const data = await v4({ __call: 'search.getPlaylistResults', q: query, p: String(page), n: String(n) });
    return {
        total: Number(data?.total) || 0,
        page,
        results: (data?.results || []).filter(r => r?.id).map(r => ({
            id: r.id,
            title: formatString(r.title),
            poster: upscaleImage(r.image),
            songCount: Number(r.more_info?.song_count) || 0,
            label: formatString(r.more_info?.firstname || r.subtitle || ''),
        })),
    };
}

/** Songs like `songId` — or by `artist` — as a station. Pass back the stationid to keep it going. */
export async function songRadio({ songId, stationId, artist, n = 20 }) {
    let station = stationId;
    if (!station && artist) {
        const made = await saavnGet({
            __call: 'webradio.createArtistStation', api_version: '4', ctx: 'android',
            name: artist, query: artist,
        });
        station = made?.stationid;
        if (!station) throw new Error('JioSaavn made no station for this artist');
    }
    if (!station) {
        const made = await saavnGet({
            __call: 'webradio.createEntityStation', api_version: '4', ctx: 'android',
            entity_id: JSON.stringify([songId]), entity_type: 'queue',
        });
        station = made?.stationid;
        if (!station) throw new Error('JioSaavn made no station for this song');
    }
    const data = await saavnGet({
        __call: 'webradio.getSong', api_version: '4', ctx: 'android', stationid: station, k: String(n), next: '1',
    }).catch(() => null);
    const songs = Object.values(data || {}).map(x => x?.song).filter(s => s?.id).map(v4Card);
    if (songs.length) return { stationid: station, songs };

    /* An empty station. JioSaavn makes the station but fills it only for
       listeners in India — from our server it comes back with no songs — so
       the songs come from the artists instead: the seed song's own artists,
       or the artist asked for, their best-played songs in the song's
       language. No stationid, so the next call asks the same way again. */
    const fallback = songId ? await songsLikeSong(songId, n) : artist ? await songsByArtistName(artist, n) : [];
    return { stationid: '', songs: fallback };
}

/* Best-played first, but not the same order every time: the top forty are
   shuffled, so a song's "similar songs" and the radio vary from one listen
   to the next while staying with what people actually play. */
function freshTop(songs, n) {
    const top = [...songs].sort((a, b) => (b.plays || 0) - (a.plays || 0)).slice(0, Math.max(n * 2, 40));
    for (let i = top.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [top[i], top[j]] = [top[j], top[i]]; }
    return top.slice(0, n);
}

function uniqueSongs(songs, skipId) {
    const seen = new Set();
    return songs.filter((s) => {
        const k = s.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
        if (!s.id || s.id === skipId || seen.has(s.id) || seen.has(k)) return false;
        seen.add(s.id); seen.add(k); return true;
    });
}

export async function songsLikeSong(songId, n) {
    const data = await saavnGet({ __call: 'song.getDetails', cc: 'in', pids: songId }).catch(() => null);
    const raw = data?.[songId] || (Array.isArray(data?.songs) ? data.songs[0] : null);
    if (!raw) return [];
    const lang = raw.language || '';
    const ids = String(raw.primary_artists_id || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 3);
    const pages = await Promise.all(ids.map(id => getArtistPage(id, 0).catch(() => null)));
    let songs = uniqueSongs(pages.flatMap(p => p?.songs || []), songId);
    const sameLang = songs.filter(s => !lang || s.language === lang);
    if (sameLang.length >= 6) songs = sameLang;
    // A short list: widen with a search for the artists in the language.
    if (songs.length < n && raw.primary_artists) {
        const more = await searchSongsPaged(`${formatString(raw.primary_artists).split(',')[0]} ${lang}`, 1, 40).catch(() => ({ results: [] }));
        songs = uniqueSongs([...songs, ...more.results.filter(s => !lang || s.language === lang)], songId);
    }
    /* Still short — a little-known singer has a handful of songs — so it
       keeps widening until there is a full list, nearest first: the same
       album or film, its music director, then the language's most played.
       Similar songs should never come back empty. */
    const widen = async (q) => {
        if (songs.length >= n || !q) return;
        const more = await searchSongsPaged(q, 1, 40).catch(() => ({ results: [] }));
        songs = uniqueSongs([...songs, ...more.results.filter(s => !lang || s.language === lang)], songId);
    };
    const album = formatString(raw.album || '').replace(/\s*\((?:from|original).*$/i, '').trim();
    await widen(album);
    await widen(formatString(raw.music || '').split(',')[0].trim() && `${formatString(raw.music).split(',')[0].trim()} ${lang}`);
    await widen(lang && `${lang} hits`);
    await widen(lang && `latest ${lang} songs`);
    return freshTop(songs, n);
}

export async function songsByArtistName(name, n) {
    const a = await findArtist(name).catch(() => null);
    if (!a?.id) return [];
    const page = await getArtistPage(a.id, 0).catch(() => null);
    return freshTop(uniqueSongs(page?.songs || []), n);
}

/* Each artist's id and photo, by name. A name's answer is kept for a day —
   the home page asks for the same dozen singers on every visit, and their
   photos do not change from one hour to the next. */
const artistCache = new Map();   // lower-cased name → { at, value }
const ARTIST_TTL = 24 * 3600 * 1000;

async function findArtist(name) {
    const key = name.toLowerCase();
    const hit = artistCache.get(key);
    if (hit && Date.now() - hit.at < ARTIST_TTL) return hit.value;
    const data = await v4({ __call: 'search.getArtistResults', q: name, p: '1', n: '3' });
    const results = data?.results || [];
    // The closest name, not just the first answer.
    const r = results.find(x => formatString(x.name).toLowerCase() === key) || results[0];
    const value = r ? { id: r.id, name: formatString(r.name), image: upscaleImage(r.image), query: name } : null;
    artistCache.set(key, { at: Date.now(), value });
    return value;
}

/** One artist's page: their songs fifty at a time, best first, plus albums and similar artists. */
export async function getArtistPage(artistId, page = 0) {
    const d = await v4({
        __call: 'artist.getArtistPageDetails', artistId, n_song: '50', n_album: '20',
        page: String(page), category: '', sort_order: '',
    });
    if (!d?.artistId && !d?.name) return null;
    const songs = (d.topSongs || []).filter(x => x?.id).map(v4Card);
    return {
        id: d.artistId,
        name: formatString(d.name),
        image: upscaleImage(d.image),
        followers: Number(d.follower_count) || 0,
        language: d.dominantLanguage || '',
        page,
        songs,
        hasMore: songs.length >= 50,
        // Only on the first page; later pages are the songs alone.
        albums: page ? [] : (d.topAlbums || []).filter(a => a?.id).map(a => ({
            id: a.id, title: formatString(a.title), poster: upscaleImage(a.image), year: a.year || '',
            label: formatString(a.subtitle || ''),
        })),
        similar: page ? [] : (d.similarArtists || []).filter(a => a?.id).map(a => ({
            id: a.id, name: formatString(a.name), image: upscaleImage(a.image),
        })),
    };
}

export async function findArtists(names) {
    const out = await Promise.all(names.map(n => findArtist(n).catch(() => null)));
    return out.filter(Boolean);
}

// ── Entity ids out of share URLs ────────────────────────────────────────
// A jiosaavn.com link carries a short token, not the numeric id the API wants;
// the id is in the page's bootstrapped state, so read it out of the HTML.
async function fetchPage(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': PAGE_UA },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    return res.text();
}

function between(text, start, end) {
    const i = text.indexOf(start);
    if (i === -1) return null;
    const rest = text.slice(i + start.length);
    const j = rest.indexOf(end);
    return j === -1 ? null : rest.slice(0, j);
}

export async function getSongId(url) {
    const html = await fetchPage(url);
    const pid = between(html, '"pid":"', '","');
    if (pid) return pid;
    // Older pages carry no "pid"; the id then sits inside the song block.
    const block = between(html, '"song":{"type":"', '","image":');
    return block ? block.split('"id":"').pop() : null;
}

export async function getAlbumId(url) {
    const html = await fetchPage(url);
    return between(html, '"album_id":"', '"') || between(html, '"page_id","', '","');
}

export async function getPlaylistId(url) {
    const html = await fetchPage(url);
    return between(html, '"type":"playlist","id":"', '"') || between(html, '"page_id","', '","');
}

/** A query is either a numeric/opaque id already, or a jiosaavn.com link. */
const isSaavnUrl = q => /^https?:\/\//i.test(q) && /saavn/i.test(q);

const asBool = (v, fallback) => (v === undefined ? fallback : !/^(0|false|no)$/i.test(String(v)));

// ── Routes ──────────────────────────────────────────────────────────────

router.get('/ping', async (req, res) => {
    const calls = ['song.getDetails', 'content.getAlbumDetails', 'playlist.getDetails', 'lyrics.getLyrics', 'autocomplete.get'];
    const details = await Promise.all(calls.map(async (call) => {
        const url = `${BASE_URL}?__call=${call}`;
        try {
            const r = await fetch(url, { headers: { 'User-Agent': API_UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
            return { url, status: r.ok ? 'ok' : `failed with code ${r.status}` };
        } catch (e) {
            return { url, status: `failed with error: ${e.message}` };
        }
    }));
    res.json({
        msg: 'Pong!',
        status: details.every(d => d.status === 'ok') ? 'healthy' : 'unhealthy',
        details,
    });
});

// Search. `songdata=false` returns the autocomplete rows without the extra
// per-song lookups — much faster, and enough to render a result list.
router.get('/song/', async (req, res) => {
    const query = (req.query.query || '').trim();
    if (!query) return res.status(400).json({ detail: 'Query is required to search songs!' });
    try {
        res.json(await searchSongs(query, {
            includeLyrics: asBool(req.query.lyrics, false),
            fullData: asBool(req.query.songdata, true),
        }));
    } catch (e) {
        console.error(`❌ Saavn search failed for "${query}": ${e.message}`);
        res.status(500).json({ detail: `Error searching songs: ${e.message}` });
    }
});

// Extension over upstream — see searchAll(). One upstream call, three lists.
router.get('/search', async (req, res) => {
    const query = (req.query.query || req.query.q || '').trim();
    if (!query) return res.status(400).json({ detail: 'Query is required to search!' });
    try {
        res.json(await searchAll(query));
    } catch (e) {
        console.error(`❌ Saavn search failed for "${query}": ${e.message}`);
        res.status(500).json({ detail: `Error searching: ${e.message}` });
    }
});

router.get('/songs', async (req, res) => {
    const query = (req.query.query || req.query.q || '').trim();
    if (!query) return res.status(400).json({ detail: 'Query is required to search!' });
    try {
        res.json(await searchSongsPaged(query, pageOf(req.query), sizeOf(req.query)));
    } catch (e) {
        console.error(`❌ Saavn paged search failed for "${query}": ${e.message}`);
        res.status(500).json({ detail: `Error searching songs: ${e.message}` });
    }
});

router.get('/playlists', async (req, res) => {
    const query = (req.query.query || req.query.q || '').trim();
    if (!query) return res.status(400).json({ detail: 'Query is required to search playlists!' });
    try {
        res.json(await searchPlaylists(query, pageOf(req.query), sizeOf(req.query)));
    } catch (e) {
        console.error(`❌ Saavn playlist search failed for "${query}": ${e.message}`);
        res.status(500).json({ detail: `Error searching playlists: ${e.message}` });
    }
});

router.get('/artists', async (req, res) => {
    const names = String(req.query.names || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 24);
    if (!names.length) return res.status(400).json({ detail: 'names is required!' });
    try {
        res.json({ artists: await findArtists(names) });
    } catch (e) {
        console.error(`❌ Saavn artist lookup failed: ${e.message}`);
        res.status(500).json({ detail: `Error finding artists: ${e.message}` });
    }
});

/* An artist's songs in one language. Their station ignores language — a
   Kannada singer's station is mostly their Hindi songs — so it is filtered,
   and topped up from a search for the artist in that language. No stationid
   comes back: carrying on from the station would drift out of the language,
   so the player follows on with song radio, which stays in it. */
async function artistInLanguage(artist, language, n = 20) {
    const lang = language.toLowerCase();
    const byArtist = (s) => s.artist.toLowerCase().includes(artist.toLowerCase());
    const seen = new Set();
    const keep = [];
    // One of each song: the same track is often uploaded several times, under different ids.
    const titleKey = (s) => s.title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const add = (list) => {
        for (const s of list) {
            if (!s.id || s.language !== lang || !byArtist(s)) continue;
            const k = titleKey(s);
            if (seen.has(s.id) || seen.has(k)) continue;
            seen.add(s.id); seen.add(k); keep.push(s);
        }
    };
    const [station, found] = await Promise.all([
        songRadio({ artist, n: 30 }).catch(() => ({ songs: [] })),
        searchSongsPaged(`${artist} ${language}`, 1, 40).catch(() => ({ results: [] })),
    ]);
    add(station.songs);
    // Searches come back best match first; most-played first reads better as a station.
    add([...found.results].sort((a, b) => (b.plays || 0) - (a.plays || 0)));
    return { stationid: '', songs: keep.slice(0, n) };
}

router.get('/artist', async (req, res) => {
    const id = (req.query.id || '').trim();
    if (!id) return res.status(400).json({ detail: 'Artist id is required!' });
    try {
        const page = Math.max(0, parseInt(req.query.page || '0', 10) || 0);
        const artist = await getArtistPage(id, page);
        if (!artist) return res.status(404).json({ detail: 'Invalid Artist ID!' });
        res.json(artist);
    } catch (e) {
        console.error(`❌ Saavn artist page failed for ${id}: ${e.message}`);
        res.status(500).json({ detail: `Error fetching artist: ${e.message}` });
    }
});

router.get('/radio', async (req, res) => {
    const songId = (req.query.song_id || '').trim();
    const stationId = (req.query.stationid || '').trim();
    const artist = (req.query.artist || '').trim();
    const language = (req.query.language || '').trim();
    if (!songId && !stationId && !artist) return res.status(400).json({ detail: 'song_id, artist or stationid is required!' });
    try {
        if (artist && language) {
            const inLang = await artistInLanguage(artist, language, sizeOf(req.query, 30));
            // Too few in that language: the whole station is better than a short list.
            if (inLang.songs.length >= 6) return res.json(inLang);
        }
        res.json(await songRadio({ songId, stationId, artist, n: sizeOf(req.query, 30) }));
    } catch (e) {
        console.error(`❌ Saavn radio failed for ${songId || stationId}: ${e.message}`);
        res.status(500).json({ detail: `Error building radio: ${e.message}` });
    }
});

router.get('/song/get', async (req, res) => {
    const songId = (req.query.song_id || '').trim();
    if (!songId) return res.status(400).json({ detail: 'Song ID is required!' });
    try {
        const song = await getSong(songId, asBool(req.query.lyrics, false));
        if (!song) return res.status(404).json({ detail: 'Invalid Song ID!' });
        res.json(song);
    } catch (e) {
        console.error(`❌ Saavn song lookup failed for ${songId}: ${e.message}`);
        res.status(500).json({ detail: `Error fetching song: ${e.message}` });
    }
});

router.get('/album/', async (req, res) => {
    const query = (req.query.query || '').trim();
    if (!query) return res.status(400).json({ detail: 'Query containing album link or id is required!' });
    try {
        const albumId = isSaavnUrl(query) ? await getAlbumId(query) : query;
        const album = await getAlbum(albumId, asBool(req.query.lyrics, false));
        if (!album) return res.status(404).json({ detail: 'Invalid Album ID!' });
        res.json(album);
    } catch (e) {
        console.error(`❌ Saavn album lookup failed for ${query}: ${e.message}`);
        res.status(500).json({ detail: `Error fetching album: ${e.message}` });
    }
});

router.get('/playlist/', async (req, res) => {
    const query = (req.query.query || '').trim();
    if (!query) return res.status(400).json({ detail: 'Query containing playlist link or id is required!' });
    try {
        const listId = isSaavnUrl(query) ? await getPlaylistId(query) : query;
        const playlist = await getPlaylist(listId, asBool(req.query.lyrics, false));
        if (!playlist) return res.status(404).json({ detail: 'Invalid Playlist ID!' });
        res.json(playlist);
    } catch (e) {
        console.error(`❌ Saavn playlist lookup failed for ${query}: ${e.message}`);
        res.status(500).json({ detail: `Error fetching playlist: ${e.message}` });
    }
});

router.get('/lyrics/', async (req, res) => {
    const query = (req.query.query || '').trim();
    if (!query) return res.status(400).json({ detail: 'Query containing song link or id is required to fetch lyrics!' });
    try {
        const songId = isSaavnUrl(query) ? await getSongId(query) : query;
        const payload = await getLyricsPayload(songId);
        // `copyright` is additive to upstream's { status, lyrics } — the page
        // shows the words, so it should show whose they are.
        res.json({ status: Boolean(payload), lyrics: payload?.lyrics || null, copyright: payload?.copyright || '' });
    } catch (e) {
        console.error(`❌ Saavn lyrics lookup failed for ${query}: ${e.message}`);
        res.status(500).json({ detail: `Error fetching lyrics: ${e.message}` });
    }
});

export default router;
