import jwt from 'jsonwebtoken';

const userAuth = async (req, res, next) => {
    const { token } = req.cookies;

    const setCorsHeaders = () => {
        res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.header('Access-Control-Allow-Credentials', 'true');
    };

    if (!token) {
        setCorsHeaders();
        return res.status(401).json({ success: false, message: "Not authorized, login again" });
    }

    try {
        const tokenDecode = jwt.verify(token, process.env.JWT_SECRET);

        if (tokenDecode.id) {
            req.user = { userId: tokenDecode.id };
            return next();
        } else {
            setCorsHeaders();
            return res.status(401).json({ success: false, message: "Not authorized, login again" });
        }
    } catch (error) {
        setCorsHeaders();
        return res.status(401).json({ success: false, message: error.message });
    }
};

export default userAuth;
