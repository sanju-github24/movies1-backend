import userModel from "../models/usermodel.js";

export const getUserData = async (req, res) => {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { userId } = req.user;
    const user = await userModel.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      userData: {
        name: user.name,
        isAccountVerified: user.isAccountVerified,
        email: user.email,
      }
    });
  } catch (error) {
    console.error("Error in getUserData:", error);
    res.status(500).json({ success: false, message: error.message || "Server Error" });
  }
};


export const updateUsername = async (req, res) => {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { newName } = req.body;

    if (!newName || newName.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Name must be at least 3 characters" });
    }

    const updatedUser = await userModel.findByIdAndUpdate(
      req.user.userId,
      { name: newName.trim() },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      message: "Name updated successfully",
      userData: {
        name: updatedUser.name,
        isAccountVerified: updatedUser.isAccountVerified,
        email: updatedUser.email,
      }
    });
  } catch (error) {
    console.error("Error in updateUsername:", error);
    res.status(500).json({ success: false, message: error.message || "Server Error" });
  }
};
