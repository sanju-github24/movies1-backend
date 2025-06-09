import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import userModel from '../models/usermodel.js';
import transporter from '../config/nodeMailer.js';
import { EMAIL_VERIFY_TEMPLATE,PASSWORD_RESET_TEMPLATE } from '../config/emailTemplates.js';




export const register = async (req, res) => {
    const {name,email,password} = req.body;

    if(!name || !email || !password) {
        return res.json({success: false, message: "Missing Details"});
    }

    try{


        const exisitingUser=await userModel.findOne({email});

        if(exisitingUser){
            return res.json({success: false, message: "User already exists"});
        }

      const hashedPassword = await bcrypt.hash(password, 10);

      const user= new userModel({name,email,password: hashedPassword});
        await user.save();

        const token = jwt.sign({id: user._id}, process.env.JWT_SECRET, {expiresIn: '7d'});
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
       // sending welcome email
        const mailOptions= {
            from: process.env.SENDER_EMAIL,
            to: email,
            subject: 'Welcome GUYSs',
            text: `Welcome to website. your account has been created with email id:${email}`
        }

        await transporter.sendMail(mailOptions);

        return res.json({success: true});

    }catch(error){
        res.json({success: false, message: error.message});

    }
}

export const login = async (req, res) => {
    const {email, password} = req.body;

    if(!email || !password) {
        return res.json({success: false, message: "Email and Password are required"});
    }
    try{
        const user=await userModel.findOne({email})

        if(!user){
            return res.json({success: false, message: "Invalid email"});
        }
        const Ismatch= await bcrypt.compare(password, user.password);
        if(!Ismatch){
            return res.json({success: false, message: "Invalid password"});
        }
        const token = jwt.sign({id: user._id}, process.env.JWT_SECRET, {expiresIn: '7d'});
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        return res.json({success: true});


    } catch(error){
        res.json({success: false, message: error.message});
    }
}

export const logout = async (req, res) => {
    try{
        res.clearCookie('token', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'strict',
        });
        return res.json({success: true, message: "Logged out "});
    }catch(error){
        return res.json({success: false, message: error.message});
    }
}

//send verification OTP to the user's email
export const sendVerifyOtp = async (req, res) => {
    try{
        const {userId} = req.user;

        const user = await userModel.findById(userId);

        if(user.isAccountVerified){
            return res.json({success: false, message: "Account already verified"});
        }
       const otp=String(Math.floor(100000+Math.random()* 900000));

       user.verifyOtp = otp;
         user.verifyOtpExpireAt = Date.now() + 10 * 60 * 1000; // OTP valid for 10 minutes

       await user.save();

         const mailOptions = {
            from: process.env.SENDER_EMAIL,
            to: user.email,
            subject: 'Verify your account',
            // text: `Your verification OTP is ${otp}. It is valid for 10 minutes.`, 
            html: EMAIL_VERIFY_TEMPLATE.replace('{{email}}', user.email).replace('{{otp}}', otp)
        }


            await transporter.sendMail(mailOptions);
             res.json({success: true, message: "OTP sent to your email"});

    }catch(error){
        res.json({success: false, message: error.message});
    }
}

export const verifyEmail = async (req, res) => {
    const { otp } = req.body;
    const { userId } = req.user;

    if (!userId || !otp) {
        return res.json({ success: false, message: "Missing details" });
    }

    try {
        const user = await userModel.findById(userId);
        if (!user) {
            return res.json({ success: false, message: "User not found" });
        }

        if (user.verifyOtp === '' || user.verifyOtp !== otp) {
            return res.json({ success: false, message: "Invalid OTP" });
        }

        if (user.verifyOtpExpireAt < Date.now()) {
            return res.json({ success: false, message: "OTP expired" });
        }

        user.isAccountVerified = true;
        user.verifyOtp = '';
        user.verifyOtpExpireAt = 0;
        await user.save();

        return res.json({ success: true, message: "Email verified successfully" });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

//check user is authencticated

export const isAuthenticated = async (req, res) => {
    try{
        return res.json({success: true});

    }catch(error){
        res.json({success: false, message: error.message});
    }

}

//send password reset otp
export const sendResetOtp = async (req, res) => {
    const {email}= req.body;

    if(!email) {
        return res.json({success: false, message: "Email is required"});
    }
     
    try{
        const user= await userModel.findOne({email});
        if(!user){
            return res.json({success: false, message: "User not found"});
        }
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        user.resetOtp = otp;
        user.resetOtpExpireAt = Date.now() + 10 * 60 * 1000; // OTP valid for 10 minutes
        await user.save();
        const mailOptions = {
            from: process.env.SENDER_EMAIL,
            to: user.email,
            subject: 'Reset your password',
            // text: `Your password reset OTP is ${otp}. It is valid for 10 minutes.`,
            html: PASSWORD_RESET_TEMPLATE.replace('{{email}}', user.email).replace('{{otp}}', otp)
        };
        await transporter.sendMail(mailOptions);
        return res.json({success: true, message: "OTP sent to your email"});

    }catch(error){
        res.json({success: false, message: error.message});
    }
}

//reset user password
export const resetPassword = async (req, res) => {
    const {email, otp, newPassword} = req.body;
    if(!email || !otp || !newPassword) {
        return res.json({success: false, message: "Email, OTP and new password are required"});
    }
    try{

        const user= await userModel.findOne({email});
        if(!user){
            return res.json({success: false, message: "User not found"});
        }
        if(user.resetOtp === '' || user.resetOtp !== otp) {
            return res.json({success: false, message: "Invalid OTP"});
        }
        if(user.resetOtpExpireAt < Date.now()) {
            return res.json({success: false, message: "OTP expired"});
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.resetOtp = '';
        user.resetOtpExpireAt = 0;
        await user.save();
        return res.json({success: true, message: "Password reset successfully"});

    }catch(error){
        res.json({success: false, message: error.message});
    }

}