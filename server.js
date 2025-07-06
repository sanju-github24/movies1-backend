import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import authRouter from './routes/authRoutes.js';
import userRouter from './routes/userRoutes.js';
import movieRouter from './routes/movieRoutes.js';
import popadsRoute from './routes/popadsRoute.js';
import { connectDBs } from './config/mongodb.js';
import cron from 'node-cron';
import prerender from 'prerender-node';

const app = express();
const port = process.env.PORT || 4000;

// ✅ Connect to MongoDB
await connectDBs();

// ✅ CORS setup
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

// ✅ Middlewares
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// ✅ Pre-rendering for SEO (for bots like Googlebot)
app.use(
  prerender.set('prerenderToken', process.env.PRERENDER_TOKEN)
);

// ✅ Basic test route
app.get('/', (req, res) => res.send('✅ API is live'));

// ✅ API Routes
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/movies', movieRouter);
app.use('/api', popadsRoute);

// ✅ File proxy download handler
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
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36',
        Accept: '*/*',
        Referer: decodedUrl,
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
  } catch (err) {
    console.error('❌ Proxy failed, redirecting:', err.message);
    res.redirect(decodedUrl); // fallback
  }
});

// ✅ Start server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
