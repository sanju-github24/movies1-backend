import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import userModel from '../models/usermodel.js';
import transporter from '../config/nodeMailer.js';
import { EMAIL_VERIFY_TEMPLATE, PASSWORD_RESET_TEMPLATE } from '../config/emailTemplates.js';

// --- Cookie Configuration Helper ---
// This pattern correctly handles localhost (cross-port, non-secure) 
// and production (cross-site, secure: true)
const cookieOptions = {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    // FIX: Use 'Lax' for local (cross-port) and 'None' for production (cross-site)
    // Note: If 'SameSite: None', 'Secure: true' MUST be set.
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax', 
};

// ------------------ REGISTER ------------------
export const register = async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password)
    // CRITICAL: Ensure early returns use res.json() to send the CORS-compliant response
    return res.status(400).json({ success: false, message: "Missing Details" });

  try {
    const existingUser = await userModel.findOne({ email });
    if (existingUser)
      return res.status(409).json({ success: false, message: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new userModel({ name, email, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    // Apply the corrected cookie options
    res.cookie('token', token, cookieOptions); 

    // --- Email logic (kept short for brevity) ---
    await transporter.sendMail({
      from: process.env.SENDER_EMAIL,
      to: email,
      subject: 'Welcome to our platform!',
      text: `Welcome! Your account has been created with email: ${email}`
    });

    return res.status(201).json({
      success: true,
      user: { _id: user._id, name: user.name, email: user.email },
      token,
    });
  } catch (error) {
    // Ensure 500 errors also send a response
    res.status(500).json({ success: false, message: error.message });
  }
};

// ------------------ LOGIN ------------------
// ------------------ LOGIN ------------------
export const login = async (req, res) => {
    console.log("➡️ Attempting Login for:", req.body.email); 
    
    const { email, password } = req.body;
    
    if (!email || !password) 
      return res.status(400).json({ success: false, message: "Missing Email or Password" });

    try {
      console.log("➡️ Login: Entered try block, finding user.");
      
      // 🚀 THE FIX: Explicitly select the 'password' field.
      const user = await userModel.findOne({ email }).select('+password'); 
      
      if (user) {
          console.log("✅ Login: User found. Proceeding to password check.");
      } else {
          console.log("❌ Login: User not found in database.");
      }
      
      if (!user)
        return res.status(401).json({ success: false, message: "Invalid credentials" }); 

      // This line now receives the actual hash, preventing the crash
      const isMatch = await bcrypt.compare(password, user.password);
      
      if (!isMatch)
        return res.status(401).json({ success: false, message: "Invalid credentials" }); 

      const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

      res.cookie("token", token, cookieOptions);

      // Successfully sends a 200 response (and correct CORS headers)
      res.status(200).json({
        success: true,
        message: "Logged in successfully",
        user: { _id: user._id, name: user.name, email: user.email },
        token,
      });
    } catch (err) {
      // This catch block will only handle external errors (e.g., JWT_SECRET missing)
      console.error("❌ Login Server Crash (Handled):", err.message);
      res.status(500).json({ success: false, message: "Internal server error during login." });
    }
};
// ------------------ LOGOUT ------------------
export const logout = (req, res) => {
  try {
    // 🚀 FIX: Use spread operator to apply all original cookie options
    // and explicitly set maxAge to 0 (or simply don't set it, as clearCookie handles expiry)
    res.clearCookie('token', {
      ...cookieOptions,
      maxAge: undefined, // Don't explicitly set maxAge here if clearCookie handles it
      expires: new Date(0), // Forces immediate expiration
      
      // CRITICAL: Must be explicitly included for clearCookie to work cross-origin/cross-port
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax', 
      path: '/', 
    });
    
    // Log for debugging
    console.log("✅ Logout: Successfully cleared 'token' cookie.");

    res.status(200).json({ success: true, message: "Logged out" });
  } catch (error) {
    console.error("❌ Logout Error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ------------------ VERIFY EMAIL FLOW ------------------
export const sendVerifyOtp = async (req, res) => {
  try {
    // ... (no changes needed here) ...
    const { userId } = req.user;
    const user = await userModel.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (user.isAccountVerified)
      return res.status(400).json({ success: false, message: "Account already verified" });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    user.verifyOtp = otp;
    user.verifyOtpExpireAt = Date.now() + 10 * 60 * 1000;
    await user.save();

    await transporter.sendMail({
      from: process.env.SENDER_EMAIL,
      to: user.email,
      subject: 'Verify your account',
      html: EMAIL_VERIFY_TEMPLATE.replace('{{email}}', user.email).replace('{{otp}}', otp),
    });

    res.status(200).json({ success: true, message: "OTP sent to your email" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyEmail = async (req, res) => {
  const { otp } = req.body;
  const { userId } = req.user;

  if (!otp || !userId)
    return res.status(400).json({ success: false, message: "Missing details" });

  try {
    const user = await userModel.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (user.verifyOtp !== otp)
      return res.status(401).json({ success: false, message: "Invalid OTP" });

    if (user.verifyOtpExpireAt < Date.now())
      return res.status(401).json({ success: false, message: "OTP expired" });

    user.isAccountVerified = true;
    user.verifyOtp = '';
    user.verifyOtpExpireAt = 0;
    await user.save();

    res.status(200).json({ success: true, message: "Email verified successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ------------------ IS AUTH ------------------
export const isAuthenticated = (req, res) => {
  try {
    // ... (no changes needed here) ...
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ------------------ PASSWORD RESET ------------------
export const sendResetOtp = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email is required" });

  try {
    // ... (no changes needed here) ...
    const user = await userModel.findOne({ email });
    if (!user)
      return res.status(404).json({ success: false, message: "User not found" });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    user.resetOtp = otp;
    user.resetOtpExpireAt = Date.now() + 10 * 60 * 1000;
    await user.save();

    await transporter.sendMail({
      from: process.env.SENDER_EMAIL,
      to: user.email,
      subject: 'Reset your password',
      html: PASSWORD_RESET_TEMPLATE.replace('{{email}}', user.email).replace('{{otp}}', otp),
    });

    res.status(200).json({ success: true, message: "OTP sent to your email" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ success: false, message: "Missing fields" });

  try {
    // ... (no changes needed here) ...
    const user = await userModel.findOne({ email });
    if (!user)
      return res.status(404).json({ success: false, message: "User not found" });

    if (user.resetOtp !== otp)
      return res.status(401).json({ success: false, message: "Invalid OTP" });

    if (user.resetOtpExpireAt < Date.now())
      return res.status(401).json({ success: false, message: "OTP expired" });

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetOtp = '';
    user.resetOtpExpireAt = 0;
    await user.save();

    res.status(200).json({ success: true, message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
