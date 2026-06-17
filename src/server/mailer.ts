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

export async function sendChecklistEmail(subject: string, url: string): Promise<MailResult> {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    const to = process.env.CHECKLIST_EMAIL_TO;
    if (!user || !pass || !to) return { ok: false, skipped: true };

    try {
        const transporter = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: { user, pass },
        });
        await transporter.sendMail({ from: user, to, subject, text: url });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}
