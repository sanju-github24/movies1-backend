import { Router } from 'express';
import axios from 'axios';
import * as fs from 'fs/promises'; 
import { URL } from 'url';

const router = Router();

// --- Configuration ---
const TMDB_API_KEY = "452111addfd12727f394865d09a805b4"; 
const BASE_URL = "https://api.themoviedb.org/3/";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500"; 
const BACKDROP_BASE_URL = "https://image.tmdb.org/t/p/w1280"; 
const YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch?v="; // Base URL for YouTube trailers

// Define the path to your data file
const DATA_FILE_PATH = './data/data/all_south_indian_movies.json'; 

// --- CastHQ Configuration (UPDATED DOMAIN AND KEY) ---
const CASTHQ_API_BASE = 'https://casthq.to/api'; 
const DEFAULT_CASTHQ_KEY = '154lzcrtrw3lelu26zf'; // Updated API key

// --------------------------------------------------------------------------------------
// --- Internal Helper Functions (TMDB) ---
// --------------------------------------------------------------------------------------

/**
 * Searches for a title (movie or TV) using TMDB's /search/multi and returns the top match ID.
 */
const _search_title_id = async (title) => {
    const endpoint = `${BASE_URL}search/multi`;
    try {
        const response = await axios.get(endpoint, {
            params: { api_key: TMDB_API_KEY, query: title }
        });
        
        if (response.data && response.data.results) {
            for (const result of response.data.results) {
                if (result.media_type === 'movie' || result.media_type === 'tv') {
                    return {
                        id: result.id,
                        name: result.title || result.name,
                        media_type: result.media_type
                    };
                }
            }
        }
    } catch (error) {
        console.error("TMDB Title Search Error:", error.message);
    }
    return null;
};

/**
 * Searches for a TMDB ID using the external IMDb ID.
 */
const _search_imdb_id = async (imdb_id) => {
    const endpoint = `${BASE_URL}find/${imdb_id}`;
    try {
        const response = await axios.get(endpoint, {
            params: { 
                api_key: TMDB_API_KEY, 
                external_source: 'imdb_id' 
            }
        });
        
        // Prioritize movie results, then fall back to TV results
        const results = response.data.movie_results.length > 0 
                      ? response.data.movie_results 
                      : response.data.tv_results;
        
        if (results.length > 0) {
            const top_result = results[0];
            const media_type = response.data.movie_results.length > 0 ? 'movie' : 'tv';

            return {
                id: top_result.id,
                name: top_result.title || top_result.name,
                media_type: media_type
            };
        }
    } catch (error) {
        console.error("TMDB IMDb Search Error:", error.message);
    }
    return null;
};

/**
 * Fetches the full details, credits, external IDs, videos, and **content ratings**.
 * * ⭐️ UPDATED: Added 'release_dates' and 'content_ratings' to the request.
 */
const _get_full_details = async (tmdb_id, media_type) => {
    const endpoint = `${BASE_URL}${media_type}/${tmdb_id}`;
    try {
        const response = await axios.get(endpoint, {
            params: { 
                api_key: TMDB_API_KEY, 
                // CRITICAL ADDITION: Fetch ratings data for both movies and TV
                append_to_response: 'credits,external_ids,videos,release_dates,content_ratings' 
            } 
        });
        return response.data;
    } catch (error) {
        console.error("TMDB Get Details Error:", error.message);
    }
    return null;
};

/**
 * Helper function to extract the content certification string (e.g., 'U/A', 'PG-13').
 * Prioritizes India (IN) and falls back to the United States (US).
 */
