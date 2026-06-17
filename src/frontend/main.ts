import "./style.css";
import type { ExtractionResult, ExtractionSection, InventoryCell, ConfirmRequest } from "../shared";

interface ExtractResponse {
    ok: boolean;
    scan_id: string;
    extraction: ExtractionResult;
}

const FULL_STOCK = 3;

let current: ExtractResponse | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;

/* ---------------------------------------------------------------------------
   Session token. The whole app sits behind a single operator login; the token
   is kept in localStorage and attached to every API call via authFetch.
--------------------------------------------------------------------------- */
const TOKEN_KEY = "kj_token";
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
    const token = getToken();
    const headers = new Headers(opts.headers ?? {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
        clearToken();
        renderLogin();
        throw new Error("Session expired — please log in again.");
    }
    return res;
}

/* Reusable masthead so every screen shares the same header. */
function masthead(sub: string): string {
    return `
        <header class="masthead">
            <p class="kicker">ILLB · Atelier Intake</p>
            <h1>K.J. Fashion <em>Inventory</em></h1>
            <span class="sub">${sub}</span>
        </header>
    `;
}

/* Top navigation, shown on every authenticated screen. */
function navBar(active: "records" | "intake"): string {
    return `
        <nav class="topnav">
            <button class="navlink ${active === "records" ? "active" : ""}" data-nav="records">Records</button>
            <button class="navlink ${active === "intake" ? "active" : ""}" data-nav="intake">New intake</button>
            <button class="navlink logout" data-nav="logout">Log out</button>
        </nav>
    `;
}

function wireNav() {
    document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((b) => {
        b.addEventListener("click", () => {
            const n = b.dataset.nav;
            if (n === "records") renderLedger();
            else if (n === "intake") renderUpload();
            else if (n === "logout") logout();
        });
    });
}

async function logout() {
    try {
        await authFetch("/api/logout", { method: "POST" });
    } catch {
        /* ignore — we clear the token regardless */
    }
    clearToken();
    renderLogin();
}

/* ---------------------------------------------------------------------------
   Date helpers. Silver keys a week by the Sunday it began; the sheet is counted
   the following Saturday (Sunday + 6 days). The intake/edit date pickers work in
   Saturdays; the records list shows the full "Sunday → Saturday" span.
--------------------------------------------------------------------------- */
function isSaturday(iso: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const d = new Date(`${iso}T00:00:00Z`);
    if (isNaN(d.getTime())) return false;
    return d.getUTCDay() === 6;
}

