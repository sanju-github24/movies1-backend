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

export async function getLyrics(songId) {
    const data = await saavnGet({
        __call: 'lyrics.getLyrics', ctx: 'web6dot0', api_version: '4', lyrics_id: songId,
    });
    return data?.lyrics || null;
}

/** Decrypt the media URL and tidy the text fields, in place. */
export async function formatSongData(data, includeLyrics = false) {
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

    if (includeLyrics && data.has_lyrics === 'true') {
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
    return formatSongData(raw, includeLyrics);
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
        res.json({ status: true, lyrics: await getLyrics(songId) });
    } catch (e) {
        console.error(`❌ Saavn lyrics lookup failed for ${query}: ${e.message}`);
        res.status(500).json({ detail: `Error fetching lyrics: ${e.message}` });
    }
});

export default router;
