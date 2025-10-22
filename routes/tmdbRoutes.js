import { Router } from 'express';
import axios from 'axios';
import * as fs from 'fs/promises'; 

const router = Router();

// --- Configuration ---
const TMDB_API_KEY = "452111addfd12727f394865d09a805b4"; 
const BASE_URL = "https://api.themoviedb.org/3/";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500"; 
const BACKDROP_BASE_URL = "https://image.tmdb.org/t/p/w1280"; 

// Define the path to your data file
const DATA_FILE_PATH = './data/data/all_south_indian_movies.json'; 

// --------------------------------------------------------------------------------------
// --- Internal Helper Functions (UPDATED) ---
// --------------------------------------------------------------------------------------

/**
 * Searches for a title (movie or TV) using TMDB's /search/multi and returns the top match ID.
 * This is used for title search only.
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
 * This returns the TMDB ID and media_type.
 */
const _search_imdb_id = async (imdb_id) => {
    // TMDB's /find endpoint is used to search by external ID (like IMDb ID)
    const endpoint = `${BASE_URL}find/${imdb_id}`;
    try {
        const response = await axios.get(endpoint, {
            params: { 
                api_key: TMDB_API_KEY, 
                external_source: 'imdb_id' 
            }
        });
        
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
 * Fetches the full details, credits, and external IDs (including IMDb ID).
 */
const _get_full_details = async (tmdb_id, media_type) => {
    const endpoint = `${BASE_URL}${media_type}/${tmdb_id}`;
    try {
        const response = await axios.get(endpoint, {
            params: { 
                api_key: TMDB_API_KEY, 
                // ⬅️ CRITICAL: Append external_ids to get the IMDb ID
                append_to_response: 'credits,external_ids' 
            } 
        });
        return response.data;
    } catch (error) {
        console.error("TMDB Get Details Error:", error.message);
    }
    return null;
};

// --------------------------------------------------------------------------------------
// -------------------- TMDB Movie Details Endpoint (GET - NEW LOGIC) --------------------
// --------------------------------------------------------------------------------------

router.get('/tmdb-details', async (req, res) => {
    // ⬅️ NEW: Check for imdb_id first, then fallback to title
    const { title, imdb_id } = req.query; 
    
    if (!title && !imdb_id) {
        return res.status(400).json({ 
            success: false, 
            message: 'Must provide either a movie title or an IMDb ID.' 
        });
    }

    let top_result = null;

    if (imdb_id) {
        // PRIORITY 1: Search by IMDb ID
        top_result = await _search_imdb_id(imdb_id);
    } else if (title) {
        // PRIORITY 2: Search by Title
        top_result = await _search_title_id(title);
    }
    
    if (!top_result) {
        const search_param = imdb_id ? `IMDb ID: '${imdb_id}'` : `title: '${title}'`;
        return res.status(404).json({ 
            success: false, 
            error_type: "TitleNotFound",
            message: `Failed to find a movie or TV show matching the ${search_param}.` 
        });
    }

    const { id: tmdb_id, media_type } = top_result;

    // 2. Fetch full details, credits, and external IDs
    const details = await _get_full_details(tmdb_id, media_type);

    if (!details) {
        return res.status(500).json({ 
            success: false, 
            error_type: "DetailsFetchFailed",
            message: `Failed to fetch details for TMDB ID ${tmdb_id}.`
        });
    }

    // 3. Process Cast Data (Top 5)
    const cast_list = [];
    const credits = details.credits || {};
    
    for (const cast_member of (credits.cast || []).slice(0, 5)) {
        const profile_path = cast_member.profile_path;
        const profile_url = profile_path ? `${IMAGE_BASE_URL}${profile_path}` : null;
        
        cast_list.push({
            name: cast_member.name,
            character: cast_member.character,
            profile_url: profile_url
        });
    }

    // 4. Construct final structured result
    const poster_path = details.poster_path;
    const poster_url = poster_path ? `${IMAGE_BASE_URL}${poster_path}` : null;
    const backdrop_path = details.backdrop_path;
    const backdrop_url = backdrop_path ? `${BACKDROP_BASE_URL}${backdrop_path}` : null; 
    
    let release_date = details.release_date; 
    if (media_type === 'tv') {
        release_date = details.first_air_date;
    }
    const year = release_date ? release_date.substring(0, 4) : null;
    
    // ⬅️ NEW: Extract and include the IMDb ID from the external_ids object
    const extracted_imdb_id = details.external_ids ? details.external_ids.imdb_id : null;


    const final_result = {
        title: details.title || details.name,
        description: details.overview || 'Description not available.',
        year: year,
        poster_url: poster_url,
        cover_poster_url: backdrop_url, 
        imdb_rating: details.vote_average || 0.0, 
        cast: cast_list,
        // ⬅️ FINAL: Add the IMDb ID to the result
        imdb_id: extracted_imdb_id,
    };
    
    // Send the final result
    res.json({ success: true, data: final_result });
});


// -------------------- Data Update Endpoint (POST - UNCHANGED) --------------------

/**
 * Allows the frontend to send metadata back to the server to be saved to the JSON file.
 */
router.post('/save-movie-metadata', async (req, res) => {
    // Expects the complete movie object (original data + new TMDB metadata) in the request body
    const incomingMovieData = req.body; 

    if (!incomingMovieData || !incomingMovieData.title) {
        return res.status(400).json({ success: false, message: 'Invalid or incomplete movie data provided.' });
    }

    try {
        // 1. Read the existing file data
        const rawData = await fs.readFile(DATA_FILE_PATH, 'utf-8');
        let movies = JSON.parse(rawData);

        // 2. Find and Update the existing movie entry (Best practice)
        const index = movies.findIndex(m => m.title === incomingMovieData.title);

        if (index !== -1) {
            // Update the existing entry
            movies[index] = { ...movies[index], ...incomingMovieData };
            console.log(`Updated existing movie: ${incomingMovieData.title}`);
        } else {
            // Append new movies
            movies.push(incomingMovieData);
            console.log(`Appended new movie: ${incomingMovieData.title}`);
        }
        
        // 3. Write the updated data back to the file
        await fs.writeFile(DATA_FILE_PATH, JSON.stringify(movies, null, 4));

        res.json({ success: true, message: 'Movie data saved successfully to file.' });

    } catch (error) {
        console.error('File System Write Error:', error); 
        res.status(500).json({ success: false, message: 'Server failed to write data to file.' });
    }
});


export default router;
