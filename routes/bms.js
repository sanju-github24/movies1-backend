import express from "express";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

// ES Module dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

router.get("/", (req, res) => {
  const { slug } = req.query;
  if (!slug) {
    return res.status(400).json({
      success: false,
      message: "No slug provided",
    });
  }

  // ✅ Correct folder name "script"
  const scriptPath = path.resolve(__dirname, "../script/bms_scraper.py");

  console.log("Running scraper at:", scriptPath); // Debug log

  // ✅ Spawn Python process
  const pyProcess = spawn("python", [scriptPath, slug]);


  let result = "";

  // Collect stdout from Python
  pyProcess.stdout.on("data", (data) => {
    result += data.toString();
  });

  // Log errors from Python
  pyProcess.stderr.on("data", (data) => {
    console.error("Python error:", data.toString());
  });

  // Handle process exit
  pyProcess.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({
        success: false,
        error: `Python process exited with code ${code}`,
        details: result || `Tried path: ${scriptPath}`,
      });
    }

    try {
      const json = JSON.parse(result);
      res.json(json);
    } catch (e) {
      res.status(500).json({
        success: false,
        error: "Invalid Python response",
        raw: result,
      });
    }
  });
});

export default router;
