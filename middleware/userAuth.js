import jwt from 'jsonwebtoken';

const userAuth = async (req, res, next) => {
    const { token } = req.cookies;

    // Set CORS headers for manual responses (401 errors)
    const setCorsHeaders = () => {
        if (req.headers.origin) {
            res.header('Access-Control-Allow-Origin', req.headers.origin);
        }
        res.header('Access-Control-Allow-Credentials', 'true');
    };

    if (!token) {
        setCorsHeaders();
        return res.status(401).json({ success: false, message: "Not authorized, login again" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded?.id) {
            req.user = { userId: decoded.id };
            next();
        } else {
            setCorsHeaders();
            return res.status(401).json({ success: false, message: "Invalid token, login again" });
        }
    } catch (error) {
        setCorsHeaders();
        return res.status(401).json({ success: false, message: error.message });
    }
};

export default userAuth;

