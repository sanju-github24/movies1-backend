// routes/popadsRoute.js
import express from 'express';
import axios from 'axios';

const router = express.Router();

const POPADS_API_KEY = process.env.POPADS_API_KEY; // Put this in your .env
const POPADS_SITE_ID = '5214920';

router.get('/popads-script', async (req, res) => {
  try {
    const apiUrl = `https://www.popads.net/api/website_code?key=${POPADS_API_KEY}&website_id=${POPADS_SITE_ID}&tl=auto&aab=1&of=1`;
    const response = await axios.get(apiUrl);
    res.setHeader('Content-Type', 'application/javascript');
    res.send(response.data);
  } catch (err) {
    console.error('PopAds fetch error:', err.message);
    res.status(500).send('// Failed to fetch PopAds script');
  }
});

export default router;
