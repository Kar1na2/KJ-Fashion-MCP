import nodemailer from "nodemailer";

// ---------------------------------------------------------------------------
// Gmail delivery.
//
// Sends the checklist URL via Gmail SMTP. Gmail requires an App Password (2FA
// must be on) — the normal account password won't authenticate over SMTP. With
// the creds or recipient unset we skip silently.
//
// Subject is the week range + "Inventory Checklist"; the body is the URL only.
// ---------------------------------------------------------------------------

export interface MailResult {
    ok: boolean;
    skipped?: boolean;
    error?: string;
}

// Result of the startup connectivity check.
export interface VerifyResult {
    configured: boolean; // creds present in .env
    ok: boolean; // reachable + authenticated
    detail?: string;
    error?: string;
}

function gmailAuth() {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) return null;
    return { user, pass };
}

function buildTransport(auth: { user: string; pass: string }) {
    return nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth,
    });
}

export async function sendChecklistEmail(subject: string, url: string): Promise<MailResult> {
    const auth = gmailAuth();
    const to = process.env.CHECKLIST_EMAIL_TO;
    if (!auth || !to) return { ok: false, skipped: true };

    try {
        await buildTransport(auth).sendMail({ from: auth.user, to, subject, text: url });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

// Startup check: confirm the SMTP credentials actually authenticate (without
// sending anything) via transporter.verify(). Also flags a missing recipient,
// since sends would silently skip without CHECKLIST_EMAIL_TO.
export async function verifyGmail(): Promise<VerifyResult> {
    const auth = gmailAuth();
    if (!auth) return { configured: false, ok: false };

    try {
        await buildTransport(auth).verify();
        const to = process.env.CHECKLIST_EMAIL_TO;
        const detail = to
            ? `${auth.user} → ${to}`
            : `${auth.user} (no CHECKLIST_EMAIL_TO set — emails will skip)`;
        return { configured: true, ok: true, detail };
    } catch (err) {
        return { configured: true, ok: false, error: (err as Error).message };
    }
}
