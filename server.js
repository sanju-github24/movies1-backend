import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import authRouter from './routes/authRoutes.js';
import userRouter from './routes/userRoutes.js';

import movieRouter from './routes/movieRoutes.js';
import { connectDBs } from './config/mongodb.js';

import cron from 'node-cron';
import { deleteOldTorrents } from './utils/cleanup.js';
import popadsRoute from './routes/popadsRoute.js';




const app = express();
const port = process.env.PORT || 4000;

// Connect to MongoDB (for auth/user features)

await connectDBs(); // en

// Allowed origins for CORS
const allowedOrigins = [
  'http://localhost:5173',
  'https://auth-2407.netlify.app',
  'https://movies1-frontend.vercel.app',
  'https://1anchormovies.vercel.app',
  'https://www.1anchormovies.live',
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

cron.schedule('0 0 * * *', () => {
  console.log('🧹 Running cleanup job...');
  deleteOldTorrents();
});


// Middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Basic route
app.get('/', (req, res) => res.send('✅ API is live'));

// Auth and user routes
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/movies', movieRouter);
app.use('/api', popadsRoute);



app.get('/proxy-download', async (req, res) => {
  const { url, filename } = req.query;

  if (!url || !filename) {
    return res.status(400).send('❌ Missing URL or filename');
  }

  const decodedUrl = decodeURIComponent(url);

  try {
    const response = await axios({
      method: 'GET',
      url: decodedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*',
        'Referer': decodedUrl,
      },
      timeout: 15000,
      maxRedirects: 5,
    });

    // ✅ Browser download headers
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/x-bittorrent');
    res.setHeader('Cache-Control', 'no-store');

    // ✅ Optional: Expose filename for CORS download support
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    // ✅ Set size if available
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    // ✅ Stream the file to the client
    response.data.pipe(res);
  } catch (err) {
    console.error('❌ Proxy error:', err.message);

    if (err.response) {
      return res
        .status(err.response.status)
        .send(`Upstream error: ${err.response.statusText}`);
    }

    res.status(500).send('⚠️ Failed to proxy torrent file.');
  }
});




// ✅ Universal proxy-download route




// Start the server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
