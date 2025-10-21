import { Router } from 'express';
import axios from 'axios'; // Import axios for making HTTP requests

const router = Router();

// --- Configuration ---
// TMDB API key (should ideally be in .env, but use process.env in production)
const TMDB_API_KEY = "452111addfd12727f394865d09a805b4"; 
const BASE_URL = "https://api.themoviedb.org/3/";
// Use a different size for the backdrop (e.g., w1280 or original)
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500"; 
const BACKDROP_BASE_URL = "https://image.tmdb.org/t/p/w1280"; // Use a larger size for the cover/backdrop

// --- Internal Helper Functions ---

/**
 * Searches for a title (movie or TV) using TMDB's /search/multi and returns the top match ID.
 * @param {string} title - The title to search for.
 * @returns {Promise<object | null>} - Object with id, name, and media_type, or null if not found.
 */
const _search_title_id = async (title) => {
    const endpoint = `${BASE_URL}search/multi`;
    try {
        const response = await axios.get(endpoint, {
            params: { api_key: TMDB_API_KEY, query: title }
        });
        
        if (response.data && response.data.results) {
            for (const result of response.data.results) {
                // Prioritize movies and TV shows
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
        console.error("TMDB Search ID Error:", error.message);
    }
    return null;
};

/**
 * Fetches the full details and credits for a given TMDB ID.
 * @param {number} tmdb_id - The TMDB ID of the content.
 * @param {string} media_type - 'movie' or 'tv'.
 * @returns {Promise<object | null>} - The full JSON response including 'credits'.
 */
const _get_full_details = async (tmdb_id, media_type) => {
    const endpoint = `${BASE_URL}${media_type}/${tmdb_id}`;
    try {
        const response = await axios.get(endpoint, {
            // Use append_to_response to get cast details in one call
            params: { api_key: TMDB_API_KEY, append_to_response: 'credits' } 
        });
        return response.data;
    } catch (error) {
        console.error("TMDB Get Details Error:", error.message);
    }
    return null;
};

// -------------------- TMDB Movie Details Endpoint --------------------
router.get('/tmdb-details', async (req, res) => {
    const { title } = req.query;

    if (!title) {
        return res.status(400).json({ success: false, message: 'Movie title is required.' });
    }

    // 1. Search for ID
    const top_result = await _search_title_id(title);
    
    if (!top_result) {
        return res.status(404).json({ 
            success: false, 
            error_type: "TitleNotFound",
            message: `Failed to find a movie or TV show matching the title: '${title}'.` 
        });
    }

    const { id: tmdb_id, media_type } = top_result;

    // 2. Fetch full details and credits
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
    
    // Get top 5 cast members
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
    
    // Extract the backdrop path for the cover poster
    const backdrop_path = details.backdrop_path;
    const backdrop_url = backdrop_path ? `${BACKDROP_BASE_URL}${backdrop_path}` : null; // Use the larger base URL

    
    // Determine the release date field based on media type and extract the year
    let release_date = details.release_date; // Default for movies
    if (media_type === 'tv') {
        release_date = details.first_air_date; // Use first_air_date for TV shows
    }
    const year = release_date ? release_date.substring(0, 4) : null;

    const final_result = {
        title: details.title || details.name, // 'title' for movies, 'name' for TV
        // ✅ ADDED: Movie/TV Show Description (overview)
        description: details.overview || 'Description not available.',
        year: year,
        poster_url: poster_url,
        cover_poster_url: backdrop_url, 
        // TMDB's 'vote_average' is used as the IMDb Rating proxy
        imdb_rating: details.vote_average || 0.0, 
        cast: cast_list
    };
    
    // Send the final result
    res.json({ success: true, data: final_result });
});

export default router;