/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import * as functions from "firebase-functions/v2";
import { CallableRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as nodemailer from "nodemailer";
import * as logger from "firebase-functions/logger";
import * as dotenv from "dotenv";
// Additional type for creating org admin
interface CreateOrgAdminData {
    email: string;
    password: string;
    organizationId: string;
    organizationName: string;
    dashboardUrl?: string;
}
// Load environment variables from .env (for local development only)
dotenv.config();

// Initialize Firebase Admin
admin.initializeApp();

// Helper to get environment variables from either .env or Firebase Config
const getConfig = (key: string, defaultValue: string = ""): string => {
    // For local development, use .env
    if (process.env[key]) {
        return process.env[key] as string;
    }
    return defaultValue;
};


// Create Nodemailer transporter
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: getConfig("EMAIL_USER", "prakashkrjha04@gmail.com"),
        pass: getConfig("EMAIL_PASS", "vjheiwvpsceqffyq"),
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

interface AdminCredentialsData {
    email: string;
    password: string;
    organizationName: string;
    dashboardUrl?: string;
}

interface ApproveOrgData {
    organizationId: string;
    approved: boolean;
}

// Interface for anonymous message data
interface AnonymousMessageData {
    linkId: string;
    message: string;
    senderName: string;
}

// Simple test function with proper service account
export const helloWorld = functions.https.onRequest({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com"
}, (request, response) => {
    logger.info("Hello logs!", { structuredData: true });
    response.send("Hello from Firebase!");
});

/**
 * Send email verification OTP
 * This function sends a verification code to the user's email
 */
export const sendEmailVerification = functions.https.onCall({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com"
}, async (request: CallableRequest<EmailVerificationData>) => {
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
            from: `Tickl <${getConfig("EMAIL_USER", "your-email@gmail.com")}>`,
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
});

/**
 * Verify email OTP
 * This function verifies the OTP entered by the user
 */
export const verifyEmailOtp = functions.https.onCall({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com"
}, async (request: CallableRequest<OtpVerificationData>) => {
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
});

/**
 * Send admin credentials
 * This function sends login credentials to admin users
 */
export const sendAdminCredentials = functions.https.onCall({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com"
}, async (request: CallableRequest<AdminCredentialsData>) => {
    try {
        const { data, auth } = request;

        // Ensure the request is from an authenticated admin user
        if (!auth) {
            throw new functions.https.HttpsError(
                "unauthenticated",
                "Authentication required"
            );
        }

        // Get the caller's email
        const callerEmail = auth.token?.email;

        // Check if the caller is a super admin
        if (callerEmail !== getConfig("SUPER_ADMIN_EMAIL")) {
            // Check if they are at least an org admin
            const adminsSnapshot = await admin.firestore()
                .collection("orgAdmins")
                .where("email", "==", callerEmail)
                .limit(1)
                .get();

            if (adminsSnapshot.empty) {
                throw new functions.https.HttpsError(
                    "permission-denied",
                    "Only organization administrators can create admin accounts"
                );
            }
        }

        // Validate required data
        const { email, password, organizationName, dashboardUrl } = data;

        if (!email || !password || !organizationName) {
            throw new functions.https.HttpsError(
                "invalid-argument",
                "Missing required information"
            );
        }

        // Prepare email
        const mailOptions = {
            from: `Tickl Admin <${getConfig("EMAIL_USER")}>`,
            to: email,
            subject: `Your Admin Access to ${organizationName} on Tickl`,
            html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #3b82f6;">Tickl Organization Access</h2>
        <p>Hello,</p>
        <p>You have been granted administrator access to <strong>${organizationName}</strong> on Tickl.</p>
        <p>Here are your login credentials:</p>
        <div style="background-color: #f3f4f6; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
          <p style="margin: 5px 0;"><strong>Password:</strong> ${password}</p>
        </div>
        <p>You can access the admin dashboard here:</p>
        <p><a href="${dashboardUrl || getConfig("DASHBOARD_URL")}" style="color: #3b82f6;">${dashboardUrl || getConfig("DASHBOARD_URL")}</a></p>
        <p>For security reasons, please change your password after your first login.</p>
        <p>If you have any questions, please contact the organization owner.</p>
        <p>Thank you,</p>
        <p>The Tickl Team</p>
      </div>
    `,
        };

        // Send email
        await transporter.sendMail(mailOptions);
        logger.info("Admin credentials email sent successfully", { email });

        // Return success
        return { success: true };
    } catch (error) {
        logger.error("Error sending credentials email:", error);
        throw new functions.https.HttpsError(
            "internal",
            error instanceof Error ? error.message : "Failed to send credentials email"
        );
    }
});

/**
 * Approve Organization
 * This function is used by super admins to approve organizations on the platform
 */
export const approveOrganization = functions.https.onCall({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com"
}, async (request: CallableRequest<ApproveOrgData>) => {
    try {
        const { data, auth } = request;

        // Ensure the request is from an authenticated super admin user
        if (!auth) {
            throw new functions.https.HttpsError(
                "unauthenticated",
                "Authentication required"
            );
        }

        // Get the caller's email
        const callerEmail = auth.token?.email;

        // Check if the caller is a super admin
        if (callerEmail !== getConfig("SUPER_ADMIN_EMAIL")) {
            throw new functions.https.HttpsError(
                "permission-denied",
                "Only super administrators can approve organizations"
            );
        }

        // Validate required data
        const { organizationId, approved } = data;

        if (!organizationId) {
            throw new functions.https.HttpsError(
                "invalid-argument",
                "Missing organization ID"
            );
        }

        // Update organization's approved status
        await admin.firestore()
            .collection("organizations")
            .doc(organizationId)
            .update({
                approved: approved === true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

        // If approved, send notification to organization admin
        if (approved) {
            // Get organization details
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

            const orgData = orgDoc.data();

            // Find org admin (first one associated with this org)
            const adminsSnapshot = await admin.firestore()
                .collection("orgAdmins")
                .where("organizationId", "==", organizationId)
                .limit(1)
                .get();

            if (!adminsSnapshot.empty) {
                const adminDoc = adminsSnapshot.docs[0];
                const adminData = adminDoc.data();

                // Send approval notification
                const approvalMailOptions = {
                    from: `Tickl Admin <${getConfig("EMAIL_USER")}>`,
                    to: adminData.email,
                    subject: `Your Organization ${orgData?.name} Has Been Approved on Tickl`,
                    html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #3b82f6;">Organization Approved</h2>
            <p>Hello,</p>
            <p>Your organization <strong>${orgData?.name}</strong> has been approved on Tickl!</p>
            <p>You can now access all administration features and manage your organization's settings.</p>
            <p>Thank you for using Tickl.</p>
            <p>Best regards,</p>
            <p>The Tickl Team</p>
          </div>
        `,
                };

                await transporter.sendMail(approvalMailOptions);
                logger.info("Organization approval email sent", { organizationId });
            }
        }

        // Return success
        return { success: true };
    } catch (error) {
        logger.error("Error approving organization:", error);
        throw new functions.https.HttpsError(
            "internal",
            error instanceof Error ? error.message : "Failed to approve organization"
        );
    }
});

