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



app.get('/download/:encoded', async (req, res) => {
  const encoded = req.params.encoded;

  // Simple validation
  if (!encoded || !encoded.endsWith('.torrent')) {
    return res.status(400).send('Invalid file request.');
  }

  // Reconstruct full original URL
  const decodedUrl = `https://files.catbox.moe/${encoded}`;
  const filename = req.query.filename || encoded;

  try {
    const response = await axios({
      method: 'GET',
      url: decodedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AnchorBot/1.0)'
      }
    });

    res.setHeader('Content-Type', 'application/x-bittorrent');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    response.data.pipe(res);
  } catch (err) {
    console.error('Error downloading file:', err.message);
    res.status(500).send('Download failed.');
  }
});


// ✅ Universal proxy-download route




// Start the server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
