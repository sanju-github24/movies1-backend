import fs from 'fs';
import path from 'path';

const torrentsDir = path.join(process.cwd(), 'public/torrents');
const MAX_AGE_DAYS = 40;

export function deleteOldTorrents() {
  const files = fs.readdirSync(torrentsDir);

  const now = Date.now();
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  files.forEach((file) => {
    const filePath = path.join(torrentsDir, file);
    const stats = fs.statSync(filePath);

    const fileAge = now - stats.mtimeMs;

    if (fileAge > maxAge) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Deleted old torrent: ${file}`);
    }
  });
}
