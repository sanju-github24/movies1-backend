import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import fs from 'fs';       
import path from 'path';     
import { fileURLToPath } from 'url'; 
import { dirname } from 'path';
import { spawn } from 'child_process';
import { startTelegramBot } from "./telegram/bot.js";

import authRouter from './routes/authRoutes.js';
import userRouter from './routes/userRoutes.js';
import movieRouter from './routes/movieRoutes.js';
import popadsRoute from './routes/popadsRoute.js';
import { connectDBs } from './config/mongodb.js';
import prerender from 'prerender-node';

import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";

import bunnyRoutes from "./routes/bunnyRoutes.js";
import bmsRouter from "./routes/bms.js";
import tmdbRouter from './routes/tmdbRoutes.js';
import geminiRoutes from './routes/geminiRoutes.js';
import autofillRouter from './routes/autofill.js';

import { generateSignedUrl } from "./utils/signUrl.js";
import crypto from "crypto";

// ── FilmiBeat RSS proxy ───────────────────────────────────────────────────────
import rssProxy from './routes/rssProxy.js';
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import fetch from 'node-fetch';
import { tavily } from "@tavily/core";
import { GoogleGenAI, Type } from "@google/genai";

// =====================================
// 🔑 ICC UUID HELPER
// crypto.randomUUID() works fine in Node 18+ but ICC's entitlement API is
// strict about the Data field format. We generate proper v4 UUIDs manually
// to guarantee the exact format ICC expects.
// =====================================
function makeUUID() {
  const h = () => Math.floor(Math.random() * 16).toString(16);
  const s = (n) => Array.from({ length: n }, h).join('');
  const variant = ['8','9','a','b'][Math.floor(Math.random() * 4)];
  return `${s(8)}-${s(4)}-4${s(3)}-${variant}${s(3)}-${s(12)}`;
}

const getChromiumPath = () => {
    try {
        return execSync('find /app/pw-browsers -name chrome -type f | head -n 1').toString().trim();
    } catch (e) {
        return null;
    }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const app = express();
const port = process.env.PORT || 4000;

await connectDBs();
startTelegramBot();

// -------------------- LOAD CLEANED MOVIE DATA --------------------
const dataPath = path.join(__dirname, 'data', 'all_south_indian_movies.json');
let cleanedMovieData = [];

try {
    const rawData = fs.readFileSync(dataPath, 'utf-8');
    cleanedMovieData = JSON.parse(rawData);
    console.log(`✅ Cleaned movie data loaded: ${cleanedMovieData.length} movies.`);
} catch (error) {
    console.error("❌ ERROR: Failed to load cleaned movie data.", error.message);
}

// -------------------- CORS --------------------
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::]:8080',
  'https://auth-2407.netlify.app',
  'https://movies1-frontend.vercel.app',
  'https://1anchormovies.vercel.app',
  'https://www.1anchormovies.buzz',
  'https://www.1anchormovies.live',
  'https://stream.1anchormovies.live',
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log('Incoming Request Origin:', origin);
    if (!origin) return callback(null, true);
    // Allow any localhost / 127.0.0.1 origin in development
    if (
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:')
    ) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.error(`CORS Block: Origin ${origin} not allowed.`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (req.path.startsWith('/api/live-stream-proxy')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
        return next();
    }

    if (
      origin && (
        allowedOrigins.includes(origin) ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:')
      )
    ) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    next();
});

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use("/api", bunnyRoutes);
app.use("/api/gemini", geminiRoutes);
app.use("/api", autofillRouter);
app.use("/public", express.static("public"));

if (process.env.PRERENDER_TOKEN) {
  app.use(prerender.set('prerenderToken', process.env.PRERENDER_TOKEN));
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// =====================================
// 🎬 FILMIBEAT RSS PROXY
// =====================================
app.use('/api', rssProxy);

// =====================================
// 🔍 TORRENT SEARCH
// =====================================
app.options('/search', cors(corsOptions));
app.get('/search', (req, res) => {
    const movie  = req.query.movie  || "777 Charlie";
    const lang   = req.query.lang   || "Kannada";
    const source = req.query.source || "both";

    console.log(`🔍 Torrent search: movie="${movie}" lang="${lang}" source="${source}"`);

    const pythonProcess = spawn('python3', ['./scrapers/scraper.py', movie, lang, source]);

    let output = "";
    let errorOutput = "";

    pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });

    pythonProcess.on('close', (code) => {
        if (errorOutput) console.error("🐍 Python stderr:", errorOutput);
        try {
            const results = JSON.parse(output);
            res.json(results);
        } catch (e) {
            console.error("❌ JSON parse failed:", output);
            res.status(500).json({ error: "Scraping failed", detail: output });
        }
    });
});

// -------------------- Cleaned Movies --------------------
app.get('/api/cleaned-movies', (req, res) => {
    res.json(cleanedMovieData);
});

// =====================================
// ✅ ICC PROXY — v4 — DEBUG + axios text-mangling fix
//
// Replace your current /api/live-stream-proxy block with this version.
//
// Two changes from v3:
//   1. transformResponse: [(d) => d]  — stops axios from running its default
//      JSON.parse-then-fallback logic on the response body, which can subtly
//      alter XML/text content in some axios versions/configs.
//   2. Extensive console.log of status, content-type, and body preview so we
//      can see EXACTLY what Akamai returned the moment Shaka fails again.
// =====================================