function addDays(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${m}-${d}-${y}`;
}

/* sheet_date is the week-start Sunday; show it through to its count Saturday. */
function weekRange(sundayIso: string): string {
    return `${fmtDate(sundayIso)} → ${fmtDate(addDays(sundayIso, 6))}`;
}

function flattenSections(ex: ExtractionResult): InventoryCell[] {
    const flat: InventoryCell[] = [];
    for (const section of ex.sections ?? []) {
        for (const c of section.cells) {
            flat.push({
                style_code: section.style_code,
                color: section.color,
                waist: c.waist,
                inseam: c.inseam,
                quantity: c.quantity,
                confidence: c.confidence,
            });
        }
    }
    return flat;
}

/* ===========================================================================
   LOGIN
=========================================================================== */
function renderLogin() {
    current = null;
    app.innerHTML = `
        ${masthead("Sign in")}
        <div class="card login-card">
            <p class="kicker">Restricted</p>
            <h2>Staff sign-in</h2>
            <p class="lede">Enter the credentials provided to manage inventory records and intake.</p>
            <form id="login-form" class="login-form">
                <label>Username
                    <input id="login-user" type="text" autocomplete="username" />
                </label>
                <label>Password
                    <input id="login-pass" type="password" autocomplete="current-password" />
                </label>
                <div class="actions">
                    <button class="primary" type="submit" id="login-btn">Sign in</button>
                </div>
                <div id="login-msg"></div>
            </form>
        </div>
    `;

    const form = document.querySelector<HTMLFormElement>("#login-form")!;
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = (document.querySelector("#login-user") as HTMLInputElement).value.trim();
        const password = (document.querySelector("#login-pass") as HTMLInputElement).value;
        const msg = document.querySelector<HTMLDivElement>("#login-msg")!;
        const btn = document.querySelector<HTMLButtonElement>("#login-btn")!;

        msg.className = "busy";
        msg.textContent = "Signing in…";
        btn.disabled = true;

        try {
            const res = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? "Sign-in failed");
            const out = await res.json();
            setToken(out.token);
            renderLedger();
        } catch (err) {
            msg.className = "err";
            msg.textContent = (err as Error).message;
            btn.disabled = false;
        }
    });
}

/* ===========================================================================
   RECORDS — list of stored weeks (homepage after login)
=========================================================================== */
interface WeekRow {
    scan_id: string;
    sheet_date: string;
    fashion_line: string | null;
    line_count: number;
    total_sold: number;
}

function ledgerRow(w: WeekRow): string {
    const label = weekRange(w.sheet_date);
    return `
        <tr class="ledger-row">
            <td><a class="week-link" data-open="${w.scan_id}">${label}</a></td>
            <td>${w.fashion_line ?? "—"}</td>
            <td class="num">${w.line_count}</td>
            <td class="num">${w.total_sold}</td>
            <td class="row-actions">
                <button class="mini" data-edit="${w.scan_id}">Edit</button>
                <button class="mini danger" data-delete="${w.scan_id}" data-label="${label}">Delete</button>
            </td>
        </tr>
    `;
}

async function renderLedger() {
    if (!getToken()) return renderLogin();

    app.innerHTML = `
        ${masthead("Records")}
        ${navBar("records")}
        <p class="lede">Every stored inventory week. Open a week for a clean view and its raw scan, or correct/remove an entry.</p>
        <div class="card">
            <div id="ledger-body" class="busy">Loading records…</div>
        </div>
    `;
    wireNav();

    try {
        const res = await authFetch("/api/weeks");
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load records");
        const weeks: WeekRow[] = await res.json();
        const body = document.querySelector<HTMLDivElement>("#ledger-body")!;
        body.className = "";

        if (!weeks.length) {
            body.innerHTML = `<p class="empty">No inventory weeks stored yet. Use <b>New intake</b> to add one.</p>`;
            return;
        }

        body.innerHTML = `
            <div class="table-wrap">
                <table class="ledger">
                    <thead>
                        <tr><th>Week (count Saturday)</th><th>Line</th><th>Lines</th><th>Units sold</th><th></th></tr>
                    </thead>
                    <tbody>${weeks.map(ledgerRow).join("")}</tbody>
                </table>
            </div>
        `;

        body.querySelectorAll<HTMLElement>("[data-open]").forEach((el) =>
            el.addEventListener("click", () => renderDetail(el.dataset.open!))
        );
        body.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) =>
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                renderEdit(b.dataset.edit!);
            })
        );
        body.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((b) =>
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                deleteWeek(b.dataset.delete!, b.dataset.label!);
            })
        );
    } catch (err) {
        const body = document.querySelector<HTMLDivElement>("#ledger-body");
        if (body) {
            body.className = "err";
            body.textContent = (err as Error).message;
        }
    }
}

async function deleteWeek(scanId: string, label: string) {
    const ok = window.confirm(
        `Delete the inventory record for ${label}?\n\nThis removes its rows and the stored scan image. This cannot be undone.`
    );
    if (!ok) return;
    try {
        const res = await authFetch(`/api/weeks/${scanId}`, { method: "DELETE" });
        if (!res.ok) throw new Error((await res.json()).error ?? "Delete failed");
        renderLedger();
    } catch (err) {
        window.alert((err as Error).message);
    }
}

/* ===========================================================================
   RECORD DETAIL — clean view of units sold + the raw bronze scan
=========================================================================== */
interface DetailCell {
    sheet_date: string;
    fashion_line: string | null;
    style_code: string | null;
    color: string | null;
    waist: number;
    inseam: number;
    quantity: number;
    confidence: number;
}
interface WeekDetail {
    scan: { scan_id: string };
    cells: DetailCell[];
}

async function renderDetail(scanId: string) {
    if (!getToken()) return renderLogin();

    app.innerHTML = `
        ${masthead("Record")}
        ${navBar("records")}
        <div class="card">
            <div id="detail-body" class="busy">Loading…</div>
        </div>
    `;
    wireNav();

    try {
        const res = await authFetch(`/api/weeks/${scanId}`);
        if (!res.ok) throw new Error((await res.json()).error ?? "Not found");
        renderDetailBody(await res.json());
    } catch (err) {
        const body = document.querySelector<HTMLDivElement>("#detail-body");
        if (body) {
            body.className = "err";
            body.textContent = (err as Error).message;
        }
    }
}

function renderDetailBody(data: WeekDetail) {
    const { scan, cells } = data;
    const sheetDate = cells[0]?.sheet_date;
    const label = sheetDate ? weekRange(sheetDate) : "—";
    const line = cells[0]?.fashion_line ?? "—";
    const totalSold = cells.reduce((a, c) => a + Number(c.quantity), 0);

    const rows = cells
        .map(
            (c) => `
            <tr>
                <td>${c.style_code ?? "—"}</td>
                <td>${c.color ?? "—"}</td>
                <td>W${c.waist}</td>
                <td>${c.inseam}</td>
                <td class="num">${c.quantity}</td>
            </tr>`
        )
        .join("");

    const imgSrc = `/api/scans/${scan.scan_id}/image?token=${encodeURIComponent(getToken()!)}`;

    const body = document.querySelector<HTMLDivElement>("#detail-body")!;
    body.className = "";
    body.innerHTML = `
        <div class="review-head">
            <h2>Week ${label}</h2>
            <span class="meta-pill">Line <b>${line}</b></span>
            <span class="meta-pill">Units sold <b>${totalSold}</b></span>
        </div>
        <div class="detail-grid">
            <div class="detail-table">
                <div class="table-wrap">
                    <table class="grid">
                        <thead><tr><th>Style</th><th>Color</th><th>Waist</th><th>Inseam</th><th>Units sold</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
            <figure class="bronze">
                <a href="${imgSrc}" target="_blank" rel="noopener">
                    <img src="${imgSrc}" alt="Scanned size sheet for ${label}" />
                </a>
                <figcaption>Raw bronze scan stored for this week</figcaption>
            </figure>
        </div>
        <div class="actions">
            <button class="primary" id="detail-edit">Edit this week</button>
            <button class="ghost" id="detail-back">Back to records</button>
        </div>
    `;

    document.querySelector("#detail-edit")!.addEventListener("click", () => renderEdit(scan.scan_id));
    document.querySelector("#detail-back")!.addEventListener("click", renderLedger);
}

/* ===========================================================================
   EDIT — correct a stored week. Values are the remaining sheet count
   (units sold = FULL_STOCK − count), so they line up with the raw scan shown
   alongside. The backend re-derives the stored difference on save.
=========================================================================== */
interface EditSection {
    style: string | null;
    color: string | null;
    cells: { waist: number; inseam: number; count: number }[];
}

async function renderEdit(scanId: string) {
    if (!getToken()) return renderLogin();

    app.innerHTML = `
        ${masthead("Edit")}
        ${navBar("records")}
        <div class="card">
            <div id="edit-body" class="busy">Loading…</div>
        </div>
    `;
    wireNav();

    try {
        const res = await authFetch(`/api/weeks/${scanId}`);
        if (!res.ok) throw new Error((await res.json()).error ?? "Not found");
        renderEditBody(scanId, await res.json());
    } catch (err) {
        const body = document.querySelector<HTMLDivElement>("#edit-body");
        if (body) {
            body.className = "err";
            body.textContent = (err as Error).message;
        }
    }
}

function renderEditBody(scanId: string, data: WeekDetail) {
    const cells = data.cells;
    const sheetDateSunday = cells[0]?.sheet_date ?? null;
    const fashionLine = cells[0]?.fashion_line ?? null;
    const countSaturday = sheetDateSunday ? addDays(sheetDateSunday, 6) : "";

    // Group rows back into style/colour sections and reconstruct the remaining
    // sheet count (count = FULL_STOCK − units sold, lossless for 0..FULL_STOCK).
    const sections = new Map<string, EditSection>();
    for (const c of cells) {
        const key = `${c.style_code}|${c.color}`;
        if (!sections.has(key)) sections.set(key, { style: c.style_code, color: c.color, cells: [] });
        sections.get(key)!.cells.push({
            waist: Number(c.waist),
            inseam: Number(c.inseam),
            count: Math.max(0, FULL_STOCK - Number(c.quantity)),
        });
    }
    const secList = [...sections.values()];
    const inseams = [...new Set(cells.map((c) => Number(c.inseam)))].sort((a, b) => a - b);

    let head = "<th>Inseam</th>";
    for (const s of secList) {
        head += `<th colspan="2">${s.color ?? "—"}<small>${s.style ?? "no code"}</small></th>`;
    }
    const sub = "<th></th>" + secList.map(() => "<th>W30</th><th>W32</th>").join("");

    let rows = "";
    for (const ins of inseams) {
        rows += `<tr><td>${ins}</td>`;
        for (let si = 0; si < secList.length; si++) {
            for (const w of [30, 32]) {
                const cell = secList[si].cells.find((c) => c.inseam === ins && c.waist === w);
                const val = cell ? cell.count : "";
                rows += `<td><input data-s="${si}" data-ins="${ins}" data-w="${w}" value="${val}" /></td>`;
            }
        }
        rows += "</tr>";
    }

    const label = sheetDateSunday ? weekRange(sheetDateSunday) : "—";
    const imgSrc = `/api/scans/${scanId}/image?token=${encodeURIComponent(getToken()!)}`;

    const body = document.querySelector<HTMLDivElement>("#edit-body")!;
    body.className = "";
    body.innerHTML = `
        <div class="review-head">
            <h2>Edit week ${label}</h2>
            <span class="meta-pill">Line <b>${fashionLine ?? "—"}</b></span>
        </div>
        <p class="notes">Cells show the <b>remaining count from the sheet</b> (units sold = ${FULL_STOCK} − count). Correct any mistyped value, then re-store.</p>
        <div class="detail-grid">
            <div class="detail-table">
                <div class="table-wrap">
                    <table class="grid">
                        <thead><tr>${head}</tr><tr>${sub}</tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
            <figure class="bronze">
                <a href="${imgSrc}" target="_blank" rel="noopener">
                    <img src="${imgSrc}" alt="Scanned size sheet for ${label}" />
                </a>
                <figcaption>Reference scan</figcaption>
            </figure>
        </div>
        <div class="date-entry">
            <label for="e-date">Count date — Saturday only (required):</label>
            <input id="e-date" type="date" value="${countSaturday && isSaturday(countSaturday) ? countSaturday : ""}" />
            <span id="e-date-error" class="date-error"></span>
        </div>
        <div class="actions">
            <button class="primary" id="edit-save">Save changes</button>
            <button class="ghost" id="edit-cancel">Cancel</button>
        </div>
        <div id="edit-msg"></div>
    `;

    const dateInput = document.querySelector<HTMLInputElement>("#e-date")!;
    const dateErr = document.querySelector("#e-date-error")!;
    dateInput.addEventListener("change", () => {
        dateErr.textContent =
            dateInput.value && !isSaturday(dateInput.value)
                ? "Invalid date — inventory is counted on Saturdays only. Pick a Saturday."
                : "";
    });

    document.querySelector("#edit-cancel")!.addEventListener("click", () => renderDetail(scanId));
    document.querySelector("#edit-save")!.addEventListener("click", () => saveEdit(scanId, secList, fashionLine));
}

async function saveEdit(scanId: string, secList: EditSection[], fashionLine: string | null) {
    const isoDate = (document.querySelector("#e-date") as HTMLInputElement).value;
    const errEl = document.querySelector("#e-date-error")!;

    if (!isoDate) {
        errEl.textContent = "Pick the count date before saving.";
        return;
    }
    if (!isSaturday(isoDate)) {
        errEl.textContent = "Invalid date — inventory is counted on Saturdays only. Pick a Saturday.";
        return;
    }
    errEl.textContent = "";

    const cells: InventoryCell[] = [];
    document.querySelectorAll<HTMLInputElement>("table input").forEach((inp) => {
        const v = inp.value.trim();
        if (v === "") return;
        const si = Number(inp.dataset.s);
        cells.push({
            style_code: secList[si].style,
            color: secList[si].color,
            waist: Number(inp.dataset.w),
            inseam: Number(inp.dataset.ins),
            quantity: Number(v), // raw remaining count; backend stores FULL_STOCK − count
            confidence: 1,
        });
    });

    const body: ConfirmRequest = {
        scan_id: scanId,
        sheet_date: isoDate,
        fashion_line: fashionLine,
        operator: null,
        cells,
    };

    const msg = document.querySelector<HTMLDivElement>("#edit-msg")!;
    const saveBtn = document.querySelector<HTMLButtonElement>("#edit-save")!;
    saveBtn.disabled = true;
    msg.className = "busy";
    msg.textContent = "Saving changes…";

    try {
        const res = await authFetch(`/api/weeks/${scanId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
        renderDetail(scanId);
    } catch (err) {
        msg.className = "err";
        msg.textContent = "Error: " + (err as Error).message;
        saveBtn.disabled = false;
    }
}

