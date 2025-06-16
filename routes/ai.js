import express from 'express';
import { generateSummary } from '../controllers/aiController.js';
import userAuth from '../middleware/userAuth.js'; // protect admin access

const router = express.Router();

router.post('/api/generate-summary', userAuth, generateSummary);

export default router;