const _get_certification = (details, media_type) => {
    // Prioritize Indian certification ('IN'), then US as a reliable international fallback
    const targetCountries = ['IN', 'US']; 
    
    // --- Movie Logic (uses 'release_dates') ---
    if (media_type === 'movie' && details.release_dates) {
        for (const countryCode of targetCountries) {
            const country_data = details.release_dates.results.find(
                (r) => r.iso_3166_1 === countryCode
            );

            if (country_data && country_data.release_dates.length > 0) {
                // Find the first certification, ignoring empty strings
                const release_with_cert = country_data.release_dates.find(
                    (r) => r.certification
                );
                if (release_with_cert) {
                    return release_with_cert.certification;
                }
            }
        }
    } 
    // --- TV Logic (uses 'content_ratings') ---
    else if (media_type === 'tv' && details.content_ratings) {
        for (const countryCode of targetCountries) {
            const country_data = details.content_ratings.results.find(
                (r) => r.iso_3166_1 === countryCode
            );
            
            if (country_data && country_data.rating) {
                return country_data.rating;
            }
        }
    }
    
    return null; // Return null if no certification is found
};


// --------------------------------------------------------------------------------------
// -------------------- TMDB Movie Details Endpoint (GET) --------------------
// --------------------------------------------------------------------------------------

// Access via: GET /api/tmdb-details?title=... or ?imdbId=...
// ... existing helper functions (_search_title_id, _search_imdb_id, _get_full_details, etc.)

// Access via: GET /api/tmdb-details?title=... or ?imdbId=...
router.get('/tmdb-details', async (req, res) => {
    const { title, imdb_id, imdbId } = req.query; 
    const final_imdb_id = imdb_id || imdbId; 
    
    if (!title && !final_imdb_id) {
        return res.status(400).json({ 
            success: false, 
            message: 'Must provide either a movie title or an IMDb ID.' 
        });
    }

    let top_result = null;

    if (final_imdb_id) {
        top_result = await _search_imdb_id(final_imdb_id);
    } else if (title) {
        top_result = await _search_title_id(title);
    }
    
    if (!top_result) {
        const search_param = final_imdb_id ? `IMDb ID: '${final_imdb_id}'` : `title: '${title}'`;
        return res.status(404).json({ 
            success: false, 
            error_type: "TitleNotFound",
            message: `Failed to find a movie or TV show matching the ${search_param}.` 
        });
    }

    const { id: tmdb_id, media_type } = top_result;

    // IMPORTANT: Ensure your _get_full_details function includes "release_dates" in the append_to_response
    const details = await _get_full_details(tmdb_id, media_type);

    if (!details) {
        return res.status(500).json({ 
            success: false, 
            error_type: "DetailsFetchFailed",
            message: `Failed to fetch details for TMDB ID ${tmdb_id}.`
        });
    }

    // --- Dynamic Release Date Logic ---
    let real_theatrical_date = null;

    if (media_type === 'movie' && details.release_dates) {
        // Flatten all release date results from all countries
        const results = details.release_dates.results || [];
        
        // Try to find a Theatrical (3) or Premiere (1) release date
        // We look for 'IN' (India) or 'US' if available, otherwise grab the first theatrical found
        const preferred_regions = ['IN', 'US', 'GB'];
        let found_date = null;

        // Sort results so preferred regions are checked first
        const sorted_results = results.sort((a, b) => {
            const indexA = preferred_regions.indexOf(a.iso_3166_1);
            const indexB = preferred_regions.indexOf(b.iso_3166_1);
            return (indexA === -1 ? 99 : indexA) - (indexB === -1 ? 99 : indexB);
        });

        for (const region of sorted_results) {
            // Types: 1=Premiere, 2=Limited, 3=Theatrical, 4=Digital, 5=Physical, 6=TV
            const theatrical = region.release_dates.find(rd => rd.type === 3 || rd.type === 2);
            if (theatrical) {
                found_date = theatrical.release_date;
                break;
            }
        }
        
        real_theatrical_date = found_date || details.release_date;
    } else {
        // Fallback for TV or if no release_dates info exists
        real_theatrical_date = details.release_date || details.first_air_date;
    }

    // --- Trailer Extraction ---
    let trailer_url = null;
    const videos = details.videos?.results || [];
    const trailer = videos.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
    if (trailer) {
        trailer_url = `${YOUTUBE_WATCH_BASE}${trailer.key}`;
    }

    // --- Cast Extraction ---
    const cast_list = (details.credits?.cast || []).slice(0, 10).map(member => ({
        name: member.name,
        character: member.character,
        profile_url: member.profile_path ? `${IMAGE_BASE_URL}${member.profile_path}` : null
    }));
    
    const genres_list = (details.genres || []).map(g => g.name);
    const certification = _get_certification(details, media_type);
    const poster_url = details.poster_path ? `${IMAGE_BASE_URL}${details.poster_path}` : null;
    const backdrop_url = details.backdrop_path ? `${BACKDROP_BASE_URL}${details.backdrop_path}` : null; 
    const year = real_theatrical_date ? real_theatrical_date.substring(0, 4) : null;

    const final_result = {
        tmdb_id: details.id,
        title: details.title || details.name,
        description: details.overview || 'Description not available.',
        year: year,
        release_date: real_theatrical_date, // This is now the "Real" date
        poster_url: poster_url,
        cover_poster_url: backdrop_url, 
        imdb_rating: details.vote_average || 0.0, 
        cast: cast_list, 
        genres: genres_list, 
        imdb_id: details.external_ids?.imdb_id || null,
        trailer_url: trailer_url,
        certification: certification 
    };
    
    res.json({ success: true, data: final_result });
});
// --------------------------------------------------------------------------------------
// -------------------- CastHQ DIRECT LINK Extractor Endpoint (STREAMER) --------------------
// --------------------------------------------------------------------------------------

