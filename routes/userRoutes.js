import express from 'express';
import userAuth from '../middleware/userAuth.js';
import { getUserData, updateUsername } from '../controllers/userController.js';

const userRouter = express.Router();

// Get logged-in user data
userRouter.get('/data', userAuth, getUserData);

// ✅ Update username
userRouter.put('/update-name', userAuth, updateUsername);

export default userRouter;
