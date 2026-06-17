import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { initDb, insertBronze, confirmScan, getDb, getWeeklyTrend, getMonthlyTrend, getYearlyTrend, getStyleHistory, listStyles, listWeeks, getWeekDetail, getScanImage, deleteWeek, FULL_STOCK } from "./db.js";
import "dotenv/config";
import { extractSheet, testClaude } from "./extractor.js";
import { buildRestockList } from "./restock.js";
import { createChecklistPage, verifyNotion } from "./notion.js";
import { sendChecklistEmail, verifyGmail } from "./mailer.js";
import type { ConfirmRequest } from "../shared.js";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, extname } from "node:path";
import { DuckDBValue } from "@duckdb/node-api";
import type { Request, Response, NextFunction } from "express";

const app = express();
const PORT = 8787;
const BRONZE_DIR = "data/bronze";

app.use(express.json({ limit: "10mb" }));

mkdirSync(resolve(BRONZE_DIR), { recursive: true });

// Configure multer to keep the uploaded file in memory (as a Buffer of bytes)
// rather than auto-saving it. We want control over where/how it's saved.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, 
});

app.get("/api/ping", (req, res) => {
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auth — a single set of operator credentials supplied via .env. On success we
// hand out an in-memory session token (lost on restart, which is fine for a
// small internal tool). Every /api route below the requireAuth middleware needs
// it, as a `Bearer` header or a `?token=` query param (so <img> tags work too).
// ---------------------------------------------------------------------------
const APP_USER = process.env.APP_USER;
const APP_PASS = process.env.APP_PASS;
const sessions = new Set<string>();

function tokenFrom(req: Request): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice(7);
    if (typeof req.query.token === "string") return req.query.token;
    return null;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
    const token = tokenFrom(req);
    if (token && sessions.has(token)) return next();
    return res.status(401).json({ error: "Unauthorized — please log in." });
}

app.post("/api/login", (req, res) => {
    if (!APP_USER || !APP_PASS) {
        return res.status(500).json({ error: "Server credentials not configured — set APP_USER and APP_PASS in .env" });
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (username === APP_USER && password === APP_PASS) {
        const token = nanoid(32);
        sessions.add(token);
        return res.json({ ok: true, token });
    }
    return res.status(401).json({ error: "Invalid username or password" });
});

app.post("/api/logout", (req, res) => {
    const token = tokenFrom(req);
    if (token) sessions.delete(token);
    res.json({ ok: true });
});

// Everything past this line requires a valid session.
app.use("/api", requireAuth);

// The `upload.single("image")` part is multer middleware. It runs BEFORE your
// handler, finds the file in the form field named "image", and attaches it as req.file.
app.post("/api/extract", upload.single("image"), async (req, res) => {
    try {
        // multer gives us req.file, but only if a file was actually sent. Always check.
        if (!req.file) {
            return res.status(400).json({ error: "No image uploaded" });
        }

        const scanId = nanoid();
        const ext = (extname(req.file.originalname) || ".jpg").toLowerCase();
        const isPng = ext === ".png" || req.file.mimetype === "image/png";
        const fileName = `${scanId}${isPng ? ".png" : ".jpg"}`;

        writeFileSync(resolve(BRONZE_DIR, fileName), req.file.buffer);

        await insertBronze(scanId, fileName);

        const base64 = req.file.buffer.toString("base64");
        const mediaType = isPng ? "image/png" : "image/jpeg";

        console.log("[extract] calling Claude");
        const extraction = await extractSheet(base64, mediaType);
        console.log("[extract] result:", JSON.stringify(extraction, null, 2));

        res.json({ ok: true, scan_id: scanId, extraction });
    } catch (err) {
        console.error("[extract] error:", err);
        res.status(500).json({ error: (err as Error).message });
    }
});

app.post("/api/confirm", async (req, res) => {
    try {
        const body = req.body as ConfirmRequest;

        if (!body.scan_id || !Array.isArray(body.cells)) {
            return res.status(400).json({ error: "scan_id and cells[] are required" });
        }

        const iso = body.sheet_date;
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || isNaN(Date.parse(iso))) {
            return res.status(400).json({ error: "A valid sheet_date (YYYY-MM-DD) is required" });
        }

        // Inventory is counted every Saturday. Reject anything else outright
        // rather than silently snapping to a nearby Saturday.
        if (new Date(`${iso}T00:00:00Z`).getUTCDay() !== 6) {
            return res.status(400).json({ error: "sheet_date must be a Saturday — inventory is counted weekly on Saturdays" });
        }

        const stored = await confirmScan(body);

        // Compile the refill checklist from the same differences Silver stores,
        // publish it to Notion and email the public link. Non-blocking: the
        // inventory is already committed, so a Notion/Gmail outage just yields a
        // warning the operator sees on the success screen.
        const items = buildRestockList(body.cells, (c) => FULL_STOCK - Number(c.quantity));
        const checklist = await publishAndEmailChecklist(weekRangeLabel(iso), items);

        res.json({ ok: true, rows_stored: stored, checklist });
    } catch (err) {
        console.error("[confirm] error:" , err);
        res.status(500).json({ error: (err as Error).message });
    }
});

// "MM-DD-YYYY → MM-DD-YYYY" from the count Saturday: the week runs from the
// Sunday it began (Saturday - 6 days) through the Saturday it was counted.
function weekRangeLabel(countSaturdayIso: string): string {
    const sat = new Date(`${countSaturdayIso}T00:00:00Z`);
    const sun = new Date(sat);
    sun.setUTCDate(sun.getUTCDate() - 6);
    const us = (d: Date) => {
        const [y, m, dd] = d.toISOString().slice(0, 10).split("-");
        return `${m}-${dd}-${y}`;
    };
    return `${us(sun)} → ${us(sat)}`;
}

// Build the Notion page and email its public URL. Returns the combined result so
// the success screen can report exactly what happened. Never throws.
async function publishAndEmailChecklist(weekRange: string, items: ReturnType<typeof buildRestockList>) {
    const subject = `${weekRange} Inventory Checklist`;

    const notion = await createChecklistPage(subject, items);
    if (notion.skipped) console.log("[checklist] Notion not configured — skipping page creation");
    else if (!notion.ok) console.error(`[checklist] Notion failed: ${notion.error}`);

    // No URL means nothing to email (skipped, failed, or nothing to refill).
    if (!notion.url) return { notion, mail: { ok: false, skipped: true as const }, url: undefined };

    const mail = await sendChecklistEmail(subject, notion.url);
    if (mail.skipped) console.log("[checklist] Gmail not configured — link created but not emailed");
    else if (mail.ok) console.log(`[checklist] emailed ${subject}: ${notion.url}`);
    else console.error(`[checklist] email failed: ${mail.error}`);

    return { notion, mail, url: notion.url };
}

app.get("/api/scans", async (req, res) => {
    const db = getDb();
    const reader = await db.runAndReadAll("SELECT * FROM bronze_scans ORDER BY ingested_at");

    function fix(rows: Record<string, DuckDBValue>[]) {
        return JSON.parse(JSON.stringify(rows, (_, v) =>
            typeof v === "bigint" ? Number(v) : v
        ));
    }
    res.json(fix(reader.getRowObjects()));
});

app.get("/api/trend/weekly", async (req, res) => {
    try {
        const { start_date, end_date } = req.query;
        if (!start_date || !end_date) return res.status(400).json({ error: "start_date and end_date query params required" });
        res.json(await getWeeklyTrend(start_date as string, end_date as string));
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/trend/monthly/:year/:month", async (req, res) => {
    try {
        const year = Number(req.params.year);
        const month = Number(req.params.month);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12)
            return res.status(400).json({ error: "year and month (1-12) must be valid numbers" });
        res.json(await getMonthlyTrend(year, month));
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/trend/:year", async (req, res) => {
    try {
        const year = Number(req.params.year);
        if (!Number.isInteger(year)) return res.status(400).json({ error: "year must be a number"});
        res.json(await getYearlyTrend(year));
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/style/:code", async (req, res) => {
    try {
        res.json(await getStyleHistory(req.params.code));
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/styles", async (req, res) => {
    try {
        res.json(await listStyles());
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// ---------------------------------------------------------------------------
// Records — list stored weeks, view one, edit it, delete it. Used by the
// operator-facing management UI.
// ---------------------------------------------------------------------------

app.get("/api/weeks", async (req, res) => {
    try {
        res.json(await listWeeks());
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/api/weeks/:scanId", async (req, res) => {
    try {
        const detail = await getWeekDetail(req.params.scanId);
        if (!detail) return res.status(404).json({ error: "Week not found" });
        res.json(detail);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// Edit a stored week. Body matches the intake confirm payload — cells carry the
// raw remaining count and confirmScan re-derives the units-sold difference, so a
// correction here behaves exactly like re-confirming the sheet.
app.put("/api/weeks/:scanId", async (req, res) => {
    try {
        const body = { ...(req.body as ConfirmRequest), scan_id: req.params.scanId };

        if (!Array.isArray(body.cells)) {
            return res.status(400).json({ error: "cells[] are required" });
        }

        const existing = await getScanImage(req.params.scanId);
        if (!existing) return res.status(404).json({ error: "Week not found" });

        const iso = body.sheet_date;
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || isNaN(Date.parse(iso))) {
            return res.status(400).json({ error: "A valid sheet_date (YYYY-MM-DD) is required" });
        }
        if (new Date(`${iso}T00:00:00Z`).getUTCDay() !== 6) {
            return res.status(400).json({ error: "sheet_date must be a Saturday — inventory is counted weekly on Saturdays" });
        }

        const stored = await confirmScan(body);
        res.json({ ok: true, rows_stored: stored });
    } catch (err) {
        console.error("[weeks:put] error:", err);
        res.status(500).json({ error: (err as Error).message });
    }
});

app.delete("/api/weeks/:scanId", async (req, res) => {
    try {
        const img = await deleteWeek(req.params.scanId);
        if (img) {
            const path = resolve(BRONZE_DIR, img);
            if (existsSync(path)) unlinkSync(path);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error("[weeks:delete] error:", err);
        res.status(500).json({ error: (err as Error).message });
    }
});

// Serve the raw bronze scan for a week. Auth is enforced by requireAuth above
// (via the ?token= query param, since this URL is loaded by an <img> tag).
app.get("/api/scans/:scanId/image", async (req, res) => {
    try {
        const img = await getScanImage(req.params.scanId);
        if (!img) return res.status(404).json({ error: "Scan not found" });
        const path = resolve(BRONZE_DIR, img);
        if (!existsSync(path)) return res.status(404).json({ error: "Image file missing" });
        res.sendFile(path);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// Probe every external API we depend on at startup so misconfiguration shows up
// immediately in the dev console rather than at confirm time. Non-blocking: a
// failed/unconfigured integration logs a warning but the server still starts
// (these features skip gracefully when unconfigured).
async function checkIntegrations() {
    console.log("[startup] checking integrations…");

    // Claude — sheet extraction.
    try {
        const msg = await testClaude();
        console.log(`[startup] Claude:  ✓ ${msg.trim()}`);
    } catch (err) {
        console.warn(`[startup] Claude:  ✗ ${(err as Error).message}`);
    }

    // Notion — checklist page.
    const notion = await verifyNotion();
    if (!notion.configured) console.log("[startup] Notion:  – not configured (checklist page will skip)");
    else if (notion.ok) console.log(`[startup] Notion:  ✓ ${notion.detail}`);
    else console.warn(`[startup] Notion:  ✗ ${notion.error}`);

    // Gmail — emails the checklist link.
    const gmail = await verifyGmail();
    if (!gmail.configured) console.log("[startup] Gmail:   – not configured (checklist email will skip)");
    else if (gmail.ok) console.log(`[startup] Gmail:   ✓ SMTP auth OK (${gmail.detail})`);
    else console.warn(`[startup] Gmail:   ✗ ${gmail.error}`);
}

await initDb();
await checkIntegrations();

app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
});