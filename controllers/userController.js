// controllers/userController.js
import userModel from "../models/usermodel.js";

/**
 * ✅ Get logged-in user data
 */
export const getUserData = async (req, res) => {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { userId } = req.user;
    const user = await userModel.findById(userId).select("-password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      userData: {
        name: user.name,
        email: user.email,
        isAccountVerified: user.isAccountVerified,
        role: user.role || "user",
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error("❌ Error in getUserData:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

/**
 * ✅ Update username
 */
export const updateUsername = async (req, res) => {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { newName } = req.body;
    if (!newName || newName.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Name must be at least 3 characters long" });
    }

    const updatedUser = await userModel.findByIdAndUpdate(
      req.user.userId,
      { name: newName.trim() },
      { new: true }
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      message: "Name updated successfully",
      userData: {
        name: updatedUser.name,
        email: updatedUser.email,
        isAccountVerified: updatedUser.isAccountVerified,
        role: updatedUser.role || "user",
      },
    });
  } catch (error) {
    console.error("❌ Error in updateUsername:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

/**
 * ✅ Get all users (clean response, exclude password)
 * (⚠️ No backend admin check, frontend will restrict)
 */
export const getAllUsers = async (req, res) => {
  try {
    const users = await userModel.find().select("-password");

    const formattedUsers = users.map(user => ({
      id: user._id,
      name: user.name,
      email: user.email,
      isAccountVerified: user.isAccountVerified,
      role: user.role || "user",
      createdAt: user.createdAt,
    }));

    res.json({
      success: true,
      count: formattedUsers.length,
      users: formattedUsers,
    });
  } catch (error) {
    console.error("❌ Error in getAllUsers:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};


/**
 * ✅ Get only user count
 * (⚠️ No backend admin check, frontend will restrict)
 */
export const getUsersCount = async (req, res) => {
  try {
    const count = await userModel.countDocuments();
    res.json({ success: true, count });
  } catch (error) {
    console.error("❌ Error in getUsersCount:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
