import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import authRouter from './routes/authRoutes.js';
import userRouter from './routes/userRoutes.js';
import movieRouter from './routes/movieRoutes.js';
import popadsRoute from './routes/popadsRoute.js';
import { connectDBs } from './config/mongodb.js';
import cron from 'node-cron';
import prerender from 'prerender-node';
import up4streamRoutes from "./routes/up4streamRoutes.js";
import * as cheerio from "cheerio";
import Fuse from "fuse.js";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import puppeteer from "puppeteer";
import bmsRouter from "./routes/bms.js";
const app = express();
const port = process.env.PORT || 4000;

// ✅ Connect to MongoDB
await connectDBs();

// ✅ CORS setup
const allowedOrigins = [
  'http://localhost:5173',
  'https://auth-2407.netlify.app',
  'https://movies1-frontend.vercel.app',
  'https://1anchormovies.vercel.app',
  'https://www.1anchormovies.live',
];


const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

// ✅ Middlewares
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use("/api/bms", bmsRouter);
// ✅ Pre-rendering for SEO (for bots like Googlebot)
app.use(
  prerender.set('prerenderToken', process.env.PRERENDER_TOKEN)
);


// ✅ Basic test route
app.get('/', (req, res) => res.send('✅ API is live'));

// ✅ API Routes
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/movies', movieRouter);
app.use('/api', popadsRoute);
app.use("/api/up4stream", up4streamRoutes);

// ✅ File proxy download handler
import WebTorrent from 'webtorrent'; // Make sure to install: npm install webtorrent

const client = new WebTorrent();

app.get('/proxy-download', async (req, res) => {
  const { url, filename } = req.query;

  if (!url || !filename) {
    return res.status(400).send('❌ Missing URL or filename');
  }

  const decodedUrl = decodeURIComponent(url);

  try {
    // If magnet link
    if (decodedUrl.startsWith('magnet:')) {
      client.add(decodedUrl, { path: '/tmp' }, (torrent) => {
        // Choose the largest file (usually the main media)
        const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

        file.createReadStream().pipe(res);

        file.on('done', () => {
          console.log('✅ Torrent streaming completed');
          client.remove(decodedUrl); // Clean up
        });
      });
    } else {
      // Normal direct URL
      const response = await axios({
        method: 'GET',
        url: decodedUrl,
        responseType: 'stream',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36',
          Accept: '*/*',
          Referer: decodedUrl,
        },
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      });

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      response.data.pipe(res);
    }
  } catch (err) {
    console.error('❌ Proxy failed, redirecting:', err.message);
    res.redirect(decodedUrl); // fallback
  }
});
// ---------------- BMS route (Supabase source) ----------------

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.get("/api/bms", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ success: false, message: "No slug provided" });

  try {
    // 1️⃣ Fetch movie title from Supabase using slug
    const { data, error } = await supabase
      .from("watch_html")
      .select("title")
      .eq("slug", slug)
      .single();

    if (error || !data)
      return res.status(404).json({ success: false, message: "Movie not found in DB" });

    const title = data.title;

    // 2️⃣ Puppeteer scrape BookMyShow (city = Bengaluru)
    const browser = await puppeteer.launch({ headless: true });
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

    if (!movie)
      return res.status(404).json({ success: false, message: "Movie not found on BMS" });

    res.json({ success: true, movie });

  } catch (err) {
    console.error("BMS Puppeteer error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ✅ Start server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
