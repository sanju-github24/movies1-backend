// routes/autofill.js

import express from "express";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const router = express.Router();

/**
 * POST /api/autofill
 * Body: { mode: "search" | "url" | "top", movie?: string, language?: string, url?: string }
 */
router.post("/autofill", (req, res) => {
  const { mode = "top", movie = "", language = "Kannada", url = "" } = req.body;

  const botPath = path.join(__dirname, "..", "scrapers", "autofill_bot.py");

  const args = [botPath, mode];
  if (mode === "search") { args.push(movie, language); }
  if (mode === "url")    { args.push(url); }

  console.log(`🤖 AutoFill triggered — mode: ${mode}`, movie || url || "");
  console.log(`🐍 Spawning: python3 ${args.join(" ")}`);

  let output    = "";
  let errOutput = "";

  const proc = spawn("python3", args, {
    // Run from project root so relative imports inside the bot work
    cwd: path.join(__dirname, ".."),
    env: { ...process.env },
  });

  proc.stdout.on("data", (d) => { output += d.toString(); });
  proc.stderr.on("data", (d) => {
    errOutput += d.toString();
    // Print each stderr line so you see TMDB progress, warnings, tracebacks
    console.error("🐍 Bot:", d.toString().trim());
  });

  // Safety timeout — kill bot after 90 seconds
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
    if (!res.headersSent) {
      res.status(504).json({ success: false, error: "Bot timed out after 90s" });
    }
  }, 90_000);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    if (timedOut) return; // already responded

    console.log(`🤖 Bot exited with code ${code}`);
    console.log(`📦 Raw stdout (${output.length} chars):`, output.slice(0, 600));

    // ── Find the JSON object inside stdout ──
    // The bot may print non-JSON lines (warnings, print() calls) before or after
    // the JSON blob. We extract just the first complete { ... } object.
    const jsonStart = output.indexOf("{");
    const jsonEnd   = output.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1) {
      console.error("❌ No JSON object found in bot output.");
      console.error("Full stdout:", output);
      console.error("Full stderr:", errOutput);
      return res.status(500).json({
        success: false,
        error:   "Bot produced no JSON output — check server logs for the Python traceback",
        stdout:  output.slice(0, 1000),
        stderr:  errOutput.slice(0, 1000),
      });
    }

    const jsonSlice = output.slice(jsonStart, jsonEnd + 1);

    try {
      const parsed = JSON.parse(jsonSlice);

      if (parsed.error) {
        console.error("❌ Bot returned error field:", parsed.error);
        return res.status(400).json({ success: false, error: parsed.error });
      }

      console.log(`✅ AutoFill OK — title: "${parsed.title}", blocks: ${parsed.downloadBlocks?.length ?? 0}`);
      res.json({ success: true, data: parsed });

    } catch (e) {
      console.error("❌ JSON.parse failed:", e.message);
      console.error("Slice that failed:", jsonSlice.slice(0, 800));
      res.status(500).json({
        success: false,
        error:   `JSON parse error: ${e.message}`,
        stdout:  output.slice(0, 1000),
        stderr:  errOutput.slice(0, 1000),
      });
    }
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    console.error("❌ Failed to spawn python3:", err.message);
    res.status(500).json({
      success: false,
      error:   `Spawn failed: ${err.message} — is python3 in PATH on this server?`,
    });
  });
});

export default router;