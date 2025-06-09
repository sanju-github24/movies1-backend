import jwt from 'jsonwebtoken';

const userAuth = async (req, res, next) => {
    const { token } = req.cookies;
    if (!token) {
        return res.json({ success: false, message: "Not authorized, login again" });
    }
    try {
        const tokenDecode = jwt.verify(token, process.env.JWT_SECRET);
        if (tokenDecode.id) {
            req.user = { userId: tokenDecode.id }; // ✅ THIS FIXES THE ERROR
            next();
        } else {
            return res.json({ success: false, message: "Not authorized, login again" });
        }
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

export default userAuth;