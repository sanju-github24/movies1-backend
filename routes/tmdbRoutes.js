import { Router } from 'express';
import axios from 'axios';
import * as fs from 'fs/promises'; 
import { URL } from 'url';

const router = Router();

const TMDB_API_KEY = "452111addfd12727f394865d09a805b4"; 
const BASE_URL = "https://api.themoviedb.org/3/";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500"; 
const BACKDROP_BASE_URL = "https://image.tmdb.org/t/p/w1280"; 
const LOGO_BASE_URL = "https://image.tmdb.org/t/p/w300";
const YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch?v=";
const DATA_FILE_PATH = './data/data/all_south_indian_movies.json'; 
const CASTHQ_API_BASE = 'https://casthq.to/api'; 
const DEFAULT_CASTHQ_KEY = '154lzcrtrw3lelu26zf';

// ── Axios with retry ──────────────────────────────────────────────────────────
const axiosWithRetry = async (config, retries = 3, delay = 500) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios(config);
    } catch (err) {
      const isRetryable =
        err.code === "ECONNRESET" ||
        err.code === "ECONNABORTED" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ENOTFOUND" ||
        err.code === "EAI_AGAIN" ||
        (err.response?.status >= 500 && err.response?.status < 600) ||
        err.response?.status === 429;

      if (!isRetryable || i === retries - 1) throw err;

      const wait = delay * Math.pow(2, i); // 500ms, 1000ms, 2000ms
      console.warn(`[TMDB Retry ${i + 1}/${retries}] ${err.code || err.response?.status} — retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
};

// Genre ID → Name maps (so list endpoints return strings not raw IDs)
const MOVIE_GENRE_MAP = {
  28:"Action",12:"Adventure",16:"Animation",35:"Comedy",80:"Crime",
  99:"Documentary",18:"Drama",10751:"Family",14:"Fantasy",36:"History",
  27:"Horror",10402:"Music",9648:"Mystery",10749:"Romance",
  878:"Science Fiction",10770:"TV Movie",53:"Thriller",10752:"War",37:"Western"
};
const TV_GENRE_MAP = {
  10759:"Action & Adventure",16:"Animation",35:"Comedy",80:"Crime",
  99:"Documentary",18:"Drama",10751:"Family",10762:"Kids",
  9648:"Mystery",10763:"News",10764:"Reality",10765:"Sci-Fi & Fantasy",
  10766:"Soap",10767:"Talk",10768:"War & Politics",37:"Western"
};

const LANG_DISPLAY = {
  ta:"Tamil",te:"Telugu",ml:"Malayalam",kn:"Kannada",hi:"Hindi",en:"English"
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const _search_title_id = async (title) => {
  try {
    const r = await axiosWithRetry({ method:"get", url:`${BASE_URL}search/multi`, params:{ api_key:TMDB_API_KEY, query:title } });
    for (const result of r.data?.results || []) {
      if (result.media_type==='movie'||result.media_type==='tv')
        return { id:result.id, name:result.title||result.name, media_type:result.media_type };
    }
  } catch(e){ console.error("TMDB Title Search:",e.message); }
  return null;
};

const _search_imdb_id = async (imdb_id) => {
  try {
    const r = await axiosWithRetry({ method:"get", url:`${BASE_URL}find/${imdb_id}`, params:{ api_key:TMDB_API_KEY, external_source:'imdb_id' } });
    const results = r.data.movie_results.length>0 ? r.data.movie_results : r.data.tv_results;
    if(results.length>0){
      const media_type = r.data.movie_results.length>0 ? 'movie' : 'tv';
      return { id:results[0].id, name:results[0].title||results[0].name, media_type };
    }
  } catch(e){ console.error("TMDB IMDb Search:",e.message); }
  return null;
};

const _get_full_details = async (tmdb_id, media_type) => {
  try {
    const r = await axiosWithRetry({ method:"get", url:`${BASE_URL}${media_type}/${tmdb_id}`,
      params:{ api_key:TMDB_API_KEY, append_to_response:'credits,external_ids,videos,release_dates,content_ratings,images', include_image_language:'en,null' }
    });
    return r.data;
  } catch(e){ console.error("TMDB Details:",e.message); }
  return null;
};

const _get_certification = (details, media_type) => {
  const targets = ['IN','US'];
  if(media_type==='movie' && details.release_dates){
    for(const cc of targets){
      const cd = details.release_dates.results?.find(r=>r.iso_3166_1===cc);
      if(cd){ const rwc = cd.release_dates.find(r=>r.certification); if(rwc) return rwc.certification; }
    }
  } else if(media_type==='tv' && details.content_ratings){
    for(const cc of targets){
      const cd = details.content_ratings.results?.find(r=>r.iso_3166_1===cc);
      if(cd?.rating) return cd.rating;
    }
  }
  return null;
};

async function _get_season_details(tmdb_id, season_number){
  try {
    const r = await axiosWithRetry({ method:"get", url:`${BASE_URL}tv/${tmdb_id}/season/${season_number}`, params:{ api_key:TMDB_API_KEY } });
    return r.data;
  } catch(e){ return null; }
}

// Fetch logo + trailer for one item
const _get_logo_and_trailer = async (tmdb_id, media_type) => {
  try {
    const [imgR, vidR] = await Promise.all([
      axiosWithRetry({ method:"get", url:`${BASE_URL}${media_type}/${tmdb_id}/images`, params:{ api_key:TMDB_API_KEY, include_image_language:'en,null' } }),
      axiosWithRetry({ method:"get", url:`${BASE_URL}${media_type}/${tmdb_id}/videos`, params:{ api_key:TMDB_API_KEY } })
    ]);
    // Set default timeout for all axios calls (10 seconds)
   axios.defaults.timeout = 10000;
    const logos = imgR.data?.logos || [];
    const logo  = logos.find(l=>l.iso_639_1==='en') || logos[0];
    const title_logo = logo ? `${LOGO_BASE_URL}${logo.file_path}` : null;
    const videos = vidR.data?.results || [];
    const trailer = videos.find(v=>v.site==='YouTube'&&v.type==='Trailer') || videos.find(v=>v.site==='YouTube'&&v.type==='Teaser');
    return { title_logo, trailer_key: trailer?.key || null };
  } catch(_){ return { title_logo:null, trailer_key:null }; }
};

// Turn raw TMDB list item into unified shape with genre NAMES (not IDs)
const _normalise_list_item = (item, media_type, enrichment={}) => {
  const title = item.title||item.name||'';
  const slug  = title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  const genreMap = media_type==='tv' ? TV_GENRE_MAP : MOVIE_GENRE_MAP;
  const genres   = (item.genre_ids||[]).map(id=>genreMap[id]).filter(Boolean);
  const langCode = item.original_language||'en';
  return {
    id: item.id, tmdb_id: item.id, title, slug,
    content_type:     media_type,
    description:      item.overview||'',
    year:             (item.release_date||item.first_air_date||'').substring(0,4)||null,
    release_date:     item.release_date||item.first_air_date||null,
    poster_path:      item.poster_path||null,
    backdrop_path:    item.backdrop_path||null,
    poster_url:       item.poster_path  ? `${IMAGE_BASE_URL}${item.poster_path}`    : null,
    cover_poster_url: item.backdrop_path? `${BACKDROP_BASE_URL}${item.backdrop_path}`: null,
    imdb_rating:      item.vote_average ? Number(item.vote_average).toFixed(1)       : '0.0',
    vote_count:       item.vote_count||0,
    original_language: langCode,
    language_display:  LANG_DISPLAY[langCode]||langCode.toUpperCase(),
    genres,                          // ← actual genre name strings
    trailer_key: enrichment.trailer_key||null,
    title_logo:  enrichment.title_logo||null,
  };
};

// Enrich a batch (logos + trailers) with controlled concurrency
const _enrich_batch = async (items, concurrency=6) => {
  const results = [...items];
  for(let i=0; i<results.length; i+=concurrency){
    const chunk = results.slice(i, i+concurrency);
    const enrichments = await Promise.all(
      chunk.map(item=>_get_logo_and_trailer(item.tmdb_id, item.content_type))
    );
    enrichments.forEach((e,j)=>{ results[i+j]={...results[i+j],...e}; });
  }
  return results;
};

// ── /tmdb-details ─────────────────────────────────────────────────────────────

router.get('/tmdb-details', async (req, res) => {
  const { title, imdb_id, imdbId, tmdbId, contentType } = req.query;
  const final_imdb_id = imdb_id || imdbId;

  let top_result = null;

  if (tmdbId) {
    // Direct TMDB ID — skip search entirely, fastest path
    const media_type = contentType === "tv" ? "tv" : contentType === "movie" ? "movie" : "movie";
    top_result = { id: Number(tmdbId), name: "", media_type };
  } else if (final_imdb_id) {
    top_result = await _search_imdb_id(final_imdb_id);
  } else if (title) {
    top_result = await _search_title_id(title);
  } else {
    return res.status(400).json({ success: false, message: "Must provide tmdbId, imdbId, or title." });
  }

  if (!top_result) return res.status(404).json({ success: false, error_type: "TitleNotFound", message: "No match found." });

  let { id: tmdb_id, media_type } = top_result;

  // ── Fetch full details ──
  let details = await _get_full_details(tmdb_id, media_type);

  // If we guessed "movie" from tmdbId but it's actually a TV show, retry as tv
  if (details && tmdbId && !contentType && (details.first_air_date || details.number_of_seasons != null)) {
    media_type = "tv";
    details = await _get_full_details(tmdb_id, "tv");
  }
  // If movie fetch returned nothing, try tv
  if (!details && tmdbId && media_type === "movie") {
    media_type = "tv";
    details = await _get_full_details(tmdb_id, "tv");
  }

  if (!details) return res.status(500).json({ success: false, error_type: "DetailsFetchFailed", message: "Failed to fetch details." });

  // ── Episodes for TV ──
  let episodes_list = [];
  if (media_type === 'tv' && details.seasons) {
    const validSeasons = details.seasons.filter(s => s.season_number > 0); // skip season 0 (specials)
    const seasonsData = await Promise.all(
      validSeasons.map(s => _get_season_details(tmdb_id, s.season_number))
    );
    seasonsData.forEach(season => {
      if (season?.episodes) season.episodes.forEach(ep => {
        episodes_list.push({
          season:      ep.season_number,
          episode:     ep.episode_number,
          title:       ep.name || `Episode ${ep.episode_number}`,
          overview:    ep.overview || "",
          air_date:    ep.air_date || null,
          still_path:  ep.still_path ? `${IMAGE_BASE_URL}${ep.still_path}` : null,
        });
      });
    });
  }

  const runtime = media_type === 'movie' ? (details.runtime || 0) : (details.episode_run_time?.[0] || 0);

  // ── Theatrical release date ──
  let real_theatrical_date = null;
  if (media_type === 'movie' && details.release_dates) {
    const preferred = ['IN', 'US', 'GB'];
    const sorted = (details.release_dates.results || []).sort((a, b) => {
      return (preferred.indexOf(a.iso_3166_1) === -1 ? 99 : preferred.indexOf(a.iso_3166_1))
           - (preferred.indexOf(b.iso_3166_1) === -1 ? 99 : preferred.indexOf(b.iso_3166_1));
    });
    for (const region of sorted) {
      const t = region.release_dates.find(rd => rd.type === 3 || rd.type === 2);
      if (t) { real_theatrical_date = t.release_date; break; }
    }
    real_theatrical_date = real_theatrical_date || details.release_date;
  } else {
    real_theatrical_date = details.release_date || details.first_air_date;
  }

  // ── Trailer ──
  const videos = details.videos?.results || [];
  const trailer = videos.find(v => v.site === 'YouTube' && v.type === 'Trailer')
               || videos.find(v => v.site === 'YouTube' && v.type === 'Teaser');
  const trailer_key = trailer?.key || null;
  const trailer_url = trailer_key ? `${YOUTUBE_WATCH_BASE}${trailer_key}` : null;

  // ── Cast ──
  const cast_list = (details.credits?.cast || []).slice(0, 10).map(m => ({
    name: m.name, character: m.character, profile_path: m.profile_path || null,
    profile_url: m.profile_path ? `${IMAGE_BASE_URL}${m.profile_path}` : null,
  }));

  // ── Logo ──
  const logos = details.images?.logos || [];
  const logo  = logos.find(l => l.iso_639_1 === 'en') || logos[0];
  const title_logo = logo ? `${LOGO_BASE_URL}${logo.file_path}` : null;

  const slug = (details.title || details.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  res.json({
    success: true,
    data: {
      tmdb_id:          details.id,
      title:            details.title || details.name,
      slug,
      content_type:     media_type,
      description:      details.overview || 'Description not available.',
      year:             real_theatrical_date ? real_theatrical_date.substring(0, 4) : null,
      release_date:     real_theatrical_date,
      runtime,
      number_of_seasons: details.number_of_seasons || null,
      poster_url:       details.poster_path  ? `${IMAGE_BASE_URL}${details.poster_path}`    : null,
      cover_poster_url: details.backdrop_path? `${BACKDROP_BASE_URL}${details.backdrop_path}`: null,
      title_logo,
      original_language: details.original_language,
      imdb_rating:      details.vote_average ? details.vote_average.toFixed(1) : "0.0",
      vote_count:       details.vote_count || 0,
      cast:             cast_list,
      genres:           (details.genres || []).map(g => g.name),
      imdb_id:          details.external_ids?.imdb_id || details.imdb_id || null,
      trailer_url,
      trailer_key,
      certification:    _get_certification(details, media_type),
      episodes:         episodes_list,
    }
  });
});

// ── /tmdb-episodes ────────────────────────────────────────────────────────────
// GET /api/tmdb-episodes?tmdbId=12345
// GET /api/tmdb-episodes?imdbId=tt1234567
// Fetches all episodes for a TV series directly from TMDB season API

router.get('/tmdb-episodes', async (req, res) => {
  const { tmdbId, imdbId } = req.query;
  if (!tmdbId && !imdbId) return res.status(400).json({ success: false, message: "Must provide tmdbId or imdbId." });

  try {
    let final_tmdb_id = tmdbId ? Number(tmdbId) : null;

    // If only imdbId provided, resolve to tmdb_id first
    if (!final_tmdb_id && imdbId) {
      const found = await _search_imdb_id(imdbId);
      if (!found || found.media_type !== 'tv') {
        return res.status(404).json({ success: false, message: "TV series not found for this IMDb ID." });
      }
      final_tmdb_id = found.id;
    }

    // Fetch show-level details to get season count
    const showDetails = await axiosWithRetry({ method:"get", url:`${BASE_URL}tv/${final_tmdb_id}`, params:{ api_key: TMDB_API_KEY } });
    const seasons = (showDetails.data?.seasons || []).filter(s => s.season_number > 0);

    if (seasons.length === 0) {
      return res.json({ success: true, episodes: [], total_seasons: 0 });
    }

    // Fetch all seasons in parallel
    const seasonsData = await Promise.all(
      seasons.map(s => _get_season_details(final_tmdb_id, s.season_number))
    );

    const episodes = [];
    seasonsData.forEach(season => {
      if (!season?.episodes) return;
      season.episodes.forEach(ep => {
        episodes.push({
          season:                ep.season_number,
          season_number:         ep.season_number,
          episode:               ep.episode_number,
          episodeNumberInSeason: ep.episode_number,
          title:                 ep.name || `Episode ${ep.episode_number}`,
          name:                  ep.name || `Episode ${ep.episode_number}`,
          overview:              ep.overview || "",
          description:           ep.overview || "",
          air_date:              ep.air_date || null,
          still_path:            ep.still_path || null,
          thumbnail:             ep.still_path ? `${IMAGE_BASE_URL}${ep.still_path}` : null,
          runtime:               ep.runtime || null,
        });
      });
    });

    res.json({
      success:       true,
      tmdb_id:       final_tmdb_id,
      total_seasons: seasons.length,
      total_episodes: episodes.length,
      episodes,
    });
  } catch (e) {
    console.error('TMDB Episodes:', e.message);
    res.status(500).json({ success: false, message: "Failed to fetch episodes.", details: e.message });
  }
});

// ── /tmdb-trending ────────────────────────────────────────────────────────────
// GET /api/tmdb-trending?time_window=week&page=1

router.get('/tmdb-trending', async (req, res) => {
  const time_window = req.query.time_window||'week';
  const page = req.query.page||1;
  try {
    const r = await axios.get(`${BASE_URL}trending/all/${time_window}`, { params:{ api_key:TMDB_API_KEY, page } });
    const items    = (r.data.results||[]).map(item=>_normalise_list_item(item, item.media_type||'movie'));
    const enriched = await _enrich_batch(items, 6);
    res.json({ success:true, page:r.data.page, total_pages:r.data.total_pages, results:enriched });
  } catch(e){
    console.error('TMDB Trending:',e.message);
    res.status(500).json({ success:false, message:'Failed to fetch trending.', details:e.message });
  }
});

// ── /tmdb-popular ─────────────────────────────────────────────────────────────
// GET /api/tmdb-popular?page=1&region=IN

router.get('/tmdb-popular', async (req, res) => {
  const page=req.query.page||1, region=req.query.region||'';
  try {
    const r = await axios.get(`${BASE_URL}movie/popular`, { params:{ api_key:TMDB_API_KEY, page, region:region||undefined } });
    const items    = (r.data.results||[]).map(item=>_normalise_list_item(item,'movie'));
    const enriched = await _enrich_batch(items, 6);
    res.json({ success:true, page:r.data.page, total_pages:r.data.total_pages, results:enriched });
  } catch(e){
    console.error('TMDB Popular Movies:',e.message);
    res.status(500).json({ success:false, message:'Failed to fetch popular movies.', details:e.message });
  }
});

// ── /tmdb-popular-tv ──────────────────────────────────────────────────────────
// GET /api/tmdb-popular-tv?page=1

router.get('/tmdb-popular-tv', async (req, res) => {
  const page=req.query.page||1;
  try {
    const r = await axios.get(`${BASE_URL}tv/popular`, { params:{ api_key:TMDB_API_KEY, page } });
    const items    = (r.data.results||[]).map(item=>_normalise_list_item(item,'tv'));
    const enriched = await _enrich_batch(items, 6);
    res.json({ success:true, page:r.data.page, total_pages:r.data.total_pages, results:enriched });
  } catch(e){
    console.error('TMDB Popular TV:',e.message);
    res.status(500).json({ success:false, message:'Failed to fetch popular TV.', details:e.message });
  }
});

// ── /tmdb-regional ────────────────────────────────────────────────────────────
// GET /api/tmdb-regional?lang=ta&type=movie&page=1
//   lang: ta | te | ml | kn | hi | en   (ISO 639-1)
//   type: movie | tv

router.get('/tmdb-regional', async (req, res) => {
  const lang    = req.query.lang    || 'ta';
  const type    = req.query.type    || 'movie';
  const page    = req.query.page    || 1;
  const sort_by = req.query.sort_by || 'popularity.desc';
  // min_votes: lower it (e.g. 10) to surface far more titles for smaller
  // languages like Kannada/Malayalam. enrich=0 skips the logo/trailer
  // enrichment so bulk pages come back with a single TMDB call.
  const min_votes = Math.max(parseInt(req.query.min_votes, 10) || 50, 0);
  const enrich    = req.query.enrich !== '0';
  try {
    const r = await axios.get(`${BASE_URL}discover/${type}`, {
      params:{ api_key:TMDB_API_KEY, with_original_language:lang, sort_by, page, include_adult:false, 'vote_count.gte':min_votes }
    });
    const items    = (r.data.results||[]).map(item=>_normalise_list_item(item, type));
    const enriched = enrich ? await _enrich_batch(items, 6) : items;
    res.json({ success:true, language:lang, language_name:LANG_DISPLAY[lang]||lang, content_type:type, page:r.data.page, total_pages:r.data.total_pages, total_results:r.data.total_results, results:enriched });
  } catch(e){
    console.error(`TMDB Regional [${lang}/${type}]:`,e.message);
    res.status(500).json({ success:false, message:`Failed to fetch ${lang} ${type}.`, details:e.message });
  }
});

// ── /tmdb-search ──────────────────────────────────────────────────────────────
// GET /api/tmdb-search?query=...&type=movie|tv|multi&lang=ta&page=1
//   Multi-result TMDB search. type narrows to movies or TV shows; lang filters
//   results to one original language (ISO 639-1). Results are enriched with
//   logos + trailer keys.

router.get('/tmdb-search', async (req, res) => {
  const query = (req.query.query || '').trim();
  if (!query) return res.status(400).json({ success:false, message:'Must provide query.' });
  const type = ['movie','tv'].includes(req.query.type) ? req.query.type : 'multi';
  const lang = (req.query.lang || '').trim();
  const page = req.query.page || 1;
  try {
    const r = await axiosWithRetry({ method:"get", url:`${BASE_URL}search/${type}`,
      params:{ api_key:TMDB_API_KEY, query, page, include_adult:false }
    });
    let raw = r.data.results || [];
    if (type === 'multi') raw = raw.filter(it => it.media_type === 'movie' || it.media_type === 'tv');
    if (lang) raw = raw.filter(it => it.original_language === lang);
    const items = raw.slice(0, 18).map(it => _normalise_list_item(it, type === 'multi' ? it.media_type : type));
    const enriched = await _enrich_batch(items, 6);
    res.json({ success:true, query, content_type:type, language:lang || null, page:r.data.page, total_pages:r.data.total_pages, results:enriched });
  } catch(e){
    console.error(`TMDB Search [${query}]:`, e.message);
    res.status(500).json({ success:false, message:'Failed to search TMDB.', details:e.message });
  }
});

// ── /tmdb-trending-language ───────────────────────────────────────────────────
// GET /api/tmdb-trending-language?lang=ta&type=movie&limit=5
//   Top trending titles for one original language: recent releases (last 12
//   months) sorted by TMDB popularity, topped up from all-time popular if the
//   recent window is too thin. Results are enriched with logo + trailer.

router.get('/tmdb-trending-language', async (req, res) => {
  const lang  = req.query.lang || 'ta';
  const type  = req.query.type === 'tv' ? 'tv' : 'movie';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  const dateField = type === 'tv' ? 'first_air_date' : 'primary_release_date';
  const today = new Date().toISOString().slice(0, 10);
  const from  = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const r = await axios.get(`${BASE_URL}discover/${type}`, {
      params: {
        api_key: TMDB_API_KEY, with_original_language: lang, sort_by: 'popularity.desc',
        include_adult: false, 'vote_count.gte': 10,
        [`${dateField}.gte`]: from, [`${dateField}.lte`]: today,
      }
    });
    let items = (r.data.results || []).slice(0, limit).map(item => _normalise_list_item(item, type));

    if (items.length < limit) {
      const fb = await axios.get(`${BASE_URL}discover/${type}`, {
        params: { api_key: TMDB_API_KEY, with_original_language: lang, sort_by: 'popularity.desc', include_adult: false, 'vote_count.gte': 50 }
      });
      const have = new Set(items.map(i => i.id));
      for (const item of fb.data.results || []) {
        if (items.length >= limit) break;
        if (!have.has(item.id)) items.push(_normalise_list_item(item, type));
      }
    }

    const enriched = await _enrich_batch(items, 5);
    res.json({ success: true, language: lang, language_name: LANG_DISPLAY[lang] || lang, content_type: type, results: enriched });
  } catch (e) {
    console.error(`TMDB Trending Language [${lang}/${type}]:`, e.message);
    res.status(500).json({ success: false, message: `Failed to fetch trending ${lang} ${type}.`, details: e.message });
  }
});

// ── /tmdb-enrich (POST) ───────────────────────────────────────────────────────
// Body: [{ tmdb_id, content_type }, ...]  → [{ tmdb_id, title_logo, trailer_key }]

router.post('/tmdb-enrich', async (req, res) => {
  const items = req.body;
  if(!Array.isArray(items)||items.length===0) return res.status(400).json({ success:false, message:'Body must be non-empty array.' });
  try {
    const enrichments = await Promise.all(
      items.map(({tmdb_id,content_type})=>_get_logo_and_trailer(tmdb_id,content_type||'movie').then(e=>({tmdb_id,...e})))
    );
    res.json({ success:true, results:enrichments });
  } catch(e){ res.status(500).json({ success:false, details:e.message }); }
});

// ── CastHQ ────────────────────────────────────────────────────────────────────

router.get('/casthq/direct-link', async (req, res) => {
  const API_KEY=req.query.key||DEFAULT_CASTHQ_KEY, FILE_CODE=req.query.file_code, QUALITY=req.query.q||'', HLS=req.query.hls||1;
  if(!FILE_CODE) return res.status(400).json({ success:false, message:'Missing file_code' });
  let hlsUrl=null;
  try {
    const apiData=(await axios.get(`${CASTHQ_API_BASE}/file/direct_link?key=${API_KEY}&file_code=${FILE_CODE}&q=${QUALITY}&hls=${HLS}`)).data;
    if(apiData.status!==200||!apiData.result?.hls_direct) return res.status(apiData.status||502).json({ success:false, error:'Failed to retrieve HLS link.', details:apiData.msg });
    hlsUrl=apiData.result.hls_direct;
  } catch(e){ return res.status(e.response?.status||500).json({ success:false, error:e.message }); }
  try {
    const streamResponse=await axios({ method:'get', url:hlsUrl, responseType:'stream', headers:{ 'Host':new URL(hlsUrl).host, 'User-Agent':'Mozilla/5.0' } });
    res.setHeader('Content-Type','application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
    streamResponse.data.pipe(res);
    streamResponse.data.on('error',(err)=>{ if(!res.headersSent) res.status(502).json({ success:false }); else res.end(); });
  } catch(e){ if(!res.headersSent) res.status(502).json({ success:false, message:e.message }); }
});

router.get('/casthq/file-list', async (req, res) => {
  const API_KEY=req.query.key||DEFAULT_CASTHQ_KEY, page=req.query.page||1, limit=req.query.limit||50;
  try {
    const apiData=(await axios.get(`${CASTHQ_API_BASE}/file/list?key=${API_KEY}&page=${page}&limit=${limit}`)).data;
    if(apiData.status!==200||!apiData.result) return res.status(apiData.status||502).json({ success:false, details:apiData.msg });
    res.json({ success:true, data:apiData.result });
  } catch(e){ res.status(e.response?.status||500).json({ success:false, error:e.message }); }
});

router.get('/casthq/account-info', async (req, res) => {
  const API_KEY=req.query.key||DEFAULT_CASTHQ_KEY;
  try {
    const apiData=(await axios.get(`${CASTHQ_API_BASE}/account/info?key=${API_KEY}`)).data;
    if(apiData.status!==200||!apiData.result) return res.status(apiData.status||502).json({ success:false, details:apiData.msg });
    res.json({ success:true, data:apiData.result });
  } catch(e){ res.status(e.response?.status||500).json({ success:false, error:e.message }); }
});

// ── Save metadata ──────────────────────────────────────────────────────────────

router.post('/save-movie-metadata', async (req, res) => {
  const incomingMovieData=req.body;
  if(!incomingMovieData?.title) return res.status(400).json({ success:false, message:'Invalid data.' });
  try {
    let movies=JSON.parse(await fs.readFile(DATA_FILE_PATH,'utf-8'));
    const idx=movies.findIndex(m=>m.title===incomingMovieData.title);
    if(idx!==-1) movies[idx]={...movies[idx],...incomingMovieData}; else movies.push(incomingMovieData);
    await fs.writeFile(DATA_FILE_PATH,JSON.stringify(movies,null,4));
    res.json({ success:true, message:'Saved.' });
  } catch(e){ console.error('File Write Error:',e); res.status(500).json({ success:false, message:'Write failed.' }); }
});

export default router;
