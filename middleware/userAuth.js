import jwt from 'jsonwebtoken';
import userModel from '../models/usermodel.js';


const userAuth = async (req, res, next) => {
  let token;

  // 1. Prefer token from cookies
  if (req.cookies?.token) {
    token = req.cookies.token;
    console.log("🔐 Token from cookie:", token);
  } 
  // 2. Fallback to Bearer token from headers
  else if (req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
    console.log("🔐 Token from Authorization header:", token);
  } else {
    console.log("⛔ No token provided");
  }

  // Utility to set CORS headers on error responses
  const setCorsHeaders = () => {
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  };

  // 3. If no token found
  if (!token) {
    setCorsHeaders();
    return res.status(401).json({ success: false, message: "Not authorized. Please login again." });
  }

  try {
    // 4. Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("✅ Decoded JWT:", decoded);

    // 5. Check decoded data
    if (!decoded?.userId) {
      setCorsHeaders();
      return res.status(401).json({ success: false, message: "Invalid token. Please login again." });
    }

    // 6. Find user from DB
    const user = await userModel.findById(decoded.userId).select("-password");
    if (!user) {
      setCorsHeaders();
      return res.status(401).json({ success: false, message: "User not found." });
    }

    // 7. Attach user to request
    req.user = { userId: decoded.userId };
    next();

  } catch (error) {
    console.error("❌ Token verification error:", error.message);
    setCorsHeaders();
    return res.status(401).json({ success: false, message: "Token verification failed." });
  }
};

export default userAuth;
