import jwt from 'jsonwebtoken';
import usermodel from '../models/usermodel.js'; // ✅ Ensure .js extension if using ES modules



const userAuth = async (req, res, next) => {
  const { token } = req.cookies;

  const setCorsHeaders = () => {
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  };

  if (!token) {
    setCorsHeaders();
    return res.status(401).json({ success: false, message: "Not authorized, login again" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded?.userId) {
      setCorsHeaders();
      return res.status(401).json({ success: false, message: "Invalid token, login again" });
    }

    const user = await usermodel.findById(decoded.userId).select("-password");
    if (!user) {
      setCorsHeaders();
      return res.status(401).json({ success: false, message: "User not found" });
    }

    req.user = { userId: decoded.userId };
    next();
  } catch (error) {
    setCorsHeaders();
    return res.status(401).json({ success: false, message: "Token verification failed" });
  }
};



export default userAuth;
