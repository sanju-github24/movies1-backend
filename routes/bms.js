import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Serve static files from public/ (works even inside this router)
router.use("/public", express.static(path.join(__dirname, "../public")));

router.get("/", (req, res) => {
  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ success: false, message: "No slug provided" });
  }

  const pythonPath = "/opt/homebrew/bin/python3.13";  
  const scriptPath = path.join(__dirname, "../script/bms_scraper.py");

  execFile(pythonPath, [scriptPath, slug], (error, stdout, stderr) => {
    if (error) {
      console.error("Python error:", error, stderr);
      return res.status(500).json({ success: false, error: "Server error" });
    }

    try {
      const result = JSON.parse(stdout);
      return res.json(result);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr, "stdout:", stdout);
      return res.status(500).json({ success: false, error: "Invalid Python response" });
    }
  });
});

export default router;
