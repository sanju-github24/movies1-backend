import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import fs from 'fs';       
import path from 'path';     
import { fileURLToPath } from 'url'; 
import { dirname } from 'path';
import { startTelegramBot } from "./telegram/bot.js";


import authRouter from './routes/authRoutes.js';
import userRouter from './routes/userRoutes.js';
import movieRouter from './routes/movieRoutes.js';
import popadsRoute from './routes/popadsRoute.js';
import { connectDBs } from './config/mongodb.js';
import prerender from 'prerender-node';
import up4streamRoutes from "./routes/up4streamRoutes.js";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";

import bunnyRoutes from "./routes/bunnyRoutes.js";
import bmsRouter from "./routes/bms.js";
import tmdbRouter from './routes/tmdbRoutes.js'; // Ensure you have this router file if imported
import geminiRoutes from './routes/geminiRoutes.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 4000;

// -------------------- Connect to MongoDB --------------------
await connectDBs();
// -------------------- Start Telegram Bot --------------------
startTelegramBot();


// -------------------- LOAD CLEANED MOVIE DATA --------------------
const dataPath = path.join(__dirname, 'data', 'all_south_indian_movies.json');
let cleanedMovieData = [];

try {
    const rawData = fs.readFileSync(dataPath, 'utf-8');
    cleanedMovieData = JSON.parse(rawData);
    console.log(`✅ Cleaned movie data loaded: ${cleanedMovieData.length} movies.`);
} catch (error) {
    console.error("❌ ERROR: Failed to load cleaned movie data. Make sure the file is in a '/data' folder.", error.message);
    // Continue running the server even if data loading fails
}

// -------------------- CORS --------------------
const allowedOrigins = [
  'http://localhost:5173',
  'https://auth-2407.netlify.app',
  'https://movies1-frontend.vercel.app',
  'https://1anchormovies.vercel.app',
  'https://www.1anchormovies.live',
];

const corsOptions = {
  origin: function (origin, callback) {
    // 🔍 CRITICAL DEBUGGING AID: Log the incoming origin
    console.log('Incoming Request Origin:', origin);
    
    // Allow requests with no origin (like local file access or curl)
    if (!origin) return callback(null, true); 

    if (allowedOrigins.includes(origin)) {
        callback(null, true);
    }
    else {
        console.error(`CORS Block: Origin ${origin} not allowed.`);
        callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

// -------------------- Middlewares --------------------
// This MUST be the first middleware to guarantee the CORS header is set for ALL responses.
app.use(cors(corsOptions)); 
app.options('*', cors(corsOptions));

// 🚀 FINAL CORS FIX MIDDLEWARE: Manually set headers right after the 'cors' middleware
app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // Allow ALL origins for the proxy response to ensure Hls.js can fetch segments reliably
    if (req.path.startsWith('/api/live-stream-proxy')) {
        res.setHeader('Access-Control-Allow-Origin', '*'); // Allow any origin for the stream
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        // Crucial for HLS: Allow the browser to access common content types
        res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization'); 
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range'); // Expose headers HLS.js might need
        return next(); // Skip origin checking for the proxy route
    }
    
    // For all other API routes, check against allowedOrigins
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); 
    }
    
    next();
});

app.use(express.json());
app.use(cookieParser());
app.use("/api", bunnyRoutes);
app.use(express.urlencoded({ extended: true }));
app.use("/api/gemini", geminiRoutes);
// -------------------- Static files --------------------
app.use("/public", express.static("public"));

// -------------------- Pre-rendering for SEO --------------------
if (process.env.PRERENDER_TOKEN) {
  app.use(prerender.set('prerenderToken', process.env.PRERENDER_TOKEN));
}

// -------------------- Supabase --------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -------------------- New API Endpoint (Data) --------------------
app.get('/api/cleaned-movies', (req, res) => {
    res.json(cleanedMovieData);
});

