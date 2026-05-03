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
import up4streamRoutes from "./routes/up4streamRoutes.js";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";

import bunnyRoutes from "./routes/bunnyRoutes.js";
import bmsRouter from "./routes/bms.js";
import tmdbRouter from './routes/tmdbRoutes.js';
import geminiRoutes from './routes/geminiRoutes.js';
import autofillRouter from './routes/autofill.js';

import { generateSignedUrl } from "./utils/signUrl.js";

import { execSync } from 'child_process';
import fetch from 'node-fetch';

const getChromiumPath = () => {
    try {
        return execSync('find /app/pw-browsers -name chrome -type f | head -n 1').toString().trim();
    } catch (e) {
        return null;
    }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  'https://auth-2407.netlify.app',
  'https://movies1-frontend.vercel.app',
  'https://1anchormovies.vercel.app',
  'https://www.1anchormovies.live',
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log('Incoming Request Origin:', origin);
    if (!origin) return callback(null, true);
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
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
        return next();
    }

    if (allowedOrigins.includes(origin)) {
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
// 🚀 HLS LIVE STREAM PROXY
// =====================================
app.get('/api/live-stream-proxy', async (req, res) => {
    const streamUrl = req.query.url;

    if (!streamUrl) {
        return res.status(400).send('❌ Missing stream URL query parameter.');
    }

    console.log(`Proxying HLS stream: ${streamUrl}`);

    try {
        const response = await axios({
            method: 'GET',
            url: streamUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': req.headers['user-agent'] || 'HLS-Proxy-Server',
                'Referer': req.headers['referer'] || 'http://localhost',
                'Range': req.headers['range'] || undefined,
            },
            timeout: 30000,
        });

        if (response.headers['content-type'])   res.setHeader('Content-Type',   response.headers['content-type']);
        if (response.headers['content-length'])  res.setHeader('Content-Length', response.headers['content-length']);
        if (response.headers['accept-ranges'])   res.setHeader('Accept-Ranges',  response.headers['accept-ranges']);
        if (response.headers['content-range'])   res.setHeader('Content-Range',  response.headers['content-range']);

        res.setHeader('Access-Control-Allow-Origin', '*');
        response.data.pipe(res);

        response.data.on('error', (err) => {
            console.error('❌ Proxy stream error:', err.message);
            if (!res.headersSent) res.status(500).end('Proxy streaming failed.');
        });

    } catch (error) {
        const status = error.response ? error.response.status : 500;
        console.error(`❌ Proxy failed for ${streamUrl}:`, error.message);
        if (!res.headersSent) res.status(status).send(`Proxy failed: ${error.message}`);
    }
});

// -------------------- Routes --------------------
app.use("/api/bms",       bmsRouter);
app.use('/api/auth',      authRouter);
app.use('/api/user',      userRouter);
app.use('/api/movies',    movieRouter);
app.use('/api',           popadsRoute);
app.use("/api/up4stream", up4streamRoutes);
app.use('/api',           tmdbRouter);

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

// ── First match ID of the season (today onwards starts from 2485) ──
const FIRST_MATCH_ID = 2485;

// ── Team name → short code map ─────────────────────────────────────
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

// ── Today's date string in IST "YYYY-MM-DD" ─────────────────────────
function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().split("T")[0];
}

// ── Parse IST date+time string → Date object ────────────────────────
// MatchDate from IPL feed looks like "Saturday, 22 Mar 2025"
// MatchTime looks like "19:30"
function parseISTDateTime(dateStr = "", timeStr = "19:30") {
  try {
    // Strip day-of-week prefix if present: "Saturday, 22 Mar 2025" → "22 Mar 2025"
    const cleanDate = dateStr.replace(/^[A-Za-z]+,\s*/, "").trim();
    const d = new Date(`${cleanDate} ${timeStr} GMT+0530`);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ── Format Date → "HH:MM" in IST ────────────────────────────────────
function toISTTimeStr(d) {
  if (!d) return "";
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Kolkata",
  });
}

