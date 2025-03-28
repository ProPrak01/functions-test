/**
 * Import function triggers from their respective submodules
 */
import * as functions from "firebase-functions/v2";
import { CallableRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as nodemailer from "nodemailer";
import * as logger from "firebase-functions/logger";
import * as dotenv from "dotenv";

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

    // For production, use Firebase Config
    try {
        // Parse the key path (e.g., "EMAIL_USER" -> ["email", "user"])
        const parts = key.toLowerCase().split("_");
        if (parts.length === 2) {
            const [namespace, field] = parts;
            const config = functions.config();
            if (!config || !config[namespace]) {
                logger.warn(`Config not found for ${namespace}.${field}, using default`);
                return defaultValue;
            }
            return config[namespace][field] || defaultValue;
        }
        return defaultValue;
    } catch (error) {
        logger.warn(`Failed to get config for ${key}`, error);
        return defaultValue;
    }
};

// Define types for the function parameters
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

// Create Nodemailer transporter
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: getConfig("EMAIL_USER", "your-email@gmail.com"),
        pass: getConfig("EMAIL_PASS", "app-password"),
    },
});

// Send admin credentials
export const sendAdminCredentials = functions.https.onCall(
    async (request: CallableRequest<AdminCredentialsData>) => {
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
    }
);

// Cloud function to approve an organization
export const approveOrganization = functions.https.onCall(
    async (request: CallableRequest<ApproveOrgData>) => {
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
    }
);