/**
 * This endpoint acts as a **content streamer** to bypass anti-hotlinking.
 */
router.get('/casthq/direct-link', async (req, res) => {
    
    const API_KEY = req.query.key || DEFAULT_CASTHQ_KEY; 
    const FILE_CODE = req.query.file_code; 
    
    const QUALITY = req.query.q || ''; 
    const HLS = req.query.hls || 1; 

    if (!FILE_CODE) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Missing required parameter: file_code' 
        });
    }

    let hlsUrl = null;

    try {
        // 1. First, call the CastHQ API to get the final HLS URL
        const apiUrl = `${CASTHQ_API_BASE}/file/direct_link?key=${API_KEY}&file_code=${FILE_CODE}&q=${QUALITY}&hls=${HLS}`;

        const apiResponse = await axios.get(apiUrl);
        const apiData = apiResponse.data;

        if (apiData.status !== 200 || !apiData.result || !apiData.result.hls_direct) {
            console.error('External CastHQ API Error:', apiData.msg || 'No direct HLS URL found.');
            
            return res.status(apiData.status || 502).json({ 
                success: false,
                error: 'Failed to retrieve HLS link from CastHQ provider.',
                details: apiData.msg 
            });
        }
        
        hlsUrl = apiData.result.hls_direct;

    } catch (error) {
        console.error('Network or Request Error fetching CastHQ link:', error.message);
        const statusCode = error.response ? error.response.status : 500;
        
        return res.status(statusCode).json({ 
            success: false, 
            error: `Request failed with status code ${statusCode}. Please check the file_code or API key.`,
            details: error.message 
        });
    }


    // 2. Stream the HLS manifest content directly to the client
    try {
        const streamResponse = await axios({
            method: 'get',
            url: hlsUrl,
            responseType: 'stream', 
            headers: {
                // Must explicitly provide 'Host' header when streaming external content
                'Host': new URL(hlsUrl).host,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        // 3. Set necessary headers for the client
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); 
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        
        // 4. Pipe the external stream directly into the Express response stream
        streamResponse.data.pipe(res);
        
        streamResponse.data.on('error', (err) => {
             console.error(`Error piping stream for ${FILE_CODE}:`, err.message);
             if (!res.headersSent) {
                 res.status(502).json({ success: false, message: 'Stream data transfer failed.' });
             } else {
                 res.end(); 
             }
        });

    } catch (error) {
        console.error(`Error streaming content for ${FILE_CODE}:`, error.message);
        
        const statusCode = error.response ? error.response.status : 502;
        
        if (!res.headersSent) {
             return res.status(statusCode).json({ 
                success: false, 
                message: 'Failed to initiate content stream from video host.',
                details: error.message
            });
        }
    }
});


