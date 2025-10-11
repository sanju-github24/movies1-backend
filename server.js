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
import prerender from 'prerender-node';
import up4streamRoutes from "./routes/up4streamRoutes.js";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import WebTorrent from 'webtorrent';
import bunnyRoutes from "./routes/bunnyRoutes.js";
import bmsRouter from "./routes/bms.js";

const app = express();
const port = process.env.PORT || 4000;

// -------------------- Connect to MongoDB --------------------
await connectDBs();

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
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

// -------------------- Middlewares --------------------
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use("/api", bunnyRoutes);
app.use(express.urlencoded({ extended: true }));
// -------------------- Static files --------------------
app.use("/public", express.static("public"));

// -------------------- Pre-rendering for SEO --------------------
if (process.env.PRERENDER_TOKEN) {
  app.use(prerender.set('prerenderToken', process.env.PRERENDER_TOKEN));
}

// -------------------- Supabase --------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -------------------- Routes --------------------
app.use("/api/bms", bmsRouter);
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/movies', movieRouter);
app.use('/api', popadsRoute);
app.use("/api/up4stream", up4streamRoutes);

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
