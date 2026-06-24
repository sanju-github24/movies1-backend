import express from "express";
import fetch from "node-fetch";

const router = express.Router();

router.get("/stream", async (req, res) => {
const fileId = req.query.fileId;

console.log("🔥 STREAM ROUTE HIT");
console.log("FILE ID:", fileId);

if (!fileId) {
return res.status(400).json({
error: "Missing fileId"
});
}

try {
const BOT_TOKEN = process.env.BOT_TOKEN;


const infoRes = await fetch(
  `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
);

const infoData = await infoRes.json();

console.log("Telegram:", infoData);

if (!infoData.ok) {
  return res.status(400).json(infoData);
}

const filePath = infoData.result.file_path;

const telegramFileUrl =
  `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

const telegramRes = await fetch(telegramFileUrl);

res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "*");
res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
res.setHeader("Accept-Ranges", "bytes");
res.setHeader("Content-Type", "video/mp4");

telegramRes.body.pipe(res);


} catch (err) {
console.error(err);

res.status(500).json({
  error: err.message
});


}
});

export default router;