/* ===========================================================================
   INTAKE — upload → review → confirm → success (employee flow)
=========================================================================== */
async function confirm() {
    const secList = (window as any)._secList;
    const cells: InventoryCell[] = [];

    const isoDate = (document.querySelector("#m-date") as HTMLInputElement).value;
    const errEl = document.querySelector("#date-error")!;

    if (!isoDate) {
        errEl.textContent = "Pick the inventory date before confirming.";
        return;
    }
    if (!isSaturday(isoDate)) {
        errEl.textContent = "Invalid date — inventory is counted on Saturdays only. Pick a Saturday.";
        return;
    }
    errEl.textContent = "";

    document.querySelectorAll<HTMLInputElement>("table input").forEach((inp) => {
        const v = inp.value.trim();
        if (v === "") return;
        const si = Number(inp.dataset.s);
        cells.push({
            style_code: secList[si].style,
            color: secList[si].color,
            waist: Number(inp.dataset.w),
            inseam: Number(inp.dataset.ins),
            quantity: Number(v),
            confidence: 1, // human-confirmed
        });
    });

    const body: ConfirmRequest = {
        scan_id: current!.scan_id,
        sheet_date: isoDate,
        fashion_line: current!.extraction.fashion_line,
        operator: current!.extraction.operator,
        cells,
    };

    const msg = document.querySelector<HTMLDivElement>("#msg")!;
    const confirmBtn = document.querySelector<HTMLButtonElement>("#confirm");
    const discardBtn = document.querySelector<HTMLButtonElement>("#discard");
    if (confirmBtn) confirmBtn.disabled = true;
    if (discardBtn) discardBtn.disabled = true;
    msg.className = "busy";
    msg.textContent = "Storing to ledger…";

    try {
        const res = await authFetch("/api/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
        const out = await res.json();
        // Capture the line before we clear `current`, then move to the success screen.
        renderSuccess(out.rows_stored, body.fashion_line, out.restock);
    } catch (e) {
        msg.className = "err";
        msg.textContent = "Error: " + (e as Error).message;
        if (confirmBtn) confirmBtn.disabled = false;
        if (discardBtn) discardBtn.disabled = false;
    }
}

interface RestockResult {
    ok: boolean;
    skipped?: boolean;
    count: number;
    listTitle?: string;
    error?: string;
}

/* A short line about the refill checklist sent to Google Tasks on confirm. */
function restockNote(r?: RestockResult): string {
    if (!r) return "";
    let cls = "restock-note";
    let text: string;
    if (r.skipped) {
        cls += " muted";
        text = "Refill checklist ready, but Google Tasks isn't configured — no list was sent.";
    } else if (r.ok && r.count > 0) {
        cls += " good";
        text = `Refill checklist sent to Google Tasks — <b>${r.count}</b> ${r.count === 1 ? "item" : "items"} in “${r.listTitle ?? "Restock"}”.`;
    } else if (r.ok) {
        cls += " muted";
        text = "Nothing to refill this week — no checklist needed.";
    } else {
        cls += " warn";
        text = `Stored fine, but the Google Tasks checklist failed to send: ${r.error ?? "unknown error"}.`;
    }
    return `<p class="${cls}">${text}</p>`;
}

function renderSuccess(rowsStored: number, line: string | null, restock?: RestockResult) {
    current = null; // the confirmed scan is done; clear the working state
    app.innerHTML = `
        ${masthead("Stored")}
        ${navBar("intake")}
        <div class="card success">
            <div class="seal">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2.6"
                    stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 12.5l5 5 11-11" />
                </svg>
            </div>
            <p class="kicker">Committed to ledger</p>
            <h2>Sheet <em>stored</em>.</h2>
            <p class="detail">
                <b>${rowsStored}</b> inventory ${rowsStored === 1 ? "row" : "rows"}
                ${line ? `for <b>${line}</b> ` : ""}have been recorded and verified.
            </p>
            ${restockNote(restock)}
            <div class="actions">
                <button class="primary" id="again">Upload a new file</button>
                <button class="ghost" id="to-records">View records</button>
            </div>
        </div>
    `;
    wireNav();
    document.querySelector("#again")!.addEventListener("click", renderUpload);
    document.querySelector("#to-records")!.addEventListener("click", renderLedger);
}

function renderReview() {
    const ex = current!.extraction;
    const cells = flattenSections(ex);

    const sections = new Map<string, { style: string | null; color: string | null; cells: any[] }>();
    for (const c of cells) {
        const key = `${c.style_code}|${c.color}`;
        if (!sections.has(key)) sections.set(key, { style: c.style_code, color: c.color, cells: [] });
        sections.get(key)!.cells.push(c);
    }
    const secList = [...sections.values()];

    const inseams = [...new Set(cells.map((c) => c.inseam))].sort(
        (a, b) => (a as number) - (b as number)
    ) as number[];


    let head = "<th>Inseam</th>";
    for (const s of secList) {
        head += `<th colspan="2">${s.color ?? "—"}<small>${s.style ?? "no code"}</small></th>`;
    }
    let sub = "<th></th>" + secList.map(() => "<th>W30</th><th>W32</th>").join("");

    let rows = "";
    for (const ins of inseams) {
        rows += `<tr><td>${ins}</td>`;
        for (let si = 0; si < secList.length; si++) {
            for (const w of [30, 32]) {
                const cell = secList[si].cells.find((c) => c.inseam === ins && c.waist === w);
                const val = cell ? cell.quantity : "";
                const low = cell && cell.confidence < 0.7 ? " low" : "";
                rows += `<td><input class="${low.trim()}" data-s="${si}" data-ins="${ins}" data-w="${w}" value="${val}" /></td>`;
            }
        }
        rows += "</tr>";
    }

    app.innerHTML = `
        ${masthead("Review")}
        ${navBar("intake")}
        <div class="card">
            <div class="review-head">
                <h2>Review extraction</h2>
                <span class="meta-pill">Date <b>${ex.sheet_date ?? "—"}</b></span>
                <span class="meta-pill">Line <b>${ex.fashion_line ?? "—"}</b></span>
                ${ex.operator ? `<span class="meta-pill">Operator <b>${ex.operator}</b></span>` : ""}
            </div>
            ${ex.notes ? `<p class="notes">Model notes — ${ex.notes}</p>` : ""}
            <div class="table-wrap">
                <table class="grid">
                    <thead><tr>${head}</tr><tr>${sub}</tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="legend">
                <span class="swatch"></span>
                Flagged cells fell below model confidence — verify before storing.
            </div>
            <div class="date-entry">
                <label for="m-date">Inventory date — Saturday only (required):</label>
                <input id="m-date" type="date"
                    value="${ex.sheet_date && isSaturday(ex.sheet_date) ? ex.sheet_date : ""}" />
                <span id="date-error" class="date-error"></span>
            </div>
            <div class="actions">
                <button class="primary" id="confirm">Confirm &amp; Store</button>
                <button class="ghost" id="discard">Discard</button>
            </div>
            <div id="msg"></div>
        </div>
    `;
    wireNav();

    (window as any)._secList = secList;

    const dateInput = document.querySelector<HTMLInputElement>("#m-date")!;
    const dateErr = document.querySelector("#date-error")!;
    dateInput.addEventListener("change", () => {
        const v = dateInput.value;
        dateErr.textContent =
            v && !isSaturday(v) ? "Invalid date — inventory is counted on Saturdays only. Pick a Saturday." : "";
    });

    document.querySelector("#discard")!.addEventListener("click", renderUpload);
    // NOTE: pass the function reference so it is *called* on click.
    // `() => { confirm }` (no parens) would never invoke it — that was the old bug.
    document.querySelector("#confirm")!.addEventListener("click", confirm);
}

async function upload(file: File) {
    const msg = document.querySelector<HTMLDivElement>("#msg")!;
    msg.className = "busy";
    msg.textContent = "Extracting with Claude — about 20–40 seconds…";

    const form = new FormData();
    form.append("image", file);

    try {
        const res = await authFetch("/api/extract", { method: "POST", body: form });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error ?? "Extraction failed");
        }
        current = await res.json();
        renderReview();
    } catch (e) {
        msg.className = "err";
        msg.textContent = "Error: " + (e as Error).message;
    }
}