// =========================================================
// 🚀 NEW HLS LIVE STREAM PROXY ENDPOINT
// =========================================================
app.get('/api/live-stream-proxy', async (req, res) => {
    const streamUrl = req.query.url;

    if (!streamUrl) {
        return res.status(400).send('❌ Missing stream URL query parameter.');
    }
    
    console.log(`Proxying request for HLS stream: ${streamUrl}`);

    try {
        // Use axios to fetch the external stream content
        const response = await axios({
            method: 'GET',
            url: streamUrl,
            responseType: 'stream', // Crucial for streaming large files
            // IMPORTANT: Forward headers like Range, which Hls.js uses to request segments
            headers: {
                'User-Agent': req.headers['user-agent'] || 'HLS-Proxy-Server',
                'Referer': req.headers['referer'] || 'http://localhost',
                // This ensures Hls.js can request specific byte ranges
                'Range': req.headers['range'] || undefined, 
            },
            timeout: 30000, // 30 second timeout
        });

        // Set response headers from the upstream server
        // This is necessary to correctly deliver M3U8 (manifest) or TS (segment) files
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        if (response.headers['accept-ranges']) {
            res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
        }
        if (response.headers['content-range']) {
            res.setHeader('Content-Range', response.headers['content-range']);
        }
        
        // This line is the CORS fix: it ensures the *browser* will accept the response
        res.setHeader('Access-Control-Allow-Origin', '*'); 
        
        // Pipe the external stream response directly to the client's response
        response.data.pipe(res);

        // Handle errors during the piping process
        response.data.on('error', (err) => {
            console.error('❌ Proxy stream error (piping):', err.message);
            if (!res.headersSent) {
                res.status(500).end('Proxy streaming failed.');
            }
        });

    } catch (error) {
        const status = error.response ? error.response.status : 500;
        const message = error.message;
        console.error(`❌ Proxy request failed for ${streamUrl}: Status ${status}, Error: ${message}`);
        
        if (!res.headersSent) {
            res.status(status).send(`Proxy failed to fetch stream: ${message}`);
        }
    }
});


// -------------------- Routes --------------------
app.use("/api/bms", bmsRouter);
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/movies', movieRouter);
app.use('/api', popadsRoute);
app.use("/api/up4stream", up4streamRoutes);
app.use('/api', tmdbRouter); // Ensure this line is present if using TMDB

// -------------------- Proxy download handler --------------------
const client = new WebTorrent();

app.get('/proxy-download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || !filename) return res.status(400).send('❌ Missing URL or filename');

  const decodedUrl = decodeURIComponent(url);
  try {
    if (decodedUrl.startsWith('magnet:')) {
      client.add(decodedUrl, { path: '/tmp' }, (torrent) => {
        const file = torrent.files.reduce((a, b) => a.length > b.length ? a : b);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        file.createReadStream().pipe(res);
        file.on('done', () => client.remove(decodedUrl));
      });
    } else {
      const response = await axios({
        method: 'GET',
        url: decodedUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: '*/*',
          Referer: decodedUrl,
        },
        timeout: 20000,
      });
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }
      response.data.pipe(res);
    }
  } catch (err) {
    console.error('❌ Proxy failed:', err.message);
    res.redirect(decodedUrl);
  }
});

// -------------------- BMS route using Puppeteer --------------------
app.get("/api/bms", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ success: false, message: "No slug provided" });

  try {
    // Fetch movie title from Supabase
    const { data, error } = await supabase
      .from("watch_html")
      .select("title")
      .eq("slug", slug)
      .single();

    if (error || !data) return res.status(404).json({ success: false, message: "Movie not found in DB" });

    const title = data.title;

    // Launch Puppeteer
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    const url = `https://in.bookmyshow.com/bengaluru/movies?q=${encodeURIComponent(title)}`;
    await page.goto(url, { waitUntil: "networkidle2" });

    const movie = await page.evaluate(() => {
      const card = document.querySelector("a[data-testid='card']");
      if (!card) return null;
      return {
        title: card.querySelector("[data-testid='movie-name']")?.innerText || "N/A",
        language: card.querySelector("[data-testid='movie-language']")?.innerText || "N/A",
        releaseDate: card.querySelector("[data-testid='release-date']")?.innerText || "N/A",
        rating: card.querySelector("[data-testid='rating']")?.innerText || "N/A",
        poster: card.querySelector("img")?.src || null,
      };
    });

    await browser.close();

    if (!movie) return res.status(404).json({ success: false, message: "Movie not found on BMS" });

    res.json({ success: true, movie });

  } catch (err) {
    console.error("BMS Puppeteer error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// -------------------- Test route --------------------
app.get('/', (req, res) => res.send('✅ API is live'));

// -------------------- Start server --------------------
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
