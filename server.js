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
import { tavily } from "@tavily/core";
import { GoogleGenAI, Type } from "@google/genai";

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
    try {
      innings = await fetchIPL(`${req.params.id}-Innings${curInn}.js`);
    } catch (_) {}

    res.json({ ok: true, data: { summary, innings, currentInnings: curInn } });
  } catch (e) {
    console.error(`❌ IPL match error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 📅 IPL SCHEDULE
// =====================================
const IPL_SCHEDULE_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/ipl-2025-matches.json";

app.get("/api/ipl/schedule", async (req, res) => {
  const targetDate = req.query.date || todayIST();

  try {
    const response = await fetch(IPL_SCHEDULE_URL, { headers: IPL_HEADERS });
    if (!response.ok) throw new Error(`Schedule feed: ${response.status}`);

    const raw = await response.json();
    const allMatches = raw?.Matchsummary || raw?.matches || [];

    if (!Array.isArray(allMatches) || allMatches.length === 0) {
      throw new Error("Empty schedule feed");
    }

    const now = new Date();

    const todayMatches = allMatches
      .filter((m) => {
        const d = parseISTDateTime(
          m.MatchDate || m.StartDate || "",
          m.MatchTime || m.StartTime || "19:30"
        );
        if (!d) return false;
        const matchDateIST = new Date(d.getTime() + 5.5 * 3600 * 1000)
          .toISOString()
          .split("T")[0];
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
        const startTime = parseISTDateTime(
          m.MatchDate || m.StartDate || "",
          m.MatchTime || m.StartTime || "19:30"
        );

        let status = "upcoming";
        const isDone =
          String(m.IsMatchComplete) === "1" ||
          String(m.MatchStatus) === "2" ||
          String(m.MatchStatus) === "complete";

        if (isDone) {
          status = "completed";
        } else if (startTime && now >= startTime) {
          status = "live";
        }

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
      data: [{
        matchId: fallbackId, matchNum: dayOffset + 1,
        team1: "TBD", team2: "TBD",
        team1Logo: "", team2Logo: "",
        time: "19:30", venue: "", status: "upcoming",
        score1: "", score2: "", result: "",
      }],
      date: targetDate, fallback: true, error: err.message,
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

// =====================================
// 📊 IPL TOP RUN SCORERS PROXY
// =====================================
const TOP_RUNS_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/stats/284-toprunsscorers.js";

app.get("/api/ipl/top-run-scorers", async (req, res) => {
  try {
    const response = await fetch(`${TOP_RUNS_URL}?callback=ontoprunsscorers&_=${Date.now()}`, {
      headers: IPL_HEADERS,
    });
    if (!response.ok) throw new Error(`Top run scorers feed responded with ${response.status}`);

    let text = await response.text();
    const cleanedJson = text
      .trim()
      .replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, "")
      .replace(/\);?\s*$/, "")
      .replace(/^var\s+\w+\s*=\s*/, "")
      .trim();

    const data = JSON.parse(cleanedJson);
    const scorers = (data.toprunsscorers || []).slice(0, 10).map((p) => ({
      name:       p.StrikerName    || "",
      team:       p.TeamCode       || "",
      matches:    p.Matches        || 0,
      innings:    p.Innings        || 0,
      runs:       p.TotalRuns      || 0,
      balls:      p.Balls          || 0,
      fours:      p.Fours          || 0,
      sixes:      p.Sixes          || 0,
      strikeRate: p.StrikeRate     || "0",
      average:    p.BattingAverage || "0",
      highScore:  p.HighestScore   || "0",
      fifties:    p.FiftyPlusRuns  || 0,
      hundreds:   p.Centuries      || 0,
    }));

    res.json({ ok: true, data: scorers });
  } catch (e) {
    console.error("❌ IPL Top Run Scorers Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 📊 IPL MOST WICKETS PROXY
// =====================================
const MOST_WICKETS_URL =
  "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/stats/284-mostwickets.js";

app.get("/api/ipl/most-wickets", async (req, res) => {
  try {
    const response = await fetch(`${MOST_WICKETS_URL}?callback=onmostwickets&_=${Date.now()}`, {
      headers: IPL_HEADERS,
    });
    if (!response.ok) throw new Error(`Most wickets feed responded with ${response.status}`);

    let text = await response.text();
    const cleanedJson = text
      .trim()
      .replace(/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/, "")
      .replace(/\);?\s*$/, "")
      .replace(/^var\s+\w+\s*=\s*/, "")
      .trim();

    const data = JSON.parse(cleanedJson);
    const bowlers = (data.mostwickets || []).slice(0, 10).map((p) => ({
      name:        p.BowlerName          || "",
      team:        p.TeamCode            || "",
      matches:     p.Matches             || 0,
      innings:     p.Innings             || 0,
      wickets:     p.Wickets             || 0,
      overs:       p.OversBowled         || 0,
      runs:        p.TotalRunsConceded   || 0,
      economy:     p.EconomyRate         || "0",
      average:     p.BowlingAverage      || "0",
      strikeRate:  p.BowlingSR           || "0",
      bestInnings: p.BBIW                || "-",
      fiveWickets: p.FiveWickets         || 0,
    }));

    res.json({ ok: true, data: bowlers });
  } catch (e) {
    console.error("❌ IPL Most Wickets Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 🏏 FULL MATCH CENTER PROXY
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
      name:      player.PlayerName.trim(),
      outDesc:   player.OutDesc,
      runs:      player.Runs,
      balls:     player.Balls,
      fours:     player.Fours,
      sixes:     player.Sixes,
      sr:        player.StrikeRate,
      isBatting: player.OutDesc === "not out"
    }));

    const bowlingCard = (inn.BowlingCard || []).map(bowler => ({
      name:     bowler.PlayerName,
      overs:    bowler.Overs,
      maidens:  bowler.Maidens,
      runs:     bowler.Runs,
      wickets:  bowler.Wickets,
      economy:  bowler.Economy
    }));

    const ballByBall = (inn.OverHistory || []).slice(0, 12).map(ball => ({
      over:       ball.BallName,
      striker:    ball.BatsManName,
      bowler:     ball.BowlerName,
      runs:       ball.Runs,
      event:      ball.NewCommentry,
      isWicket:   ball.IsWicket === "1",
      isBoundary: ball.IsFour === "1" || ball.IsSix === "1"
    }));

    res.json({
      ok: true,
      matchName: ms.MatchName,
      status:    ms.IsMatchEnd === 1 ? "Completed" : "Live",
      score:     ms[`${curInnNum}Summary`],
      data: {
        batting:     battingCard,
        bowling:     bowlingCard,
        commentary:  ballByBall,
        recentBalls: inn.BallsInCurrentOver || []
      }
    });

  } catch (e) {
    console.error(`❌ IPL Full Match Center error [${req.params.id}]:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 🏏 WT20 PROXY ROUTES
// =====================================
const WT20_CLIENT_ID = "tPZJbRgIub3Vua93/DWtyQ==";   // decoded — URLSearchParams re-encodes correctly
const WT20_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Referer":         "https://www.icc-cricket.com/",
  "Origin":          "https://www.icc-cricket.com",
  "Accept-Language": "en-US,en;q=0.9",
};

// ── GET /api/wt20/scorecard?game_id=262318 ───────────────────────────────────
app.get("/api/wt20/scorecard", async (req, res) => {
  const { game_id } = req.query;
  if (!game_id) return res.status(400).json({ ok: false, error: "game_id is required" });

  try {
    const params = new URLSearchParams({
      client_id:   WT20_CLIENT_ID,
      feed_format: "json",
      game_id,
      lang:        "en",
    });
    const url = `https://assets-icc.sportz.io/cricket/v1/game/scorecard?${params}`;
    console.log("🏏 WT20 scorecard →", url);

    const response = await fetch(url, { headers: WT20_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      console.error("❌ WT20 scorecard upstream:", response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("❌ WT20 scorecard error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/wt20/schedule?series_ids=12672&game_count=10 ────────────────────
app.get("/api/wt20/schedule", async (req, res) => {
  const {
    series_ids  = "12672",
    game_count  = "10",
    is_live     = "true",
    is_recent   = "true",
    is_upcoming = "true",
  } = req.query;

  try {
    const params = new URLSearchParams({
      client_id:   WT20_CLIENT_ID,
      feed_format: "json",
      game_count,
      is_deleted:  "false",
      is_live,
      is_recent,
      is_upcoming,
      lang:        "en",
      league_ids:  "1,9,10,35",
      pagination:  "false",
      series_ids,
      timezone:    "0530",
    });
    const url = `https://assets-icc.sportz.io/cricket/v1/schedule?${params}`;
    console.log("📅 WT20 schedule →", url);

    const response = await fetch(url, { headers: WT20_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      console.error("❌ WT20 schedule upstream:", response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("❌ WT20 schedule error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/wt20/commentary?game_id=262318&inning=1&page_number=1 ───────────
app.get("/api/wt20/commentary", async (req, res) => {
  const { game_id, inning = "1", page_number = "1", page_size = "20" } = req.query;
  if (!game_id) return res.status(400).json({ ok: false, error: "game_id is required" });

  try {
    const params = new URLSearchParams({
      client_id:   WT20_CLIENT_ID,
      feed_format: "json",
      game_id,
      inning,
      key_event:   "true",
      lang:        "en",
      page_number,
      page_size,
    });
    const url = `https://assets-icc.sportz.io/cricket/v1/game/commentary?${params}`;
    console.log("💬 WT20 commentary →", url);

    const response = await fetch(url, { headers: WT20_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      console.error("❌ WT20 commentary upstream:", response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("❌ WT20 commentary error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// 🇮🇳 BCCI / INDIA MATCHES PROXY ROUTES
// =====================================
const BCCI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept":     "application/json, text/plain, */*",
  "Referer":    "https://www.bcci.tv/",
  "Origin":     "https://www.bcci.tv",
};

// ── GET /api/bcci/live ────────────────────────────────────────────────────────
app.get("/api/bcci/live", async (req, res) => {
  try {
    const url = "https://scores2.bcci.tv/getLiveMatches"
      + "?platform=international&previousMatchesCount=0"
      + "&filterType=All&filters%5Bformat%5D%5B%5D=AllFormat&loadMore=false";
    console.log("🏏 BCCI live →", url);

    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      console.error("❌ BCCI live upstream:", response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("❌ BCCI live error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/bcci/upcoming ────────────────────────────────────────────────────
app.get("/api/bcci/upcoming", async (req, res) => {
  try {
    const url = "https://scores2.bcci.tv/getUpcomingMatches"
      + "?platform=international&previousMatchesCount=0"
      + "&filterType=All&filters%5Bformat%5D%5B%5D=AllFormat&loadMore=false";
    console.log("📅 BCCI upcoming →", url);

    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      console.error("❌ BCCI upcoming upstream:", response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("❌ BCCI upcoming error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/bcci/recent ─────────────────────────────────────────────────────
app.get("/api/bcci/recent", async (req, res) => {
  try {
    const url = "https://scores2.bcci.tv/getRecentMatches"
      + "?platform=international&previousMatchesCount=0"
      + "&filterType=All&filters%5Bformat%5D%5B%5D=AllFormat&loadMore=false";
    console.log("✅ BCCI recent →", url);

    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      console.error("❌ BCCI recent upstream:", response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("❌ BCCI recent error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/bcci/match?competitionID=285&matchID=2413 ───────────────────────
// Proxies the full match center details (live score, ball by ball)
app.get("/api/bcci/match", async (req, res) => {
  const { competitionID, matchID, matchOrder, seriesName } = req.query;
  if (!competitionID || !matchID) {
    return res.status(400).json({ ok: false, error: "competitionID and matchID are required" });
  }

  try {
    const params = new URLSearchParams({
      competitionID,
      matchID,
      SERIES_ID: competitionID,
      widgetType: "international",
      ...(matchOrder  && { matchOrder }),
      ...(seriesName  && { seriesName }),
    });
    const url = `https://scores2.bcci.tv/getMatchCenterDetails?${params}`;
    console.log("🏏 BCCI match center →", url);

    const response = await fetch(url, { headers: BCCI_HEADERS });
    const text = await response.text();
    if (!response.ok) {
      console.error("❌ BCCI match upstream:", response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("❌ BCCI match error:", e.message);
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
  return (q.includes("football") || q.includes("fifa") || q.includes("soccer"))
    ? "football" : "cricket";
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
          contents: [{
            parts: [{
              text: `Convert this raw sports match query into a precise, search-optimized phrase (max 10 words).
Expand team abbreviations to full country/team names. Include tournament name and year.
Output ONLY the search phrase, nothing else.

Raw query: "${rawQuery}"
Examples:
- "ICC WT20 WC 2026 ENG vs SL cricket" → "England vs Sri Lanka ICC Women's T20 World Cup 2026"
- "FIFA World Cup 2026 CAN vs BIH football" → "Canada vs Bosnia FIFA World Cup 2026 match action"
- "IPL 2025 MI vs CSK cricket" → "Mumbai Indians vs Chennai Super Kings IPL 2025 match"`
            }]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 30 }
        }),
      }
    );
    const json = await res.json();
    const optimized = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return optimized?.length > 5 ? optimized : rawQuery;
  } catch (e) {
    console.warn("[gemini] Query optimization failed:", e.message);
    return rawQuery;
  }
}

async function searchViaTavily(query, count = 5) {
  if (!TAVILY_API_KEY) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth:              "basic",
        include_images:            true,
        include_image_descriptions: false,
        max_results:               count,
        topic:                     "news",
      }),
    });

    if (!res.ok) { console.warn(`[tavily] API error: ${res.status}`); return []; }

    const json = await res.json();
    return (json.images || []).filter(url =>
      url?.startsWith("http") &&
      !url.endsWith(".svg") &&
      !url.endsWith(".gif") &&
      !url.includes("logo") &&
      !url.includes("icon") &&
      !url.includes("pixel")
    );
  } catch (e) {
    console.error("[tavily] Search failed:", e.message);
    return [];
  }
}

app.get('/api/search-image', async (req, res) => {
  try {
    const rawQuery = req.query.q;
    if (!rawQuery) return res.status(400).json({ error: "Missing query" });

    const decoded   = decodeURIComponent(rawQuery).trim();
    const sportType = detectSport(decoded);
    console.log(`[image-search] Raw: "${decoded}" | Sport: ${sportType}`);

    const optimizedQuery = await optimizeQueryWithGemini(decoded);
    console.log(`[image-search] Optimized: "${optimizedQuery}"`);

    const images = await searchViaTavily(optimizedQuery);

    if (images.length === 0) {
      console.log(`[image-search] Tavily returned 0, using ${sportType} fallback`);
      return res.json({ images: STATIC_EMERGENCY_FALLBACKS[sportType] });
    }

    console.log(`[image-search] Returning ${images.length} images`);
    return res.json({ images });

  } catch (err) {
    console.error("[image-search] Critical error:", err);
    return res.json({
      images: ["https://images.unsplash.com/photo-1508098682722-e99c43a406b2?q=80&w=1200&auto=format&fit=crop"]
    });
  }
});

// -------------------- Test route --------------------
app.get('/', (req, res) => res.send('✅ API is live'));

// -------------------- Start server --------------------
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
