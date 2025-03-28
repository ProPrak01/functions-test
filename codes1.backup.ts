
/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// Load environment variables from .env file
import * as dotenv from "dotenv";
dotenv.config();

import * as functions from "firebase-functions/v2";
import { CallableRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as nodemailer from "nodemailer";
import * as logger from "firebase-functions/logger";

// Initialize Firebase Admin
admin.initializeApp();

// Log environment variables availability (without showing actual values)
logger.info(`Email configuration: ${process.env.EMAIL_USER ? "Available" : "Missing"}`);

// Create Nodemailer transporter (using Gmail)
// NOTE: For production, consider using a dedicated email service like SendGrid
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER || "your-email@gmail.com", // Set this in functions config
        pass: process.env.EMAIL_PASS || "your-app-password", // Set this in functions config
    },
});

// Define types for the function parameters
interface EmailVerificationData {
    email: string;
    organizationId: string;
}

interface OtpVerificationData {
    otp: string;
}

/**
 * Send email verification OTP
 * This function sends a verification code to the user's email
 */
export const sendEmailVerification = functions.https.onCall(
    async (request: CallableRequest<EmailVerificationData>) => {
        try {
            // Check if user is authenticated
            if (!request.auth) {
                throw new functions.https.HttpsError(
                    "unauthenticated",
                    "User must be authenticated"
                );
            }

            const { email, organizationId } = request.data;
            const userId = request.auth.uid;

            // Validate input
            if (!email || !organizationId) {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    "Email and organization ID are required"
                );
            }

            // Validate email format
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    "Invalid email format"
                );
            }

            logger.info(`Sending email verification to ${email.split("@")[0]}***`);

            // Verify email domain belongs to organization
            const orgDoc = await admin.firestore()
                .collection("organizations")
                .doc(organizationId)
                .get();

            if (!orgDoc.exists) {
                throw new functions.https.HttpsError(
                    "not-found",
                    "Organization not found"
                );
            }

            const organization = orgDoc.data() as { domain: string, name: string };
            const emailDomain = email.split("@")[1].toLowerCase();
            const orgDomain = organization.domain.toLowerCase();

            // Check if email domain matches organization domain
            if (emailDomain !== orgDomain) {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    `Email domain does not match ${organization.name}'s domain (${orgDomain})`
                );
            }

            // Generate 4-digit OTP
            const otp = Math.floor(1000 + Math.random() * 9000).toString();

            // Store OTP in Firestore with expiration (15 minutes)
            const expiresAt = admin.firestore.Timestamp.fromDate(
                new Date(Date.now() + 15 * 60 * 1000)
            );

            // Store verification data
            await admin.firestore()
                .collection("emailVerifications")
                .doc(userId)
                .set({
                    email,
                    otp,
                    organizationId,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt,
                    verified: false,
                });

            // Send email with OTP
            const mailOptions = {
                from: `Tickl <${process.env.EMAIL_USER || "your-email@gmail.com"}>`,
                to: email,
                subject: "Verify Your Company Email",
                html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Verify Your Company Email</h2>
          <p>Your verification code is: <strong>${otp}</strong></p>
          <p>This code will expire in 15 minutes.</p>
          <p>If you didn't request this code, please ignore this email.</p>
        </div>
      `,
            };

            await transporter.sendMail(mailOptions);
            logger.info(`Email verification sent to ${email.split("@")[0]}***`);

            return { success: true };
        } catch (error) {
            logger.error("Error sending email verification:", error);
            throw new functions.https.HttpsError(
                "internal",
                error instanceof Error ? error.message : "Failed to send verification email"
            );
        }
    }
);

/**
 * Verify email OTP
 * This function verifies the OTP entered by the user
 */
export const verifyEmailOtp = functions.https.onCall(
    async (request: CallableRequest<OtpVerificationData>) => {
        try {
            // Check if user is authenticated
            if (!request.auth) {
                throw new functions.https.HttpsError(
                    "unauthenticated",
                    "User must be authenticated"
                );
            }

            const { otp } = request.data;
            const userId = request.auth.uid;

            // Validate input
            if (!otp) {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    "Verification code is required"
                );
            }

            logger.info(`Verifying email OTP for user ${userId}`);

            // Get verification record
            const verificationDoc = await admin.firestore()
                .collection("emailVerifications")
                .doc(userId)
                .get();

            if (!verificationDoc.exists) {
                throw new functions.https.HttpsError(
                    "not-found",
                    "Verification record not found. Please request a new code."
                );
            }

            const verification = verificationDoc.data() as {
                email: string;
                otp: string;
                expiresAt: admin.firestore.Timestamp;
                organizationId: string;
            };

            // Check if expired
            const now = admin.firestore.Timestamp.now();
            if (verification.expiresAt.toMillis() < now.toMillis()) {
                throw new functions.https.HttpsError(
                    "deadline-exceeded",
                    "Verification code has expired. Please request a new code."
                );
            }

            // Check OTP
            if (verification.otp !== otp) {
                throw new functions.https.HttpsError(
                    "invalid-argument",
                    "Invalid verification code"
                );
            }

            // Mark as verified
            await admin.firestore()
                .collection("emailVerifications")
                .doc(userId)
                .update({
                    verified: true,
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

            // Update user profile
            await admin.firestore()
                .collection("users")
                .doc(userId)
                .update({
                    companyEmail: verification.email,
                    companyEmailVerified: true,
                });

            logger.info(`Email verified successfully for ${verification.email.split("@")[0]}***`);

            return {
                success: true,
                email: verification.email,
            };
        } catch (error) {
            logger.error("Error verifying email:", error);
            throw new functions.https.HttpsError(
                "internal",
                error instanceof Error ? error.message : "Failed to verify email"
            );
        }
    }
);
