import express from "express";
import multer from "multer";
import fs from "fs";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";

const router = express.Router();

// ---------------- Config ----------------
const BUNNY_STREAM_KEY = "260ad47e-8326-4e90-b0320932de90-8a37-4f2a";
const BUNNY_LIBRARY_ID = "508871";
const BUNNY_PULL_ZONE = "vz-fdc974fc-344.b-cdn.net"; // without https
const BUNNY_TOKEN_KEY = "54292d0a-8225-4535-93bc-61067e6e15a7"; // token auth key

// ES module __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------- Enable CORS ----------------
router.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "AccessKey"],
  })
);

// ---------------- Multer Storage ----------------
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
  const name = path
    .basename(filename, ext)
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]/g, "")
    .toLowerCase();
  return `${name}-${uuidv4()}${ext.toLowerCase()}`;
}

// ---------------- Helper: Generate Bunny Token URL ----------------
function generateTokenUrl(videoGuid, expireSeconds = 300) {
  const filePath = `/${videoGuid}/play_720p.mp4`;
  const expires = Math.floor(Date.now() / 1000) + expireSeconds;

  const hmac = crypto
    .createHmac("sha256", BUNNY_TOKEN_KEY)
    .update(`${filePath}${expires}`)
    .digest("hex");

  return `https://${BUNNY_PULL_ZONE}${filePath}?token=${hmac}&expires=${expires}`;
}

// ---------------- Upload Route (File or URL) ----------------
router.post("/upload-bunnystream", upload.single("movie"), async (req, res) => {
  try {
    let safeFileName = "";

    // -------- Upload via URL --------
    if (req.body.videoUrl) {
      const videoUrl = req.body.videoUrl;
      safeFileName = sanitizeFileName(path.basename(videoUrl));

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

      return res
        .status(200)
        .json({ message: "✅ Video upload started via URL!", videoGuid, directUrl });
    }

    // -------- Upload via Local File --------
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
      return res
        .status(200)
        .json({ message: "✅ Video uploaded successfully!", videoGuid, directUrl });
    }

    // -------- No File or URL --------
    else {
      return res.status(400).json({ error: "No file or URL provided" });
    }
  } catch (err) {
    console.error("❌ Bunny Stream Upload Error:", err);
    return res.status(500).json({ error: "Server error", message: err.message });
  }
});

// ---------------- Get Tokenized Download Link ----------------
router.get("/videos/:guid/download", async (req, res) => {
  const { guid } = req.params;
  try {
    // Generate token URL valid for 5 minutes
    const tokenUrl = generateTokenUrl(guid, 300);

    // Return URL only (frontend can use download attribute)
    res.status(200).json({ directDownloadUrl: tokenUrl });
  } catch (err) {
    console.error("❌ Error generating download URL:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

export default router;
