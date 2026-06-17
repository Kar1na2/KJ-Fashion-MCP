import type { InventoryCell } from "../shared.js";

// ---------------------------------------------------------------------------
// Restock checklist.
//
// On confirm, Silver stores the weekly difference max(0, FULL_STOCK - count) per
// cell — which is exactly how many units that cell needs to be refilled back to
// baseline. This module turns those differences into an ordered checklist and
// pushes it to Google Tasks as a checkable to-do list.
//
// The confirm `cells` still carry the RAW remaining count (the same value
// confirmScan converts), so we re-derive the refill the same way here to keep a
// single source of truth for the arithmetic.
// ---------------------------------------------------------------------------

export interface RestockItem {
    color: string | null;
    style_code: string | null;
    waist: number;
    inseam: number; // length
    refill: number; // units to restock = max(0, FULL_STOCK - count)
}

// Build the restock checklist from confirmed cells. Items with nothing to refill
// are dropped. Ordered grouped by color, then waist shortest→longest, then
// inseam shortest→longest, so the to-do list reads cleanly by section.
export function buildRestockList(cells: InventoryCell[], fullStock: number): RestockItem[] {
    const items: RestockItem[] = [];
    for (const c of cells) {
        const refill = Math.max(0, fullStock - Number(c.quantity));
        if (refill <= 0) continue;
        items.push({
            color: c.color,
            style_code: c.style_code,
            waist: Number(c.waist),
            inseam: Number(c.inseam),
            refill,
        });
    }

    items.sort((a, b) => {
        const color = (a.color ?? "").localeCompare(b.color ?? "");
        if (color !== 0) return color;
        if (a.waist !== b.waist) return a.waist - b.waist; // shortest waist first
        return a.inseam - b.inseam; // then shortest inseam first
    });

    return items;
}

// One task line per item, e.g. "D. Blue 5141325 · W30 · inseam 30 — refill 2".
export function formatTaskTitle(item: RestockItem): string {
    const color = item.color ?? "(no color)";
    const style = item.style_code ?? "(no code)";
    return `${color} ${style} · W${item.waist} · inseam ${item.inseam} — refill ${item.refill}`;
}

// ---------------------------------------------------------------------------
// Google Tasks delivery.
//
// Uses an installed-app OAuth2 refresh token (no per-request user consent): we
// trade the refresh token for a short-lived access token, create a fresh task
// list for the week, and insert each checklist item as a task. Configured via
// .env; if the credentials are missing we skip silently so inventory entry never
// depends on Google being set up.
//
// Required scope on the refresh token: https://www.googleapis.com/auth/tasks
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

export interface RestockSendResult {
    ok: boolean;
    skipped?: boolean; // true when Google Tasks isn't configured
    count: number; // tasks created
    listId?: string;
    listTitle?: string;
    error?: string;
}

function googleConfig() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken };
}

async function getAccessToken(cfg: NonNullable<ReturnType<typeof googleConfig>>): Promise<string> {
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            refresh_token: cfg.refreshToken,
            grant_type: "refresh_token",
        }),
    });
    if (!res.ok) {
        throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("Google token exchange returned no access_token");
    return json.access_token;
}

// Create a new task list whose tasks are the restock items, in checklist order.
// Returns a result object — never throws — so the caller can keep confirm
// non-blocking and just surface a warning when delivery fails.
export async function sendRestockTasks(
    listTitle: string,
    items: RestockItem[]
): Promise<RestockSendResult> {
    const cfg = googleConfig();
    if (!cfg) {
        return { ok: false, skipped: true, count: 0 };
    }
    if (items.length === 0) {
        return { ok: true, count: 0, listTitle };
    }

    try {
        const token = await getAccessToken(cfg);
        const authHeaders = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        };

        const listRes = await fetch(`${TASKS_API}/users/@me/lists`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ title: listTitle }),
        });
        if (!listRes.ok) {
            throw new Error(`create list failed (${listRes.status}): ${await listRes.text()}`);
        }
        const list = (await listRes.json()) as { id: string };

        // Insert sequentially, threading `previous` so the API preserves our
        // color → waist → inseam ordering instead of stacking newest-on-top.
        let previous: string | undefined;
        let created = 0;
        for (const item of items) {
            const url = new URL(`${TASKS_API}/lists/${list.id}/tasks`);
            if (previous) url.searchParams.set("previous", previous);
            const taskRes = await fetch(url, {
                method: "POST",
                headers: authHeaders,
                body: JSON.stringify({ title: formatTaskTitle(item) }),
            });
            if (!taskRes.ok) {
                throw new Error(`insert task failed (${taskRes.status}): ${await taskRes.text()}`);
            }
            const task = (await taskRes.json()) as { id: string };
            previous = task.id;
            created++;
        }

        return { ok: true, count: created, listId: list.id, listTitle };
    } catch (err) {
        return { ok: false, count: 0, listTitle, error: (err as Error).message };
    }
}
