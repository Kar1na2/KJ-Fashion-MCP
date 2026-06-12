import "./style.css";
import type { ExtractionResult, ExtractionSection, InventoryCell, ConfirmRequest } from "../shared";

interface ExtractResponse {
    ok: boolean;
    scan_id: string;
    extraction: ExtractionResult;
}

let current: ExtractResponse | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;

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

// The grid is counted every Saturday. A YYYY-MM-DD string is a valid intake
// date only if it lands on a Saturday — we reject anything else instead of
// nudging it to a nearby Saturday.
function isSaturday(iso: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const d = new Date(`${iso}T00:00:00Z`);
    if (isNaN(d.getTime())) return false;
    return d.getUTCDay() === 6;
}

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
        const res = await fetch("/api/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
        const out = await res.json();
        // Capture the line before we clear `current`, then move to the success screen.
        renderSuccess(out.rows_stored, body.fashion_line);
    } catch (e) {
        msg.className = "err";
        msg.textContent = "Error: " + (e as Error).message;
        if (confirmBtn) confirmBtn.disabled = false;
        if (discardBtn) discardBtn.disabled = false;
    }
}

function renderSuccess(rowsStored: number, line: string | null) {
    current = null; // the confirmed scan is done; clear the working state
    app.innerHTML = `
        ${masthead("Stored")}
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
            <div class="actions">
                <button class="primary" id="again">Upload a new file</button>
            </div>
        </div>
    `;
    document.querySelector("#again")!.addEventListener("click", renderUpload);
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
        const res = await fetch("/api/extract", { method: "POST", body: form });
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
    app.innerHTML = `
        ${masthead("Intake")}
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

renderUpload();