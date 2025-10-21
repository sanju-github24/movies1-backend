import { Router } from 'express';
import axios from 'axios';
import * as fs from 'fs/promises'; // ⬅️ NEW: Import Node's File System module

const router = Router();

// --- Configuration ---
const TMDB_API_KEY = "452111addfd12727f394865d09a805b4"; 
const BASE_URL = "https://api.themoviedb.org/3/";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500"; 
const BACKDROP_BASE_URL = "https://image.tmdb.org/t/p/w1280"; 

// ⬅️ NEW: Define the path to your data file
const DATA_FILE_PATH = './data/all_south_indian_movies.json'; 

// --- Internal Helper Functions (Remain Unchanged) ---

/**
 * Searches for a title (movie or TV) using TMDB's /search/multi and returns the top match ID.
 * @param {string} title - The title to search for.
 * @returns {Promise<object | null>} - Object with id, name, and media_type, or null if not found.
 */
const _search_title_id = async (title) => {
    // ... (Existing implementation remains the same) ...
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
    // ... (Existing implementation remains the same) ...
    const endpoint = `${BASE_URL}${media_type}/${tmdb_id}`;
    try {
        const response = await axios.get(endpoint, {
            params: { api_key: TMDB_API_KEY, append_to_response: 'credits' } 
        });
        return response.data;
    } catch (error) {
        console.error("TMDB Get Details Error:", error.message);
    }
    return null;
};

// -------------------- TMDB Movie Details Endpoint (GET - Unchanged) --------------------
router.get('/tmdb-details', async (req, res) => {
    const { title } = req.query;
    // ... (Existing logic to fetch TMDB data remains the same) ...
    
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

    const final_result = {
        title: details.title || details.name,
        description: details.overview || 'Description not available.',
        year: year,
        poster_url: poster_url,
        cover_poster_url: backdrop_url, 
        imdb_rating: details.vote_average || 0.0, 
        cast: cast_list,
        // Include a unique identifier if one is available from the frontend data
    };
    
    // Send the final result
    res.json({ success: true, data: final_result });
});


// -------------------- Data Update Endpoint (POST - NEW) --------------------

/**
 * Allows the frontend to send metadata back to the server to be saved to the JSON file.
 * NOTE: For this to work, you must have Express Body Parser configured in your main app.
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
        // This is a simple example: it finds by title and replaces the whole entry.
        const index = movies.findIndex(m => m.title === incomingMovieData.title);

        if (index !== -1) {
            // Update the existing entry
            movies[index] = { ...movies[index], ...incomingMovieData };
            console.log(`Updated existing movie: ${incomingMovieData.title}`);
        } else {
            // Or if you only want to append new movies
            movies.push(incomingMovieData);
            console.log(`Appended new movie: ${incomingMovieData.title}`);
        }
        
        // 3. Write the updated data back to the file
        // The 'null, 4' is for pretty-printing the JSON with 4 spaces for indentation
        await fs.writeFile(DATA_FILE_PATH, JSON.stringify(movies, null, 4));

        res.json({ success: true, message: 'Movie data saved successfully to file.' });

    } catch (error) {
        // Crucial for debugging file system errors (e.g., path, permissions)
        console.error('File System Write Error:', error); 
        res.status(500).json({ success: false, message: 'Server failed to write data to file.' });
    }
});


export default router;