const ICC_PROXY_HEADERS = {
  'Referer':         'https://www.icc-cricket.com/',
  'Origin':          'https://www.icc-cricket.com',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept':          '*/*',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':  '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
};

app.head('/api/live-stream-proxy', (req, res) => {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  res.status(200).end();
});

app.options('/api/live-stream-proxy', (req, res) => {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  res.status(204).end();
});

app.get('/api/live-stream-proxy', async (req, res) => {
  let targetUrl = req.query.url || '';
  try { targetUrl = decodeURIComponent(targetUrl); } catch {}
  if (!targetUrl) return res.status(400).json({ error: 'Missing ?url=' });

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const isMpd  = /\.mpd($|\?)/i.test(targetUrl) || targetUrl.includes('manifest.mpd');
  const isM3u8 = /\.m3u8($|\?)/i.test(targetUrl);
  const isText = isMpd || isM3u8;

  console.log(`\n[Proxy] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[Proxy] Type: ${isMpd ? 'MPD' : isM3u8 ? 'M3U8' : 'SEGMENT'}`);
  console.log(`[Proxy] Target: ${targetUrl}`);

  try {
    const upstream = await axios({
      method:       'GET',
      url:          targetUrl,
      responseType: isText ? 'text' : 'stream',
      // ── CRITICAL FIX ──────────────────────────────────────────────────────
      // Without this, axios's default transformResponse tries JSON.parse on
      // every text response before falling back to the raw string. This can
      // interact badly with certain axios versions / interceptors and has
      // been observed to alter XML payloads. Force pass-through instead.
      transformResponse: isText ? [(data) => data] : undefined,
      headers:      ICC_PROXY_HEADERS,
      timeout:      30000,
      maxRedirects: 5,
      validateStatus: () => true, // never throw — we want to log+inspect ALL statuses
    });

    console.log(`[Proxy] Upstream status: ${upstream.status}`);
    console.log(`[Proxy] Upstream content-type: ${upstream.headers['content-type']}`);

    if (isText) {
      const body = upstream.data;
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      console.log(`[Proxy] Body length: ${bodyStr.length} chars`);
      console.log(`[Proxy] Body preview (first 300 chars):\n${bodyStr.slice(0, 300)}`);
      console.log(`[Proxy] Body preview (last 200 chars):\n${bodyStr.slice(-200)}`);

      if (upstream.status >= 400) {
        console.log(`[Proxy] ⚠️  Upstream returned ERROR status ${upstream.status} — this is why Shaka sees invalid XML!`);
        return res.status(upstream.status).send(bodyStr);
      }

      const looksLikeXml  = bodyStr.trim().startsWith('<?xml') || bodyStr.trim().startsWith('<MPD');
      const looksLikeM3u8 = bodyStr.trim().startsWith('#EXTM3U');
      if (isMpd && !looksLikeXml) {
        console.log(`[Proxy] ⚠️  Expected MPD XML but body doesn't start with <?xml or <MPD!`);
      }
      if (isM3u8 && !looksLikeM3u8) {
        console.log(`[Proxy] ⚠️  Expected M3U8 but body doesn't start with #EXTM3U!`);
      }

      res.setHeader('Content-Type', isMpd ? 'application/dash+xml' : 'application/x-mpegURL');
      res.setHeader('Cache-Control', 'no-store');
      console.log(`[Proxy] ✅ Sending ${bodyStr.length} chars back to client\n`);
      return res.send(bodyStr);
    }

    // ── Binary segment pass-through ───────────────────────────────────────
    if (upstream.status >= 400) {
      console.log(`[Proxy] ⚠️  Segment upstream error ${upstream.status}`);
      return res.status(upstream.status).end();
    }

    const ct = upstream.headers['content-type'];
    const cl = upstream.headers['content-length'];
    if (ct) res.setHeader('Content-Type', ct);
    if (cl) res.setHeader('Content-Length', cl);
    if (upstream.headers['accept-ranges']) {
      res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
    }

    upstream.data.pipe(res);
    upstream.data.on('error', err => {
      console.error('[Proxy] Pipe error:', err.message);
      if (!res.headersSent) res.status(500).end('Segment pipe failed');
    });

  } catch (err) {
    const status = err.response?.status || 500;
    console.error(`[Proxy] ❌ EXCEPTION ${status}: ${err.message}`);
    console.error(`[Proxy] URL was: ${targetUrl.slice(0, 150)}`);
    if (!res.headersSent) res.status(status).json({ error: err.message, url: targetUrl.slice(0, 150) });
  }
});

// =====================================
// 🎬 ICC VIDEO METADATA — add this to server.js
// Returns the full video JSON (sources[], title, etc.) from the ICC feed
// =====================================
app.get('/api/icc/video/:videoId', async (req, res) => {
  const { videoId } = req.params;
  // Basic UUID validation
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(videoId)) {
    return res.status(400).json({ success: false, error: 'Invalid videoId format' });
  }
  try {
    const r = await fetch(
      `https://feedpublisher-icc.akamaized.net/divauni/ICC/fe/video/videodata/v2/${videoId}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          'Referer':    'https://www.icc-cricket.com/',
          'Origin':     'https://www.icc-cricket.com',
          'Accept':     'application/json',
        },
      }
    );
    if (!r.ok) return res.status(r.status).json({ success: false, error: `ICC feed ${r.status}` });
    const data = await r.json();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------- Routes --------------------
app.use("/api/bms",    bmsRouter);
app.use('/api/auth',   authRouter);
app.use('/api/user',   userRouter);
app.use('/api/movies', movieRouter);
app.use('/api',        popadsRoute);
app.use('/api',        tmdbRouter);

async function fetchBCCI(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`BCCI status ${r.status}`);
    const text = await r.text();
    const jsonStr = text.replace(/^[a-zA-Z0-9_]+\s*\(/, '').replace(/\);?$/, '');
    return JSON.parse(jsonStr);
}

app.get('/api/bcci/match/:id/summary', async (req, res) => {
    try {
        const data = await fetchBCCI(`https://scores.bcci.tv/ipl/feeds/${req.params.id}-matchsummary.js`);
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bcci/match/:id/squad', async (req, res) => {
    try {
        const data = await fetchBCCI(`https://scores.bcci.tv/ipl/feeds/${req.params.id}-squads.js`);
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// -------------------- Stream URL (Signed) --------------------
app.get("/api/stream-url", (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.status(400).json({ success: false, error: "Neural link path is required" });
    const signedUrl = generateSignedUrl(path, 86400);
    res.json({ success: true, url: signedUrl });
  } catch (error) {
    console.error("Signing Engine Error:", error);
    res.status(500).json({ success: false, error: "Internal Secure Node Failure" });
  }
});

// -------------------- BMS route using Puppeteer --------------------
app.get("/api/bms", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ success: false, message: "No slug provided" });

  try {
    const { data, error } = await supabase
      .from("watch_html")
      .select("title")
      .eq("slug", slug)
      .single();

    if (error || !data) return res.status(404).json({ success: false, message: "Movie not found in DB" });

    const browser = await puppeteer.launch({ 
      headless: true, 
      executablePath: getChromiumPath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'] 
    });
    const page = await browser.newPage();
    await page.goto(`https://in.bookmyshow.com/bengaluru/movies?q=${encodeURIComponent(data.title)}`, { waitUntil: "networkidle2" });

    const movie = await page.evaluate(() => {
      const card = document.querySelector("a[data-testid='card']");
      if (!card) return null;
      return {
        title:       card.querySelector("[data-testid='movie-name']")?.innerText    || "N/A",
        language:    card.querySelector("[data-testid='movie-language']")?.innerText || "N/A",
        releaseDate: card.querySelector("[data-testid='release-date']")?.innerText  || "N/A",
        rating:      card.querySelector("[data-testid='rating']")?.innerText        || "N/A",
        poster:      card.querySelector("img")?.src || null,
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

// =====================================
// 🏏 IPL PROXY — scores.iplt20.com
// =====================================
const IPL_BASE = "https://scores.iplt20.com/ipl/feeds";
const IPL_LOGO_BASE = "https://scores.iplt20.com/ipl/teamlogos";
const IPL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Referer":    "https://www.iplt20.com/",
  "Origin":     "https://www.iplt20.com",
};

const FIRST_MATCH_ID = 2485;

const TEAM_CODE_MAP = {
  "Chennai Super Kings":          "CSK",
  "Mumbai Indians":               "MI",
  "Royal Challengers Bengaluru":  "RCB",
  "Royal Challengers Bangalore":  "RCB",
  "Kolkata Knight Riders":        "KKR",
  "Delhi Capitals":               "DC",
  "Punjab Kings":                 "PBKS",
  "Rajasthan Royals":             "RR",
  "Sunrisers Hyderabad":          "SRH",
  "Gujarat Titans":               "GT",
  "Lucknow Super Giants":         "LSG",
};

function toTeamCode(name = "") {
  return TEAM_CODE_MAP[name.trim()] || name.trim().toUpperCase().slice(0, 4);
}

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().split("T")[0];
}

function parseISTDateTime(dateStr = "", timeStr = "19:30") {
  try {
    const cleanDate = dateStr.replace(/^[A-Za-z]+,\s*/, "").trim();
    const d = new Date(`${cleanDate} ${timeStr} GMT+0530`);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function toISTTimeStr(d) {
  if (!d) return "";
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Kolkata",
  });
}