// ── Helper: fetch from IPL CDN and strip JSONP wrapper ──────────────
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

// ── GET /api/match/:id/summary ───────────────────────────────────────
app.get("/api/match/:id/summary", async (req, res) => {
  try {
    const data = await fetchIPL(`${req.params.id}-matchsummary.js`);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(`❌ IPL summary error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/match/:id/innings/:num ─────────────────────────────────
app.get("/api/match/:id/innings/:num", async (req, res) => {
  try {
    const data = await fetchIPL(`${req.params.id}-Innings${req.params.num}.js`);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(`❌ IPL innings error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/match/:id — summary + current innings combined ─────────
app.get("/api/match/:id", async (req, res) => {
  try {
    const summary = await fetchIPL(`${req.params.id}-matchsummary.js`);

    let ms = summary?.MatchSummary || {};
    if (Array.isArray(ms)) ms = ms[0] || {};
    const curInn = String(ms.CurrentInnings || "1");

    let innings = null;
    try {
      innings = await fetchIPL(`${req.params.id}-Innings${curInn}.js`);
    } catch (_) {
      // innings may not exist yet (pre-match) — fine
    }

    res.json({ ok: true, data: { summary, innings, currentInnings: curInn } });
  } catch (e) {
    console.error(`❌ IPL match error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 📅 IPL SCHEDULE — GET /api/ipl/schedule
// =====================================
// Returns today's matches (or any date via ?date=YYYY-MM-DD)
// Fetches from the official IPL schedule feed on S3.
// Supports double headers automatically.
//
// Response shape:
// {
//   ok: true,
//   date: "2025-04-15",
//   data: [
//     {
//       matchId: 2485,       ← auto-computed from MatchNumber
//       matchNum: 1,         ← position in season
//       team1: "CSK",        ← home team short code
//       team2: "MI",         ← away team short code
//       team1Logo: "https://scores.iplt20.com/ipl/teamlogos/CSK.png",
//       team2Logo: "https://scores.iplt20.com/ipl/teamlogos/MI.png",
//       time: "19:30",       ← IST start time
//       venue: "Wankhede",
//       status: "live" | "upcoming" | "completed",
//       score1: "",          ← populated when match is live/done
//       score2: "",
//       result: "",          ← e.g. "CSK won by 5 wkts"
//     },
//     // second entry if double header
//   ]
// }

const IPL_SCHEDULE_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/ipl-2025-matches.json";

app.get("/api/ipl/schedule", async (req, res) => {
  const targetDate = req.query.date || todayIST(); // e.g. "2025-04-15"

  try {
    const response = await fetch(IPL_SCHEDULE_URL, { headers: IPL_HEADERS });
    if (!response.ok) throw new Error(`Schedule feed: ${response.status}`);

    const raw = await response.json();

    // The feed uses "Matchsummary" (capital M, lowercase s)
    const allMatches = raw?.Matchsummary || raw?.matches || [];

    if (!Array.isArray(allMatches) || allMatches.length === 0) {
      throw new Error("Empty schedule feed");
    }

    const now = new Date();

    const todayMatches = allMatches
      .filter((m) => {
        // MatchDate: "Saturday, 22 Mar 2025", MatchTime: "19:30"
        const d = parseISTDateTime(
          m.MatchDate || m.StartDate || "",
          m.MatchTime || m.StartTime || "19:30"
        );
        if (!d) return false;
        // Convert match start to IST date string for comparison
        const matchDateIST = new Date(d.getTime() + 5.5 * 3600 * 1000)
          .toISOString()
          .split("T")[0];
        return matchDateIST === targetDate;
      })
      .sort((a, b) => {
        // Sort by start time ascending (handles double headers)
        const ta = parseISTDateTime(a.MatchDate || "", a.MatchTime || "");
        const tb = parseISTDateTime(b.MatchDate || "", b.MatchTime || "");
        return (ta?.getTime() || 0) - (tb?.getTime() || 0);
      })
      .map((m) => {
        // MatchNumber is 1-indexed position in the full season
        const matchNum = parseInt(m.MatchNumber || m.MatchNo || m.MatchOrder || "1", 10);
        // matchId = FIRST_MATCH_ID + (matchNum - 1)
        // e.g. match #1 of season → 2485, match #2 → 2486, etc.
        const matchId = FIRST_MATCH_ID + (matchNum - 1);

        const team1Code = toTeamCode(m.HomeTeam || m.Team1 || "");
        const team2Code = toTeamCode(m.AwayTeam || m.Team2 || "");
        const startTime = parseISTDateTime(
          m.MatchDate || m.StartDate || "",
          m.MatchTime || m.StartTime || "19:30"
        );

        // Determine status
        // IsMatchComplete: "1" = done, "0" = not done
        // MatchStatus: some feeds use "2" for complete
        let status = "upcoming";
        const isDone =
          String(m.IsMatchComplete) === "1" ||
          String(m.MatchStatus) === "2" ||
          String(m.MatchStatus) === "complete";

        if (isDone) {
          status = "completed";
        } else if (startTime && now >= startTime) {
          // Start time has passed and not marked complete → treat as live
          status = "live";
        }

        return {
          matchId,
          matchNum,
          team1:     team1Code,
          team2:     team2Code,
          team1Logo: `${IPL_LOGO_BASE}/${team1Code}.png`,
          team2Logo: `${IPL_LOGO_BASE}/${team2Code}.png`,
          time:      startTime ? toISTTimeStr(startTime) : (m.MatchTime || "19:30"),
          venue:     m.VenueName || m.Venue || m.GroundName || "",
          status,
          score1:    m.HomeScore  || m.Team1Score  || "",
          score2:    m.AwayScore  || m.Team2Score  || "",
          result:    m.MatchResult || m.WinningTeam || "",
        };
      });

    console.log(`📅 IPL Schedule for ${targetDate}: ${todayMatches.length} match(es)`);
    return res.json({ ok: true, data: todayMatches, date: targetDate });

  } catch (err) {
    console.error("❌ IPL Schedule error:", err.message);

    // ── Fallback: compute match ID from season-start date offset ──────
    // Season start: 22 Mar 2025 = match #1 (ID 2484 was pre-season)
    const seasonStart  = new Date("2025-03-22T00:00:00+05:30");
    const target       = new Date(`${targetDate}T00:00:00+05:30`);
    const dayOffset    = Math.max(0, Math.floor((target - seasonStart) / 86400000));
    const fallbackId   = FIRST_MATCH_ID + dayOffset;

    console.log(`⚠️  Schedule fallback → matchId ${fallbackId} for ${targetDate}`);

    return res.json({
      ok: true,
      data: [{
        matchId:   fallbackId,
        matchNum:  dayOffset + 1,
        team1:     "TBD",
        team2:     "TBD",
        team1Logo: "",
        team2Logo: "",
        time:      "19:30",
        venue:     "",
        status:    "upcoming",
        score1:    "",
        score2:    "",
        result:    "",
      }],
      date:     targetDate,
      fallback: true,
      error:    err.message,
    });
  }
});

// =====================================
// 📊 IPL POINTS TABLE PROXY
// =====================================
const POINTS_TABLE_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/stats/284-groupstandings.js";

app.get("/api/ipl/points-table", async (req, res) => {
  try {
    const response = await fetch(POINTS_TABLE_URL, { headers: IPL_HEADERS });
    if (!response.ok) throw new Error(`Points table feed responded with ${response.status}`);

    let text = await response.text();
    const cleanedJson = text
      .trim()
      .replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, "")
      .replace(/\);?\s*$/, "")
      .replace(/^var\s+\w+\s*=\s*/, "")
      .trim();

    const data = JSON.parse(cleanedJson);
    res.json({ ok: true, data: data.points || [] });
  } catch (e) {
    console.error(`❌ IPL Points Table Error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- Test route --------------------
app.get('/', (req, res) => res.send('✅ API is live'));

// -------------------- Start server --------------------
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