/**
 * Create organization admin and send credentials
 * This function creates a user in Firebase Auth and sends login credentials to the admin
 */
export const createOrgAdminAndSendCredentials = functions.https.onCall({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com"
}, async (request: CallableRequest<CreateOrgAdminData>) => {
    try {
        logger.info("Starting createOrgAdminAndSendCredentials process");
        const { data, auth } = request;

        // Log request data (excluding password for security)
        logger.info("Request data received:", {
            email: data.email ? `${data.email.split("@")[0]}***@${data.email.split("@")[1]}` : undefined,
            organizationId: data.organizationId,
            organizationName: data.organizationName,
            hasPassword: !!data.password
        });

        // Ensure the request is from an authenticated admin user
        if (!auth) {
            logger.error("Authentication missing in request");
            throw new functions.https.HttpsError(
                "unauthenticated",
                "Authentication required"
            );
        }

        // Get the caller's email
        const callerEmail = auth.token?.email;
        logger.info(`Request from user: ${callerEmail ? callerEmail.split("@")[0] + '***' : 'unknown'}`);

        // Check if the caller is a super admin - ONLY super admins should be able to create organizations
        if (callerEmail !== "ed22b059@smail.iitm.ac.in") {
            logger.error("Caller is not super admin - permission denied");
            throw new functions.https.HttpsError(
                "permission-denied",
                "Only super administrators can create organizations and organization admins"
            );
        }

        logger.info("Caller verified as super admin");


        // Validate required data
        const { email, password, organizationId, organizationName, dashboardUrl } = data;

        if (!email || !password || !organizationId || !organizationName) {
            logger.error("Missing required data", {
                hasEmail: !!email,
                hasPassword: !!password,
                hasOrgId: !!organizationId,
                hasOrgName: !!organizationName
            });
            throw new functions.https.HttpsError(
                "invalid-argument",
                "Missing required information"
            );
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            logger.error("Invalid email format");
            throw new functions.https.HttpsError(
                "invalid-argument",
                "Invalid email format"
            );
        }

        logger.info("Checking if organization exists");
        // Verify organization exists
        const orgRef = admin.firestore().collection("organizations").doc(organizationId);
        const orgDoc = await orgRef.get();

        if (!orgDoc.exists) {
            logger.error("Organization not found", { organizationId });
            throw new functions.https.HttpsError(
                "not-found",
                "Organization not found"
            );
        }
        logger.info("Organization exists", { organizationName });

        // Check if user already exists
        logger.info("Checking if user already exists");
        try {
            const userRecord = await admin.auth().getUserByEmail(email);
            if (userRecord) {
                logger.error("User already exists", { email: email.split("@")[0] + '***' });
                throw new functions.https.HttpsError(
                    "already-exists",
                    "A user with this email already exists"
                );
            }
        } catch (error: any) {
            // We expect an error if the user doesn't exist, which is what we want
            if (error.code !== 'auth/user-not-found') {
                logger.error("Unexpected error checking user existence", error);
                throw error;
            }
            logger.info("User does not exist yet, proceeding with creation");
        }

        // Create the user with Firebase Admin SDK
        logger.info("Creating new user in Firebase Auth");
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            emailVerified: false,
            disabled: false
        });

        logger.info("User created successfully", { uid: userRecord.uid });

        // Create record in orgAdmins collection
        logger.info("Creating record in orgAdmins collection");
        await admin.firestore().collection("orgAdmins").doc(userRecord.uid).set({
            email,
            organizationId,
            organizationName,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        logger.info("orgAdmins record created");

        // Update the organization with the admin
        logger.info("Updating organization with new admin");
        const orgData = orgDoc.data() || {};
        const adminUsers = orgData.adminUsers || [];

        // Add the new admin to the list if not already there
        if (!adminUsers.includes(userRecord.uid)) {
            await orgRef.update({
                adminUsers: [...adminUsers, userRecord.uid],
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            logger.info("Organization updated with new admin");
        } else {
            logger.info("Admin already in organization's adminUsers list");
        }

        // Check email configuration
        const emailUser = getConfig("EMAIL_USER", "prakashkrjha04@gmail.com");
        const emailPass = getConfig("EMAIL_PASS", "vjheiwvpsceqffyq");

        if (!emailUser || !emailPass) {
            logger.error("Email configuration missing", {
                hasEmailUser: !!emailUser,
                hasEmailPass: !!emailPass
            });

            // Return partial success since we created the user but can't send email
            return {
                success: true,
                userId: userRecord.uid,
                emailSent: false,
                emailError: "Email configuration missing"
            };
        }

        // Send email with credentials
        logger.info("Preparing to send email with credentials");
        const mailOptions = {
            from: `Tickl Admin <${emailUser}>`,
            to: email,
            subject: `Your Admin Access to ${organizationName} on Tickl`,
            html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #3b82f6;">Tickl Organization Access</h2>
        <p>Hello,</p>
        <p>You have been granted administrator access to <strong>${organizationName}</strong> on Tickl.</p>
        <p>Here are your login credentials:</p>
        <div style="background-color: #f3f4f6; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
          <p style="margin: 5px 0;"><strong>Password:</strong> ${password}</p>
        </div>
        <p>You can access the admin dashboard here:</p>
        <p><a href="${dashboardUrl || getConfig("DASHBOARD_URL", "https://tickl-dashboard.web.app")}" style="color: #3b82f6;">${dashboardUrl || getConfig("DASHBOARD_URL", "https://tickl-dashboard.web.app")}</a></p>
        <p>For security reasons, please change your password after your first login.</p>
        <p>If you have any questions, please contact the organization owner.</p>
        <p>Thank you,</p>
        <p>The Tickl Team</p>
      </div>
    `,
        };

        try {
            logger.info("Sending email", { to: email.split("@")[0] + '***' });
            await transporter.sendMail(mailOptions);
            logger.info("Admin credentials email sent successfully");
        } catch (emailError) {
            logger.error("Failed to send email, but user was created:", emailError);
            // Log email configurations (without showing the actual password)
            logger.info("Email configuration:", {
                emailUser,
                emailServiceConfigured: !!emailPass,
                transporterConfigured: !!transporter
            });

            // Still return success since the user was created
            return {
                success: true,
                userId: userRecord.uid,
                emailSent: false,
                emailError: emailError instanceof Error ? emailError.message : "Unknown email error"
            };
        }

        // Return success
        logger.info("Function completed successfully");
        return {
            success: true,
            userId: userRecord.uid,
            emailSent: true
        };
    } catch (error) {
        logger.error("Error in createOrgAdminAndSendCredentials:", error);
        throw new functions.https.HttpsError(
            "internal",
            error instanceof Error ? error.message : "Failed to create admin and send credentials"
        );
    }
});

/**
 * Generate public link on profile completion
 * This trigger watches for user profile completion and generates a public link
 */
export const generatePublicLink = functions.firestore.onDocumentUpdated({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com",
    document: "users/{userId}",
    region: "us-central1",
}, async (event) => {
    try {
        if (!event.data) {
            logger.error("Event data is undefined");
            return null;
        }

        const before = event.data.before.data();
        const after = event.data.after.data();
        const userId = event.params.userId;

        // Only trigger when profile is newly completed
        if (after.profileCompleted &&
            (!before.profileCompleted || before.profileCompleted === false) &&
            !after.publicLinkId) {

            logger.info(`Generating public link for user: ${userId}`);

            // Generate a unique ID (use a UUID library in production)
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let linkId = '';
            for (let i = 0; i < 10; i++) {
                linkId += chars.charAt(Math.floor(Math.random() * chars.length));
            }

            // Create link document
            await admin.firestore().collection('userPublicLinks').doc(linkId).set({
                userId: userId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                isActive: true,
                viewCount: 0,
                messageCount: 0
            });

            // Update user with their link ID
            await event.data.after.ref.update({
                publicLinkId: linkId,
                publicProfileEnabled: true
            });

            logger.info(`Public link generated for user ${userId}: ${linkId}`);
            return { success: true, linkId };
        }

        return null;
    } catch (error) {
        logger.error("Error generating public link:", error);
        return null;
    }
});

/**
 * Submit anonymous message
 * This function handles anonymous message submission from public profile page
 */
export const submitAnonymousMessage = functions.https.onCall({
    serviceAccount: "firebase-adminsdk-fbsvc@tickl-5c52c.iam.gserviceaccount.com"
}, async (request: CallableRequest<AnonymousMessageData>) => {
    try {
        const { linkId, message, senderName } = request.data;

        // Validate inputs
        if (!linkId || !message || !senderName) {
            throw new functions.https.HttpsError(
                "invalid-argument",
                "Missing required fields"
            );
        }

        // Look up link to find recipient
        const linkDoc = await admin.firestore().collection('userPublicLinks').doc(linkId).get();

        if (!linkDoc.exists) {
            throw new functions.https.HttpsError(
                "not-found",
                "Invalid link"
            );
        }

        const linkData = linkDoc.data() as { userId: string, isActive: boolean };

        // Check if link is active
        if (!linkData.isActive) {
            throw new functions.https.HttpsError(
                "failed-precondition",
                "This link is no longer active"
            );
        }

        // Get recipient user
        const userDoc = await admin.firestore().collection('users').doc(linkData.userId).get();

        if (!userDoc.exists) {
            throw new functions.https.HttpsError(
                "not-found",
                "Recipient user not found"
            );
        }

        // Create anonymous message
        const messageData = {
            recipientId: linkData.userId,
            senderName,
            message,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            read: false,
            linkId,
            ipAddress: request.rawRequest.ip || null
        };

        const messageRef = await admin.firestore().collection('anonymousMessages').add(messageData);

        // Increment message count on the link
        await linkDoc.ref.update({
            messageCount: admin.firestore.FieldValue.increment(1),
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });

        logger.info(`Anonymous message sent to user ${linkData.userId} via link ${linkId}`);

        return {
            success: true,
            messageId: messageRef.id
        };
    } catch (error) {
        logger.error("Error submitting anonymous message:", error);
        throw new functions.https.HttpsError(
            "internal",
            error instanceof Error ? error.message : "Failed to submit message"
        );
    }
});