async function fetchIPL(filePath) {
  const url = `${IPL_BASE}/${filePath}`;
  const res = await fetch(url, { headers: IPL_HEADERS });
  if (!res.ok) throw new Error(`IPL API responded with ${res.status}`);
  let text = await res.text();
  text = text
    .trim()
    .replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, "")
    .replace(/\);?\s*$/, "")
    .replace(/^var\s+\w+\s*=\s*/, "")
    .replace(/;$/, "")
    .trim();
  return JSON.parse(text);
}

app.get("/api/match/:id/summary", async (req, res) => {
  try {
    const data = await fetchIPL(`${req.params.id}-matchsummary.js`);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(`❌ IPL summary error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/match/:id/innings/:num", async (req, res) => {
  try {
    const data = await fetchIPL(`${req.params.id}-Innings${req.params.num}.js`);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(`❌ IPL innings error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/match/:id", async (req, res) => {
  try {
    const summary = await fetchIPL(`${req.params.id}-matchsummary.js`);
    let ms = summary?.MatchSummary || {};
    if (Array.isArray(ms)) ms = ms[0] || {};
    const curInn = String(ms.CurrentInnings || "1");
    let innings = null;
    try { innings = await fetchIPL(`${req.params.id}-Innings${curInn}.js`); } catch (_) {}
    res.json({ ok: true, data: { summary, innings, currentInnings: curInn } });
  } catch (e) {
    console.error(`❌ IPL match error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 📅 IPL SCHEDULE
// =====================================
// IPL Season match-ID ranges (smMatchId in the scores feed)
// Confirmed by user: 2008 → 1000–1058, 2026 → 2417–2538
// For other years the S3 JSON feed (ipl-{year}-matches.json) is tried first.
const IPL_SEASON_CONFIG = {
  2008: { first: 1000,  last: 1058  },
  2009: { first: 1059,  last: 1122  },
  2010: { first: 1123,  last: 1186  },
  2011: { first: 1187,  last: 1250  },
  2012: { first: 1251,  last: 1320  },
  2013: { first: 1321,  last: 1390  },
  2014: { first: 1391,  last: 1455  },
  2015: { first: 1456,  last: 1515  },
  2016: { first: 1516,  last: 1590  },
  2017: { first: 1591,  last: 1655  },
  2018: { first: 1656,  last: 1720  },
  2019: { first: 1721,  last: 1790  },
  2020: { first: 1791,  last: 1856  },
  2021: { first: 1857,  last: 1930  },
  2022: { first: 1931,  last: 2020  },
  2023: { first: 2021,  last: 2110  },
  2024: { first: 2111,  last: 2220  },
  2025: { first: 2221,  last: 2416  },
  2026: { first: 2417,  last: 2538  },
};
const IPL_2026_FIRST_SM_MATCH_ID = IPL_SEASON_CONFIG[2026].first;
const IPL_2026_LAST_SM_MATCH_ID  = IPL_SEASON_CONFIG[2026].last;

app.get("/api/ipl/schedule", async (req, res) => {
  const targetDate = req.query.date || todayIST();
  try {
    const response = await fetch(IPL_SCHEDULE_URL, { headers: IPL_HEADERS });
    if (!response.ok) throw new Error(`Schedule feed: ${response.status}`);
    const raw = await response.json();
    const allMatches = raw?.Matchsummary || raw?.matches || [];
    if (!Array.isArray(allMatches) || allMatches.length === 0) throw new Error("Empty schedule feed");

    const now = new Date();
    const todayMatches = allMatches
      .filter((m) => {
        const d = parseISTDateTime(m.MatchDate || m.StartDate || "", m.MatchTime || m.StartTime || "19:30");
        if (!d) return false;
        const matchDateIST = new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().split("T")[0];
        return matchDateIST === targetDate;
      })
      .sort((a, b) => {
        const ta = parseISTDateTime(a.MatchDate || "", a.MatchTime || "");
        const tb = parseISTDateTime(b.MatchDate || "", b.MatchTime || "");
        return (ta?.getTime() || 0) - (tb?.getTime() || 0);
      })
      .map((m) => {
        const matchNum = parseInt(m.MatchNumber || m.MatchNo || m.MatchOrder || "1", 10);
        const matchId = FIRST_MATCH_ID + (matchNum - 1);
        const team1Code = toTeamCode(m.HomeTeam || m.Team1 || "");
        const team2Code = toTeamCode(m.AwayTeam || m.Team2 || "");
        const startTime = parseISTDateTime(m.MatchDate || m.StartDate || "", m.MatchTime || m.StartTime || "19:30");
        let status = "upcoming";
        const isDone = String(m.IsMatchComplete) === "1" || String(m.MatchStatus) === "2" || String(m.MatchStatus) === "complete";
        if (isDone) status = "completed";
        else if (startTime && now >= startTime) status = "live";
        return {
          matchId, matchNum,
          team1: team1Code, team2: team2Code,
          team1Logo: `${IPL_LOGO_BASE}/${team1Code}.png`,
          team2Logo: `${IPL_LOGO_BASE}/${team2Code}.png`,
          time:   startTime ? toISTTimeStr(startTime) : (m.MatchTime || "19:30"),
          venue:  m.VenueName || m.Venue || m.GroundName || "",
          status,
          score1: m.HomeScore  || m.Team1Score  || "",
          score2: m.AwayScore  || m.Team2Score  || "",
          result: m.MatchResult || m.WinningTeam || "",
        };
      });

    console.log(`📅 IPL Schedule for ${targetDate}: ${todayMatches.length} match(es)`);
    return res.json({ ok: true, data: todayMatches, date: targetDate });
  } catch (err) {
    console.error("❌ IPL Schedule error:", err.message);
    const seasonStart = new Date("2025-03-22T00:00:00+05:30");
    const target      = new Date(`${targetDate}T00:00:00+05:30`);
    const dayOffset   = Math.max(0, Math.floor((target - seasonStart) / 86400000));
    const fallbackId  = FIRST_MATCH_ID + dayOffset;
    return res.json({
      ok: true,
      data: [{ matchId: fallbackId, matchNum: dayOffset + 1, team1: "TBD", team2: "TBD", team1Logo: "", team2Logo: "", time: "19:30", venue: "", status: "upcoming", score1: "", score2: "", result: "" }],
      date: targetDate, fallback: true, error: err.message,
    });
  }
});

// =====================================
// 📅 IPL 2026 — ALL MATCHES
// Strategy: try MatchSchedule.js → Matchsummary.js →
//           parallel individual {id}-matchsummary.js (always works)
// =====================================

// Helper: parse a raw Matchsummary array into the shape the frontend needs
function _parseIplMatchRow(m) {
  const now = new Date();
  const smMatchId = m.MatchID;
  // RowNo and MatchRow both exist in some feeds
  const matchNum  = parseInt(m.RowNo || m.MatchRow || "0", 10);
  // Cast broadly — individual files use "Post", schedule uses "2", flags use "1"
  const isDone    = m.MatchStatus === "Post" ||
                    String(m.MatchStatus) === "2" ||
                    String(m.MatchStatus) === "3" ||
                    String(m.IsMatchComplete) === "1" ||
                    m.MatchStatus === "complete" ||
                    // If result/winner text is set the match is obviously over
                    !!(m.Comments || m.Commentss || m.WinningTeamID) ||
                    // CurrentInnings "2" and 2FallScore set means innings 2 is done
                    (String(m.CurrentInnings) === "2" && !!m["2FallScore"] && !!m["2FallWickets"]);
  const startTime = parseISTDateTime(
    m.MatchDateNew || m.MatchDate || "",
    m.MatchTime || "19:30"
  );
  const isLive = !isDone && !!startTime && now >= startTime;
  return {
    matchNum, smMatchId,
    team1:     toTeamCode(m.HomeTeamName || m.Team1 || ""),
    team2:     toTeamCode(m.AwayTeamName || m.Team2 || ""),
    team1Logo: m.MatchHomeTeamLogo || m.HomeTeamLogo || `${IPL_LOGO_BASE}/${toTeamCode(m.HomeTeamName||m.Team1||"?")}.png`,
    team2Logo: m.MatchAwayTeamLogo || m.AwayTeamLogo || `${IPL_LOGO_BASE}/${toTeamCode(m.AwayTeamName||m.Team2||"?")}.png`,
    matchDate: m.MatchDateNew || m.MatchDate || "",
    time:      startTime ? toISTTimeStr(startTime) : (m.MatchTime || "19:30"),
    venue:     m.GroundName || m.city || "",
    score1:    m["1FallScore"] ? `${m["1FallScore"]}/${m["1FallWickets"]} (${m["1FallOvers"]} ov)` : m.FirstBattingSummary || m["1Summary"] || "",
    score2:    m["2FallScore"] ? `${m["2FallScore"]}/${m["2FallWickets"]} (${m["2FallOvers"]} ov)` : m.SecondBattingSummary || m["2Summary"] || "",
    result:    m.Comments || m.Commentss || "",
    matchLabel: String(m.MatchOrder || ""),
    status:    isDone ? "completed" : isLive ? "live" : "upcoming",
  };
}



// ── Generic: /api/ipl/:year/all-matches ──────────────────────────────────────
if (!app._iplSeasonCache) app._iplSeasonCache = {};

app.get("/api/ipl/:year/all-matches", async (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (!IPL_SEASON_CONFIG[year]) {
    return res.status(404).json({ ok: false, error: `IPL ${year} not supported` });
  }
  const cacheKey = `ipl_season_${year}`;
  const cached   = app._iplSeasonCache[cacheKey];
  if (cached && Date.now() - cached.ts < 600000) return res.json(cached.data);

  const yearStr = String(year);

  // Helper: filter + verify a match belongs to this season
  const matchBelongsToYear = (m) => {
    if (!m || !m.MatchID) return false;
    const cn = (m.CompetitionName || "").toLowerCase();
    // Must mention the year, OR have no competition name (let it through)
    if (cn && !cn.includes(yearStr.slice(-2)) && !cn.includes(yearStr)) return false;
    return true;
  };

  // ── Strategy 1: S3 JSON feed (ipl-{year}-matches.json)
  const s3Url = `https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/ipl-${year}-matches.json`;
  try {
    const r = await fetch(s3Url, { headers: IPL_HEADERS, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const raw  = await r.json();
      const arr  = raw?.Matchsummary || raw?.MatchSummary || raw?.matches || [];
      if (Array.isArray(arr) && arr.length) {
        const matches = arr.map(_parseIplMatchRow).filter(m => m.matchNum > 0);
        const payload = { ok: true, matches, source: `s3:${year}` };
        app._iplSeasonCache[cacheKey] = { data: payload, ts: Date.now() };
        console.log(`✅ IPL ${year} (S3 JSON): ${matches.length} matches`);
        return res.json(payload);
      }
    }
  } catch (_) {}

  // ── Strategy 2: MatchSchedule.js / Matchsummary.js JSONP (current-season feeds)
  for (const file of ["MatchSchedule.js", "Matchsummary.js"]) {
    try {
      const raw = await fetchIPL(file);
      const arr = raw?.Matchsummary || raw?.MatchSummary || raw?.matchsummary || [];
      if (Array.isArray(arr) && arr.length) {
        const matches = arr
          .filter(m => matchBelongsToYear(m))
          .map(_parseIplMatchRow)
          .filter(m => m.matchNum > 0);
        if (matches.length) {
          const payload = { ok: true, matches, source: file };
          app._iplSeasonCache[cacheKey] = { data: payload, ts: Date.now() };
          console.log(`✅ IPL ${year} (${file}): ${matches.length} matches`);
          return res.json(payload);
        }
      }
    } catch (_) {}
  }

  // ── Strategy 3: Parallel individual match ID scan using known ranges
  const cfg = IPL_SEASON_CONFIG[year];
  console.log(`⚠️  IPL ${year}: falling back to individual scan (${cfg.first}–${cfg.last})`);
  try {
    const ids = Array.from({ length: cfg.last - cfg.first + 1 }, (_, i) => cfg.first + i);
    const results = await Promise.allSettled(ids.map(id => fetchIPL(`${id}-matchsummary.js`)));
    const matches = [];
    results.forEach(r => {
      if (r.status !== "fulfilled") return;
      const ms = r.value?.MatchSummary || r.value?.Matchsummary;
      const m  = Array.isArray(ms) ? ms[0] : ms;
      if (!m || !m.MatchID) return;
      // For confirmed ranges (2008, 2026) all IDs should be IPL; for others trust CompetitionName
      if (year !== 2008 && year !== 2026 && !matchBelongsToYear(m)) return;
      matches.push(_parseIplMatchRow(m));
    });
    matches.sort((a, b) => a.matchNum - b.matchNum);
    const payload = { ok: true, matches, source: "individual" };
    app._iplSeasonCache[cacheKey] = { data: payload, ts: Date.now() };
    console.log(`✅ IPL ${year} (individual): ${matches.length} matches`);
    return res.json(payload);
  } catch (err) {
    console.error(`❌ IPL ${year} error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================
// 🎬 IPL 2026 — MATCH HIGHLIGHT VIDEOS
// Real API: https://apiipl.iplt20.com/api/v1/pages/getcontentbymatchid
// Returns: thumbnail_image, mediaId, short_code, titleUrlSegment
// =====================================
const BC_ACCOUNT_ID    = "3588749423001";
const BC_POLICY_KEY    = "BCpkADawqM14f7bO4wGvT1k3zJ-8wN5rCj-C5K7Vz8PzZq";
const BC_PLAYBACK_BASE = `https://edge.api.brightcove.com/playback/v1/accounts/${BC_ACCOUNT_ID}`;
const IPL_API_BASE     = "https://apiipl.iplt20.com/api/v1/pages";

function smMatchIdToMatchNum(smMatchId) {
  return parseInt(smMatchId, 10) - IPL_2026_FIRST_SM_MATCH_ID + 1;
}

app.get("/api/ipl/highlight-videos", async (req, res) => {
  const smMatchId = req.query.smMatchId;
  if (!smMatchId) return res.status(400).json({ ok: false, error: "smMatchId required" });

  try {
    const url = `${IPL_API_BASE}/getcontentbymatchid?smMatchId=${smMatchId}&type=video`;
    const r = await fetch(url, {
      headers: {
        "User-Agent":  IPL_HEADERS["User-Agent"],
        "Referer":     "https://www.iplt20.com/",
        "Origin":      "https://www.iplt20.com",
        "Accept":      "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`apiipl responded ${r.status}`);
    const json = await r.json();
    const raw = json?.data || [];
    if (!Array.isArray(raw) || !raw.length) return res.json({ ok: true, videos: [] });

    const videos = raw.map(v => ({
      id:              String(v.id || v.ID || ""),
      title:           v.title || "Untitled",
      thumbnail:       v.thumbnail_image || v.imageBackup || v.imageUrl || null,
      duration:        v.duration || 0,
      views:           v.views_count || v.views || 0,
      mediaId:         String(v.mediaId || ""),          // Brightcove video ID → direct stream
      shortCode:       v.short_code || null,             // fallback ref: lookup
      titleUrlSegment: v.titleUrlSegment || null,
    }));

    return res.json({ ok: true, videos, source: "apiipl" });
  } catch (err) {
    console.error("❌ IPL highlight-videos:", err.message);
    return res.json({ ok: true, videos: [] });
  }
});

// =====================================
// ▶ IPL VIDEO STREAM — direct Brightcove lookup by mediaId
// Bypasses page scraping. Used by the IPL highlights row on click.
// GET /api/ipl/stream?mediaId=6396950799112&shortCode=kg8RgG9N
// =====================================
app.get("/api/ipl/stream", async (req, res) => {
  const { mediaId, shortCode } = req.query;
  if (!mediaId && !shortCode) return res.status(400).json({ ok: false, error: "mediaId or shortCode required" });

  // Try mediaId first (fastest — direct Brightcove lookup, no page fetch)
  if (mediaId) {
    try {
      const url = `${BC_PLAYBACK_BASE}/videos/${mediaId}`;
      const r = await fetch(url, {
        headers: { "Accept": `application/json;pk=${BC_POLICY_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const data = await r.json();
        const sources = data.sources || [];
        // Prefer master.m3u8, fall back to first rendition.m3u8
        const master = sources.find(s => s.src?.includes("master.m3u8") && !s.src?.includes("rendition"));
        const rend   = sources.find(s => s.src?.includes("rendition.m3u8"));
        const m3u8   = master?.src || rend?.src || null;
        if (m3u8) return res.json({ ok: true, url: m3u8, source: "bc:mediaId" });
      }
    } catch (_) {}
  }

  // Fall back to ref:{shortCode}
  if (shortCode) {
    try {
      const url = `${BC_PLAYBACK_BASE}/videos/ref:${shortCode}`;
      const r = await fetch(url, {
        headers: { "Accept": `application/json;pk=${BC_POLICY_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const data = await r.json();
        const sources = data.sources || [];
        const master = sources.find(s => s.src?.includes("master.m3u8") && !s.src?.includes("rendition"));
        const rend   = sources.find(s => s.src?.includes("rendition.m3u8"));
        const m3u8   = master?.src || rend?.src || null;
        if (m3u8) return res.json({ ok: true, url: m3u8, source: "bc:shortCode" });
      }
    } catch (_) {}
  }

  return res.status(502).json({ ok: false, error: "Stream not found" });
});

// =====================================
// 📊 IPL POINTS TABLE
// =====================================
const POINTS_TABLE_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/stats/284-groupstandings.js";

app.get("/api/ipl/points-table", async (req, res) => {
  try {
    const response = await fetch(POINTS_TABLE_URL, { headers: IPL_HEADERS });
    if (!response.ok) throw new Error(`Points table feed responded with ${response.status}`);
    let text = await response.text();
    const cleanedJson = text.trim().replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, "").replace(/\);?\s*$/, "").replace(/^var\s+\w+\s*=\s*/, "").trim();
    const data = JSON.parse(cleanedJson);
    res.json({ ok: true, data: data.points || [] });
  } catch (e) {
    console.error(`❌ IPL Points Table Error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 📊 IPL TOP RUN SCORERS
// =====================================
const TOP_RUNS_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/stats/284-toprunsscorers.js";

app.get("/api/ipl/top-run-scorers", async (req, res) => {
  try {
    const response = await fetch(`${TOP_RUNS_URL}?callback=ontoprunsscorers&_=${Date.now()}`, { headers: IPL_HEADERS });
    if (!response.ok) throw new Error(`Top run scorers feed responded with ${response.status}`);
    let text = await response.text();
    const cleanedJson = text.trim().replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, "").replace(/\);?\s*$/, "").replace(/^var\s+\w+\s*=\s*/, "").trim();
    const data = JSON.parse(cleanedJson);
    const scorers = (data.toprunsscorers || []).slice(0, 10).map((p) => ({
      name: p.StrikerName || "", team: p.TeamCode || "", matches: p.Matches || 0,
      innings: p.Innings || 0, runs: p.TotalRuns || 0, balls: p.Balls || 0,
      fours: p.Fours || 0, sixes: p.Sixes || 0, strikeRate: p.StrikeRate || "0",
      average: p.BattingAverage || "0", highScore: p.HighestScore || "0",
      fifties: p.FiftyPlusRuns || 0, hundreds: p.Centuries || 0,
    }));
    res.json({ ok: true, data: scorers });
  } catch (e) {
    console.error("❌ IPL Top Run Scorers Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 📊 IPL MOST WICKETS
// =====================================
const MOST_WICKETS_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/stats/284-mostwickets.js";

app.get("/api/ipl/most-wickets", async (req, res) => {
  try {
    const response = await fetch(`${MOST_WICKETS_URL}?callback=onmostwickets&_=${Date.now()}`, { headers: IPL_HEADERS });
    if (!response.ok) throw new Error(`Most wickets feed responded with ${response.status}`);
    let text = await response.text();
    const cleanedJson = text.trim().replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, "").replace(/\);?\s*$/, "").replace(/^var\s+\w+\s*=\s*/, "").trim();
    const data = JSON.parse(cleanedJson);
    const bowlers = (data.mostwickets || []).slice(0, 10).map((p) => ({
      name: p.BowlerName || "", team: p.TeamCode || "", matches: p.Matches || 0,
      innings: p.Innings || 0, wickets: p.Wickets || 0, overs: p.OversBowled || 0,
      runs: p.TotalRunsConceded || 0, economy: p.EconomyRate || "0",
      average: p.BowlingAverage || "0", strikeRate: p.BowlingSR || "0",
      bestInnings: p.BBIW || "-", fiveWickets: p.FiveWickets || 0,
    }));
    res.json({ ok: true, data: bowlers });
  } catch (e) {
    console.error("❌ IPL Most Wickets Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 🏏 FULL MATCH CENTER
// =====================================
app.get("/api/match/:id/full", async (req, res) => {
  try {
    const matchId = req.params.id;
    const summaryData = await fetchIPL(`${matchId}-matchsummary.js`);
    let ms = summaryData?.MatchSummary || {};
    if (Array.isArray(ms)) ms = ms[0] || {};
    const curInnNum = String(ms.CurrentInnings || "1");
    const inningsData = await fetchIPL(`${matchId}-Innings${curInnNum}.js`);
    const inn = inningsData?.[`Innings${curInnNum}`] || {};

    const battingCard = (inn.BattingCard || []).map(player => ({
      name: player.PlayerName.trim(), outDesc: player.OutDesc,
      runs: player.Runs, balls: player.Balls, fours: player.Fours,
      sixes: player.Sixes, sr: player.StrikeRate, isBatting: player.OutDesc === "not out"
    }));
    const bowlingCard = (inn.BowlingCard || []).map(bowler => ({
      name: bowler.PlayerName, overs: bowler.Overs, maidens: bowler.Maidens,
      runs: bowler.Runs, wickets: bowler.Wickets, economy: bowler.Economy
    }));
    const ballByBall = (inn.OverHistory || []).slice(0, 12).map(ball => ({
      over: ball.BallName, striker: ball.BatsManName, bowler: ball.BowlerName,
      runs: ball.Runs, event: ball.NewCommentry,
      isWicket: ball.IsWicket === "1", isBoundary: ball.IsFour === "1" || ball.IsSix === "1"
    }));

    res.json({
      ok: true, matchName: ms.MatchName,
      status: ms.IsMatchEnd === 1 ? "Completed" : "Live",
      score: ms[`${curInnNum}Summary`],
      data: { batting: battingCard, bowling: bowlingCard, commentary: ballByBall, recentBalls: inn.BallsInCurrentOver || [] }
    });
  } catch (e) {
    console.error(`❌ IPL Full Match Center error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 🏏 WT20 PROXY ROUTES
// =====================================
const WT20_CLIENT_ID = "tPZJbRgIub3Vua93/DWtyQ==";
const WT20_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Referer":         "https://www.icc-cricket.com/",
  "Origin":          "https://www.icc-cricket.com",
  "Accept-Language": "en-US,en;q=0.9",
};

app.get("/api/wt20/scorecard", async (req, res) => {
  const { game_id } = req.query;
  if (!game_id) return res.status(400).json({ ok: false, error: "game_id is required" });
  try {
    const params = new URLSearchParams({ client_id: WT20_CLIENT_ID, feed_format: "json", game_id, lang: "en" });
    const url = `https://assets-icc.sportz.io/cricket/v1/game/scorecard?${params}`;
    const response = await fetch(url, { headers: WT20_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/wt20/schedule", async (req, res) => {
  const { series_ids = "12672", game_count = "10", is_live = "true", is_recent = "true", is_upcoming = "true" } = req.query;
  try {
    const params = new URLSearchParams({ client_id: WT20_CLIENT_ID, feed_format: "json", game_count, is_deleted: "false", is_live, is_recent, is_upcoming, lang: "en", league_ids: "1,9,10,35", pagination: "false", series_ids, timezone: "0530" });
    const url = `https://assets-icc.sportz.io/cricket/v1/schedule?${params}`;
    const response = await fetch(url, { headers: WT20_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/wt20/commentary", async (req, res) => {
  const { game_id, inning = "1", page_number = "1", page_size = "20" } = req.query;
  if (!game_id) return res.status(400).json({ ok: false, error: "game_id is required" });
  try {
    const params = new URLSearchParams({ client_id: WT20_CLIENT_ID, feed_format: "json", game_id, inning, key_event: "true", lang: "en", page_number, page_size });
    const url = `https://assets-icc.sportz.io/cricket/v1/game/commentary?${params}`;
    const response = await fetch(url, { headers: WT20_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 🇮🇳 BCCI PROXY ROUTES
// =====================================
const BCCI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept":     "application/json, text/plain, */*",
  "Referer":    "https://www.bcci.tv/",
  "Origin":     "https://www.bcci.tv",
};

app.get("/api/bcci/live", async (req, res) => {
  try {
    const url = "https://scores2.bcci.tv/getLiveMatches?platform=international&previousMatchesCount=0&filterType=All&filters%5Bformat%5D%5B%5D=AllFormat&loadMore=false";
    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/bcci/upcoming", async (req, res) => {
  try {
    const url = "https://scores2.bcci.tv/getUpcomingMatches?platform=international&previousMatchesCount=0&filterType=All&filters%5Bformat%5D%5B%5D=AllFormat&loadMore=false";
    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/bcci/recent", async (req, res) => {
  try {
    const count = parseInt(req.query.count) || 15;
    const url = `https://scores2.bcci.tv/getRecentMatches?platform=international&previousMatchesCount=${count}&filterType=All&filters%5Bformat%5D%5B%5D=AllFormat&loadMore=false`;
    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/bcci/match", async (req, res) => {
  const { competitionID, matchID, matchOrder, seriesName } = req.query;
  if (!competitionID || !matchID) return res.status(400).json({ ok: false, error: "competitionID and matchID are required" });
  try {
    const params = new URLSearchParams({ competitionID, matchID, SERIES_ID: competitionID, widgetType: "international", ...(matchOrder && { matchOrder }), ...(seriesName && { seriesName }) });
    const url = `https://scores2.bcci.tv/getMatchCenterDetails?${params}`;
    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── BCCI SQUAD ───────────────────────────────────────────────────────────────
// Fetches the JSONP squad feed from scores.bcci.tv, strips the callback wrapper,
// and returns plain JSON.  URL: /api/bcci/squad?matchID=2112
app.get("/api/bcci/squad", async (req, res) => {
  const { matchID } = req.query;
  if (!matchID) return res.status(400).json({ ok: false, error: "matchID required" });
  try {
    const url = `https://scores.bcci.tv/feeds-international/scoringfeeds/squads/${matchID}-squad.js?callback=onsquadFixture&_=${Date.now()}`;
    const response = await fetch(url, {
      headers: { ...BCCI_HEADERS, "Referer": "https://scores.bcci.tv/", "Origin": "https://scores.bcci.tv" },
    });
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    const text = await response.text();
    const m = text.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\((.+)\)\s*;?\s*$/s);
    if (!m) return res.status(502).json({ ok: false, error: "Unexpected JSONP format", raw: text.slice(0, 200) });
    res.json(JSON.parse(m[1]));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── BCCI MATCH SUMMARY ───────────────────────────────────────────────────────
// Fetches match-summary JSONP from scores.bcci.tv, strips callback, returns JSON.
// URL: /api/bcci/matchsummary?matchID=2415
app.get("/api/bcci/matchsummary", async (req, res) => {
  const { matchID } = req.query;
  if (!matchID) return res.status(400).json({ ok: false, error: "matchID required" });
  try {
    const url = `https://scores.bcci.tv/feeds-international/scoringfeeds/${matchID}-matchsummary.js?_=${Date.now()}`;
    const response = await fetch(url, {
      headers: { ...BCCI_HEADERS, "Referer": "https://scores.bcci.tv/", "Origin": "https://scores.bcci.tv" },
    });
    if (!response.ok) return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    const text = await response.text();
    const cbMatch = text.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\((.+)\)\s*;?\s*$/s);
    res.json(cbMatch ? JSON.parse(cbMatch[1]) : JSON.parse(text));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 🖼️ IMAGE SEARCH (Tavily + Gemini)
// =====================================
const STATIC_EMERGENCY_FALLBACKS = {
  cricket:  ["https://images.unsplash.com/photo-1531415074968-036ba1b575da?q=80&w=1200&auto=format&fit=crop"],
  football: ["https://images.unsplash.com/photo-1508098682722-e99c43a406b2?q=80&w=1200&auto=format&fit=crop"],
};

function detectSport(query) {
  const q = query.toLowerCase();
  return (q.includes("football") || q.includes("fifa") || q.includes("soccer")) ? "football" : "cricket";
}

async function optimizeQueryWithGemini(rawQuery) {
  if (!process.env.GEMINI_API_KEY) return rawQuery;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Convert this raw sports match query into a precise, search-optimized phrase (max 10 words). Expand team abbreviations to full country/team names. Include tournament name and year. Output ONLY the search phrase, nothing else.\n\nRaw query: "${rawQuery}"` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 30 }
        }),
      }
    );
    const json = await res.json();
    const optimized = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return optimized?.length > 5 ? optimized : rawQuery;
  } catch (e) {
    return rawQuery;
  }
}

async function searchViaTavily(query, count = 5) {
  if (!TAVILY_API_KEY) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TAVILY_API_KEY}` },
      body: JSON.stringify({ query, search_depth: "basic", include_images: true, include_image_descriptions: false, max_results: count, topic: "news" }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.images || []).filter(url => url?.startsWith("http") && !url.endsWith(".svg") && !url.endsWith(".gif") && !url.includes("logo") && !url.includes("icon") && !url.includes("pixel"));
  } catch (e) {
    return [];
  }
}

app.get('/api/search-image', async (req, res) => {
  try {
    const rawQuery = req.query.q;
    if (!rawQuery) return res.status(400).json({ error: "Missing query" });
    const decoded   = decodeURIComponent(rawQuery).trim();
    const sportType = detectSport(decoded);
    const optimizedQuery = await optimizeQueryWithGemini(decoded);
    const images = await searchViaTavily(optimizedQuery);
    if (images.length === 0) return res.json({ images: STATIC_EMERGENCY_FALLBACKS[sportType] });
    return res.json({ images });
  } catch (err) {
    return res.json({ images: ["https://images.unsplash.com/photo-1508098682722-e99c43a406b2?q=80&w=1200&auto=format&fit=crop"] });
  }
});

// =====================================
// ✅ ICC ENTITLEMENT API
// =====================================
app.post("/api/icc/play", async (req, res) => {
  try {
    const {
      VideoId,
      VideoSource,
      VideoKind = "vod",
      VideoSourceFormat = "DASH",
      VideoSourceName = "Desktop-DASH",
    } = req.body;

    if (!VideoId || !VideoSource) {
      return res.status(400).json({ success: false, error: "VideoId and VideoSource are required" });
    }

    const sessionId         = crypto.randomUUID();
    const playbackSessionId = crypto.randomUUID().toUpperCase();

    console.log('[ICC] Requesting entitlement — VideoId:', VideoId);
    console.log('[ICC] SessionId:', sessionId);

    const payload = {
      Type: 1,
      VideoId,
      VideoSource: VideoSource.split('?')[0],  // always strip any old token
      VideoKind,
      AssetState: "3",
      PlayerType: "HTML5",
      VideoSourceFormat,
      VideoSourceName,
      DRMType: "",
      AuthType: "Open",
      ContentKeyData: "",
      SessionId: sessionId,
      PlaybackSessionId: playbackSessionId,
      Other: `${sessionId}|HTML5`,
      VideoOfferType: "Free",
      User: ""
    };

    console.log('[ICC] Full payload:', JSON.stringify(payload));

    const response = await axios.post(
      "https://prd-api.icc-volt.com/api/entitlement/api/v2/icc/videos",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "Origin":  "https://www.icc-cricket.com",
          "Referer": "https://www.icc-cricket.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        timeout: 15000,
      }
    );

    const data = response.data;
    console.log('[ICC] ResponseCode:', data.ResponseCode, '| Message:', data.Message);

    if (data.ResponseCode !== 1 || !data.ContentUrl) {
      return res.status(502).json({
        success: false,
        error: data.Message || "Entitlement failed",
        responseCode: data.ResponseCode,
        raw: data
      });
    }

    console.log('[ICC] ✅ ContentUrl obtained');
    res.json({ success: true, ContentUrl: data.ContentUrl, raw: data });

  } catch (err) {
    console.error('[ICC] Error status:', err.response?.status);
    console.error('[ICC] Error body:', JSON.stringify(err.response?.data));
    console.error('[ICC] Error message:', err.message);
    res.status(502).json({
      success: false,
      error: err.message,
      status: err.response?.status,
      detail: err.response?.data,
    });
  }
});

app.use(express.static("public"));

app.get("/api/bcci/highlight", async (req, res) => {
  const { smMatchId } = req.query;
  const r = await fetch(`https://api.bcci.tv/api/v1/pages/getcontentbymatchid?smMatchId=${smMatchId}&type=video&tournament_type=international`);
  const json = await r.json();
  res.json(json);
});


// =====================================
// 📡 DYNAMIC M3U8 STREAM EXTRACTOR
// Runs the stealth Playwright scraper behind the scenes 
// without spawning desktop frames on Render.
// =====================================
app.get('/api/get-stream', (req, res) => {
    let targetUrl = req.query.url || '';
    try { targetUrl = decodeURIComponent(targetUrl).trim(); } catch {}

    if (!targetUrl) {
        return res.status(400).json({ success: false, error: 'Missing ?url= parameter' });
    }

    console.log(`📡 Stream extraction requested for: ${targetUrl}`);

    // Adjusting target to look into your scrapers folder ('./scrapers/index.py')
    const pythonProcess = spawn('python3', ['./scrapers/index.py', targetUrl]);

    let output = '';
    let errorOutput = '';

    pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });

    pythonProcess.on('close', (code) => {
        const cleanOutput = output.trim();

        if (code !== 0 || !cleanOutput || cleanOutput.toLowerCase().includes('error')) {
            console.error(`❌ Scraper script failed with exit code ${code}`);
            if (errorOutput) console.error(`🐍 Python stderr layout:\n${errorOutput}`);
            return res.status(502).json({ 
                success: false, 
                error: 'Could not extract dynamic streaming manifest link behind compliance walls.',
                details: errorOutput || cleanOutput 
            });
        }

        // Return the clean live .m3u8 link directly back to your React frontend context
        console.log(`✅ Successfully extracted fresh token manifest: ${cleanOutput}`);
        return res.json({ success: true, url: cleanOutput });
    });
});

// -------------------- Test route --------------------
app.get('/', (req, res) => res.send('✅ API is live'));

// -------------------- Start server --------------------
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🎬 FilmiBeat RSS proxy → http://localhost:${port}/api/rss?feed=all`);
});
