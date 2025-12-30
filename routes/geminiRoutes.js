import express from 'express';
import { GoogleGenAI } from "@google/genai";

const router = express.Router();

// Initialize the Gemini client. 
// It automatically looks for the GEMINI_API_KEY environment variable.
if (!process.env.GEMINI_API_KEY) {
    console.error("❌ ERROR: GEMINI_API_KEY is not set in environment variables.");
}
// Initialize the client. The key is retrieved automatically from the environment.
const ai = new GoogleGenAI({});

// ----------------------------------------------------------------------
// POST /api/gemini/generate-blog
// Generates a structured movie detail block in rich HTML with images and streaming info,
// following a specific, professional blog layout.
// ----------------------------------------------------------------------
router.post('/generate-blog', async (req, res) => {
    // 1. Destructure all required inputs from the frontend
    const { movieTitle, selectedMovies, tags } = req.body;

    // 2. Input Validation
    if (!movieTitle || !selectedMovies || selectedMovies.length === 0) {
        return res.status(400).json({ 
            error: 'Primary movie title and selection list are required to generate blog content.' 
        });
    }

    const primaryMovieTitle = selectedMovies[0]?.title || movieTitle;

    // 3. Construct the prompt and system instruction for detailed data retrieval
    
    // System instruction defines the AI's persona, output format, styling, and CRITICAL ORDER
    const systemInstruction = `You are a professional, accurate, and visually-aware movie database expert creating a blog post. Your goal is to generate a comprehensive, visually appealing HTML block using current Google Search data.

RULES:
1. The entire output MUST be valid, clean, self-contained HTML (using <h2>, <h3>, <p>, <strong>, <ul>, <li>, <div> tags). DO NOT include <html>, <body>, or markdown syntax.
2. The content MUST STRICTLY FOLLOW this sequential blog structure: **Title -> Main Poster -> Key Detail Block (Rating, Streaming) -> Storyline -> Cast List.**
3. Use inline styles (CSS) for a **modern, dark cinema theme** (e.g., background-color: #1a1a1a, text color: #f0f0f0, accents: #FFD700). Use responsive inline CSS (e.g., max-width: 100%) to ensure it looks good on mobile.`;

    // User query defines the specific task, requesting image URLs and streaming details
    const userQuery = `Find the following detailed and accurate information for the movie: "${primaryMovieTitle}".

    Generate the complete HTML blog content following the structure specified in your system instructions, ensuring NO information is skipped:
    
    1.  **Title:** Start with the movie title in a bold, eye-catching <h2 style="color: #FFD700; text-align: center; margin-bottom: 20px;">.
    2.  **Main Poster:** The direct URL for the main movie poster. Display it prominently using an **<img>** tag with max-width: 350px, styled to be **centered** (using display: block and margin: 0 auto), with rounded corners (12px) and a significant box-shadow.
    3.  **Key Detail Block:** Create a styled <div> using Flexbox to align content (display: flex, justify-content: space-around). This block MUST contain:
        * **IMDb Rating:** The current rating emphasized with **<strong>** and a gold color.
        * **Streaming Platforms:** A bulleted <ul> list of 3-5 platforms where the movie is currently streaming. For each platform, **you must include the platform's logo image URL** displayed at 30x30px next to the name.
    4.  **Storyline:** A concise, detailed plot summary (around 3-4 paragraphs) in **<p>** tags under an **<h3 style="color: #FFD700;">** heading.
    5.  **Main Cast:** A list of at least 5 main actors/actresses and their character names. For each actor, attempt to find their headshot image URL and display it as a small, circular **<img>** (60x60px, border-radius: 50%) next to their name in a styled, list format.

    Wrap the entire content in a single **<div style="padding: 28px; background-color: #1a1a1a; border-radius: 16px; color: #f0f0f0; line-height: 1.6; box-shadow: 0 0 25px rgba(0, 0, 0, 0.7); max-width: 800px; margin: 0 auto;">** block.`;

    try {
        // 4. Call the Gemini API with the correct structure and configuration
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash", 
            // The contents must be an array of parts
            contents: [{ parts: [{ text: userQuery }] }], 
            config: {
                systemInstruction: systemInstruction,
                maxOutputTokens: 1500, 
                temperature: 0.4, 
                // Essential: Add Google Search grounding to retrieve accurate, current data and URLs
                tools: [{ googleSearch: {} }], 
            }
        });

        // 5. Extract and clean content
        const generatedContent = response.text; 

        if (generatedContent) {
            // Success: Trim the content and send the response
            res.status(200).json({ 
                success: true,
                content: generatedContent.trim()
            });
        } else {
            // Failure: Model returned a 200 OK response but no text (e.g., safety block)
            const candidate = response.candidates?.[0];
            const blockReason = candidate?.finishReason;
            const safetyRatings = candidate?.safetyRatings;
            
            console.error('❌ Gemini API Error (No Content Generated):', { blockReason, safetyRatings });
            
            let errorMessage = `AI did not return content.`;
            if (blockReason === 'SAFETY') {
                errorMessage = `AI generation was blocked due to safety policy. Check the inputs or try a different title.`;
            } else if (blockReason) {
                errorMessage = `AI generation failed with finish reason: ${blockReason}.`;
            }
            
            return res.status(500).json({ 
                success: false, 
                error: errorMessage 
            });
        }

    } catch (error) {
        // 6. Handle network errors, key errors, or other internal failures from the SDK
        console.error("❌ Fatal Server Error during Gemini API call:", error.message);
        
        // Check for common permission/key errors and give a specific hint
        const errorMessage = error.message.includes('API key') || error.message.includes('PERMISSION_DENIED')
            ? 'Failed to generate content: Check your GEMINI_API_KEY and ensure the Generative Language API is enabled on its project.'
            : 'Failed to generate content from AI. Please check server logs for the full stack trace.';
        
        res.status(500).json({ 
            success: false,
            error: errorMessage
        });
    }
});

export default router;