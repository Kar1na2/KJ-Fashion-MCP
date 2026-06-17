import type { RestockItem } from "./restock.js";

// ---------------------------------------------------------------------------
// Notion delivery.
//
// The Notion API cannot toggle "Publish to web", so the public, no-login URL
// relies on a one-time manual step: a parent page is published to the web once,
// and Notion publishes everything nested under it. Each weekly checklist page is
// created as a child of that parent (NOTION_PARENT_PAGE_ID) and is therefore
// reachable at https://<NOTION_SITE_DOMAIN>/<pageId-without-dashes>.
//
// With any of the three vars unset we skip silently so confirm never depends on
// Notion being configured.
// ---------------------------------------------------------------------------

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionResult {
    ok: boolean;
    skipped?: boolean;
    url?: string;
    error?: string;
}

function todoBlock(text: string) {
    return {
        object: "block",
        type: "to_do",
        to_do: { rich_text: [{ type: "text", text: { content: text } }], checked: false },
    };
}

function headingBlock(text: string) {
    return {
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
    };
}

// A heading per color, then a checkbox per item (already sorted color → waist →
// inseam by buildRestockList).
function buildChildren(items: RestockItem[]): object[] {
    const blocks: object[] = [];
    let lastColor: string | null | undefined;
    for (const i of items) {
        if (i.color !== lastColor) {
            blocks.push(headingBlock(i.color ?? "(no color)"));
            lastColor = i.color;
        }
        blocks.push(
            todoBlock(`${i.style_code ?? "(no code)"} · W${i.waist} · inseam ${i.inseam} — refill ${i.refill}`)
        );
    }
    return blocks;
}

// Create the checklist page under the published parent and return its public
// notion.site URL. Never throws.
export async function createChecklistPage(title: string, items: RestockItem[]): Promise<NotionResult> {
    const token = process.env.NOTION_TOKEN;
    const parent = process.env.NOTION_PARENT_PAGE_ID;
    const domain = process.env.NOTION_SITE_DOMAIN;
    if (!token || !parent || !domain) return { ok: false, skipped: true };
    if (items.length === 0) return { ok: true }; // nothing to refill

    try {
        const res = await fetch(`${NOTION_API}/pages`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                parent: { type: "page_id", page_id: parent },
                properties: { title: { title: [{ type: "text", text: { content: title } }] } },
                children: buildChildren(items),
            }),
        });
        if (!res.ok) throw new Error(`create page failed (${res.status}): ${await res.text()}`);
        const page = (await res.json()) as { id: string };

        // Published-parent domain + this page's id (dashes stripped).
        const url = `https://${domain}/${page.id.replace(/-/g, "")}`;
        return { ok: true, url };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}
