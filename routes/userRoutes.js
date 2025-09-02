// routes/userRouter.js
import express from "express";
import userAuth from "../middleware/userAuth.js";
import { 
  getUserData, 
  updateUsername, 
  getAllUsers, 
  getUsersCount 
} from "../controllers/userController.js";

const userRouter = express.Router();

// Get logged-in user data
userRouter.get("/data", userAuth, getUserData);

// Update username
userRouter.put("/update-name", userAuth, updateUsername);

// ✅ Get all users (no backend admin check)
userRouter.get("/all", getAllUsers);

// ✅ Get only user count (no backend admin check)
userRouter.get("/count", getUsersCount);

export default userRouter;
