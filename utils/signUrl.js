import crypto from "crypto";

const BASE_URL = "https://dl.1anchormovies.live";
const SECRET_KEY = process.env.SECRET_KEY;

export function generateSignedUrl(path, expirySeconds = 86400) {
  const exp = Math.floor(Date.now() / 1000) + expirySeconds;
  const data = `${path}:${exp}`;

  const sig = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(data)
    .digest("base64")
    .replace(/=+$/, "");

  return `${BASE_URL}/watch/${path}?exp=${exp}&sig=${sig}`;
}
