import express from "express";
import multer from "multer";
import fs from "fs";
import path, { join, dirname } from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import cors from "cors";

const router = express.Router();

// ---------------- Config ----------------
const BUNNY_STREAM_KEY = "260ad47e-8326-4e90-b0320932de90-8a37-4f2a";
const BUNNY_LIBRARY_ID = "508871";

// ES module __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------- Enable CORS ----------------
router.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "AccessKey"]
}));

// ---------------- Multer Storage (Optional Local Upload) ----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage });

// ---------------- Helper: sanitize filename ----------------
function sanitizeFileName(filename) {
  const ext = path.extname(filename);
  const name = path.basename(filename, ext)
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]/g, "")
    .toLowerCase();
  return `${name}-${uuidv4()}${ext.toLowerCase()}`;
}

// ---------------- Upload Route ----------------
router.post("/upload-bunnystream", upload.single("movie"), async (req, res) => {
  try {
    let safeFileName = "";

    // -------- Option 1: Upload via URL --------
    if (req.body.videoUrl) {
      const videoUrl = req.body.videoUrl;
      safeFileName = sanitizeFileName(path.basename(videoUrl));

      // Bunny Stream supports direct remote upload via sourceUrl
      const createResponse = await fetch(
        `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            AccessKey: BUNNY_STREAM_KEY,
          },
          body: JSON.stringify({ title: safeFileName, sourceUrl: videoUrl }),
        }
      );

      const videoData = await createResponse.json();
      if (!createResponse.ok) {
        return res
          .status(createResponse.status)
          .json({ error: "Failed to create Bunny video", details: videoData });
      }

      const videoGuid = videoData.guid;
      const directUrl = `https://player.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${videoGuid}`;

      return res.status(200).json({
        message: "✅ Video upload started via URL (fast)!",
        videoGuid,
        directUrl,
      });
    }

    // -------- Option 2: Upload via Local File --------
    else if (req.file) {
      const filePath = req.file.path;
      safeFileName = sanitizeFileName(req.file.originalname);

      const createResponse = await fetch(
        `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            AccessKey: BUNNY_STREAM_KEY,
          },
          body: JSON.stringify({ title: safeFileName }),
        }
      );

      const videoData = await createResponse.json();
      if (!createResponse.ok) {
        fs.rmSync(filePath);
        return res
          .status(createResponse.status)
          .json({ error: "Failed to create Bunny video", details: videoData });
      }

      const videoGuid = videoData.guid;
      const uploadUrl = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoGuid}`;
      const fileStream = fs.createReadStream(filePath);

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          AccessKey: BUNNY_STREAM_KEY,
          "Content-Type": "application/octet-stream",
        },
        body: fileStream,
      });

      fs.rmSync(filePath);

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        return res
          .status(uploadResponse.status)
          .json({ error: "Upload to Bunny failed", details: errorText });
      }

      const directUrl = `https://player.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${videoGuid}`;
      return res.status(200).json({
        message: "✅ Video uploaded successfully!",
        videoGuid,
        directUrl,
      });
    }

    else {
      return res.status(400).json({ error: "No file or URL provided" });
    }

  } catch (err) {
    console.error("❌ Bunny Stream Upload Error:", err);
    return res.status(500).json({ error: "Server error", message: err.message });
  }
});

// ---------------- Upload from URL ----------------
router.post("/upload-from-url", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "URL is required." });

  try {
    const safeFileName = sanitizeFileName(path.basename(url));

    // Strong headers to mimic a real browser
    const headersForSource = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": url,
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1"
    };

    // Create Bunny video object using sourceUrl and strong headers
    const createResponse = await fetch(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AccessKey: BUNNY_STREAM_KEY,
        },
        body: JSON.stringify({
          title: safeFileName,
          sourceUrl: url,
          sourceHeaders: headersForSource,
        }),
      }
    );

    const videoData = await createResponse.json();

    if (!createResponse.ok) {
      return res.status(createResponse.status).json({
        error: "Failed to create Bunny video",
        details: videoData,
      });
    }

    const videoGuid = videoData.guid;
    const directUrl = `https://player.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${videoGuid}`;

    res.status(200).json({
      message: "✅ Video upload started via URL (direct to Bunny) with strong headers!",
      videoGuid,
      directUrl,
    });
  } catch (err) {
    console.error("❌ Bunny Stream Upload Error:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

export default router;