// --------------------------------------------------------------------------------------
// -------------------- CastHQ FILE LIST Endpoint (GET) --------------------
// --------------------------------------------------------------------------------------

router.get('/casthq/file-list', async (req, res) => {
    
    const API_KEY = req.query.key || DEFAULT_CASTHQ_KEY; 
    const page = req.query.page || 1;
    const limit = req.query.limit || 50;
    
    try {
        const apiUrl = `${CASTHQ_API_BASE}/file/list?key=${API_KEY}&page=${page}&limit=${limit}`;

        const apiResponse = await axios.get(apiUrl);
        const apiData = apiResponse.data;

        if (apiData.status !== 200 || !apiData.result) {
            console.error('External CastHQ API Error:', apiData.msg || 'Unknown API response error');
            
            return res.status(apiData.status || 502).json({ 
                success: false,
                error: 'Failed to retrieve file list from CastHQ provider.',
                details: apiData.msg 
            });
        }

        res.json({
            success: true,
            message: 'File list successfully retrieved from CastHQ.',
            data: apiData.result
        });

    } catch (error) {
        console.error('Network or Request Error fetching CastHQ list:', error.message);
        
        const statusCode = error.response ? error.response.status : 500;
        
        res.status(statusCode).json({ 
            success: false, 
            error: `Request failed with status code ${statusCode}. If the key is correct, the endpoint path might be the issue.`,
            details: error.message 
        });
    }
});

// --------------------------------------------------------------------------------------
// -------------------- CastHQ ACCOUNT INFO Endpoint (GET) --------------------
// --------------------------------------------------------------------------------------

router.get('/casthq/account-info', async (req, res) => {
    
    const API_KEY = req.query.key || DEFAULT_CASTHQ_KEY; 
    
    try {
        const apiUrl = `${CASTHQ_API_BASE}/account/info?key=${API_KEY}`;

        const apiResponse = await axios.get(apiUrl);
        const apiData = apiResponse.data;

        if (apiData.status !== 200 || !apiData.result) {
            console.error('External CastHQ Account Info Error:', apiData.msg || 'Unknown API response error');
            
            return res.status(apiData.status || 502).json({ 
                success: false,
                error: 'Failed to retrieve account info from CastHQ provider.',
                details: apiData.msg 
            });
        }

        res.json({
            success: true,
            message: 'Account info successfully retrieved from CastHQ.',
            data: apiData.result
        });

    } catch (error) {
        console.error('Network or Request Error fetching CastHQ account info:', error.message);
        
        const statusCode = error.response ? error.response.status : 500;
        
        res.status(statusCode).json({ 
            success: false, 
            error: `Request failed with status code ${statusCode}. Key may be invalid.`,
            details: error.message 
        });
    }
});


// -------------------- Data Update Endpoint (POST) --------------------

/**
 * Allows the frontend to send metadata back to the server to be saved to the JSON file.
 * Access via: POST /api/save-movie-metadata
 */
router.post('/save-movie-metadata', async (req, res) => {
    const incomingMovieData = req.body; 

    if (!incomingMovieData || !incomingMovieData.title) {
        return res.status(400).json({ success: false, message: 'Invalid or incomplete movie data provided.' });
    }

    try {
        const rawData = await fs.readFile(DATA_FILE_PATH, 'utf-8');
        let movies = JSON.parse(rawData);

        const index = movies.findIndex(m => m.title === incomingMovieData.title);

        if (index !== -1) {
            movies[index] = { ...movies[index], ...incomingMovieData };
            console.log(`Updated existing movie: ${incomingMovieData.title}`);
        } else {
            movies.push(incomingMovieData);
            console.log(`Appended new movie: ${incomingMovieData.title}`);
        }
        
        await fs.writeFile(DATA_FILE_PATH, JSON.stringify(movies, null, 4));

        res.json({ success: true, message: 'Movie data saved successfully to file.' });

    } catch (error) {
        console.error('File System Write Error:', error); 
        res.status(500).json({ success: false, message: 'Server failed to write data to file.' });
    }
});


export default router;