function renderUpload() {
    if (!getToken()) return renderLogin();

    app.innerHTML = `
        ${masthead("Intake")}
        ${navBar("intake")}
        <p class="lede">Upload a scanned size sheet and Claude will read the
            handwritten grid into structured inventory you can <em>verify and store</em>.</p>
        <div class="card">
            <label class="drop" id="drop">
                <span class="mark">＋</span>
                <span class="big">Drop a sheet or click to browse</span>
                <span class="small">JPG or PNG — one scanned intake sheet</span>
                <input type="file" id="file" accept="image/*" />
            </label>
            <div id="msg"></div>
        </div>
    `;
    wireNav();

    const fileInput = document.querySelector<HTMLInputElement>("#file")!;
    const drop = document.querySelector<HTMLLabelElement>("#drop")!;

    fileInput.addEventListener("change", () => {
        if (fileInput.files?.[0]) upload(fileInput.files[0]);
    });

    // Drag-and-drop niceties.
    ["dragenter", "dragover"].forEach((ev) =>
        drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
        drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); })
    );
    drop.addEventListener("drop", (e) => {
        const f = (e as DragEvent).dataTransfer?.files?.[0];
        if (f) upload(f);
    });
}

/* Entry point — records homepage if signed in, otherwise the login screen. */
if (getToken()) renderLedger();
else renderLogin();
