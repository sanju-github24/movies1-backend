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



// Example: /download/:slug or /download/:token
app.get('/download/:id', async (req, res) => {
  const { id } = req.params;

  // Option 1: Decode/lookup from DB
  const realUrl = decodeURIComponent(id); // or use DB to get actual file URL

  try {
    const response = await fetch(realUrl);
    if (!response.ok) return res.status(500).send('Download failed');

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const filename = 'movie.torrent'; // You can dynamically extract filename

    res.setHeader('Content-Type', 'application/x-bittorrent');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    response.body.pipe(res); // stream to client
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to fetch file.');
  }
});





// ✅ Universal proxy-download route




// Start the server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
