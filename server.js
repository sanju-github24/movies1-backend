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



app.get('/proxy-download', async (req, res) => {
  const { url, filename } = req.query;

  try {
    const response = await axios.get(url, { responseType: 'stream' });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/x-bittorrent');

    response.data.pipe(res);
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).send('Failed to download torrent file');
  }
});




// ✅ Universal proxy-download route




// Start the server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
