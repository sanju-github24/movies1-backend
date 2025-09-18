// routes/up4stream.js
import express from "express";
import axios from "axios";

const router = express.Router();
const API_KEY = process.env.UP4STREAM_API_KEY; // put this in your .env

// Simple in-memory cache to map file_code -> title
const titleCache = new Map();

const sanitizeFilename = (name) => {
  if (!name || typeof name !== "string") return "video";
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "") // Windows reserved + control chars
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "video";
};

// =====================
// 1️⃣ Fetch file list
// GET /api/up4stream/files
// =====================
router.get("/files", async (req, res) => {
  try {
    const listRes = await axios.get("https://up4stream.com/api/file/list", {
      params: {
        key: API_KEY,
        per_page: 50,
        page: 1,
      },
    });

    const files = listRes.data?.result?.files || [];
    if (files.length === 0) {
      return res.status(404).json({ error: "No files found on Up4Stream" });
    }

    files.forEach((f) => {
      if (f?.file_code && f?.title) titleCache.set(f.file_code, f.title);
    });

    const simplifiedFiles = files.map((f) => ({
      file_code: f.file_code,
      title: f.title,
      thumbnail: f.thumbnail,
      length: f.length,
      uploaded: f.uploaded,
      public: f.public,
    }));

    res.json({ files: simplifiedFiles });
  } catch (err) {
    console.error("Up4Stream file list error:", err.message);
    res.status(500).json({ error: "Server error fetching file list" });
  }
});

// =====================
// 2️⃣ Fetch direct link info (return real URLs)
// GET /api/up4stream/direct-link/:file_code
// =====================
router.get("/direct-link/:file_code", async (req, res) => {
  const { file_code } = req.params;
  if (!file_code) return res.status(400).json({ error: "Missing file_code" });

  try {
    const directRes = await axios.get(
      "https://up4stream.com/api/file/direct_link",
      {
        params: { key: API_KEY, file_code, hls: 1 },
      }
    );

    const result = directRes.data?.result;
    if (!result) {
      return res.status(404).json({ error: "Direct link not found" });
    }

    const possibleTitle =
      result?.title || result?.name || result?.filename || null;
    if (possibleTitle) {
      titleCache.set(file_code, possibleTitle);
    }

    const versions = (result.versions || []).map((v) => ({
      name: v.name,
      size: v.size,
      direct_url: v.url,
    }));

    // Return the **real HLS URL directly**
    res.json({
      file_code,
      versions,
      hls: result.hls_direct || null,
    });
  } catch (err) {
    console.error("Up4Stream direct link error:", err.message);
    res.status(500).json({ error: "Server error fetching direct link" });
  }
});

// =====================
// 3️⃣ Proxy MP4 with Range support (optional)
// GET /api/up4stream/proxy/:file_code/:quality
// =====================
router.get("/proxy/:file_code/:quality", async (req, res) => {
  const { file_code, quality } = req.params;

  try {
    const directRes = await axios.get(
      "https://up4stream.com/api/file/direct_link",
      { params: { key: API_KEY, file_code } }
    );

    const result = directRes.data?.result;
    const version = result?.versions?.find((v) => v.name === quality);
    if (!version) {
      return res.status(404).json({ error: "Version not found" });
    }

    const videoUrl = version.url;

    let title =
      result?.title ||
      result?.name ||
      result?.filename ||
      titleCache.get(file_code) ||
      "video";

    title = sanitizeFilename(title);
    const finalFilename = `${title}.mp4`;

    const headResp = await axios.head(videoUrl);
    const fileSize = parseInt(headResp.headers["content-length"], 10);
    const contentType = headResp.headers["content-type"] || "video/mp4";
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${finalFilename}"; filename*=UTF-8''${encodeURIComponent(
          finalFilename
        )}`,
      });

      const stream = await axios.get(videoUrl, {
        responseType: "stream",
        headers: { Range: `bytes=${start}-${end}` },
      });

      stream.data.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${finalFilename}"; filename*=UTF-8''${encodeURIComponent(
          finalFilename
        )}`,
      });

      const stream = await axios.get(videoUrl, { responseType: "stream" });
      stream.data.pipe(res);
    }
  } catch (err) {
    console.error("Proxy MP4 error:", err.message);
    res.status(500).json({ error: "Failed to proxy video" });
  }
});

export default router;
