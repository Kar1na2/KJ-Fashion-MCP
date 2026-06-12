import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getWeeklyTrend, getMonthlyTrend, getYearlyTrend, getStyleHistory, listStyles } from "./queries.js";

function createServer() {
    const server = new McpServer({ name: "illb-inventory", version: "1.0.0" });

    server.registerTool(
        "get_weekly_trend",
        {
            title: "Get weekly inventory trend",
            description:
                "Returns weekly inventory snapshots within a date range, broken down by style code and color. Each week is a separate, non-overlapping span that BEGINS on a Sunday (assume everything is filled) and ENDS the following Saturday, when the count is taken and the quantity sold over that week is calculated. So start_date is a Sunday and end_date is a Saturday — for a single week, use that week's Sunday and the Saturday 6 days later (e.g. 'this week' for a count on Sat 2026-06-13 is start_date 2026-06-07, end_date 2026-06-13). For multiple weeks, span from the first week's Sunday to the last week's Saturday. Provide both as YYYY-MM-DD strings.",
            inputSchema: {
                start_date: z.string().describe("Sunday the first week begins, inclusive, e.g. '2026-06-07'"),
                end_date: z.string().describe("Saturday the last week ends, inclusive, e.g. '2026-06-13'"),
            },
        },
        async ({ start_date, end_date }) => {
            const data = await getWeeklyTrend(start_date, end_date);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );

    server.registerTool(
        "get_monthly_trend",
        {
            title: "Get monthly inventory trend",
            description:
                "Returns inventory quantities for a specific month, broken down by style code and color. Use for questions like 'how was inventory in March 2025' or 'compare June this year to June last year'. Call this tool once per month you need to compare.",
            inputSchema: {
                year: z.number().describe("The year, e.g. 2025"),
                month: z.number().describe("The month number 1-12, e.g. 6 for June"),
            },
        },
        async ({ year, month }) => {
            const data = await getMonthlyTrend(year, month);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );

    server.registerTool(
        "get_yearly_trend",
        {
            title: "Get yearly inventory trend",
            description:
                "Returns monthly inventory quantities for a given year, broken down by style code and color. Use this for questions about trends over a year, e.g. 'how did stock change in 2025'.",
            inputSchema: { year: z.number().describe("The year, e.g. 2025") },
        },
        async ({ year }) => {
            const data = await getYearlyTrend(year);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );

    server.registerTool(
        "get_style_history",
        {
            title: "Get style history",
            description:
                "Returns the full monthly history for one style code across all years and colors. Use when the user asks about a specific style like '5141325'.",
            inputSchema: { style_code: z.string().describe("The style code, e.g. '5141325'") },
        },
        async ({ style_code }) => {
            const data = await getStyleHistory(style_code);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );

    server.registerTool(
        "list_styles",
        {
            title: "List available styles and colors",
            description:
                "Lists every style code and color present in the inventory. Call this first if you're unsure what styles exist before answering a question.",
            inputSchema: {},
        },
        async () => {
            const data = await listStyles();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );

    return server;
}

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
        return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => transports.set(sid, transport),
        });
        transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await createServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
    }

    res.status(400).json({ error: "Bad request: missing or invalid session" });
});

app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (!transport) return void res.status(404).json({ error: "Session not found" });
    await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports.get(sessionId);
    if (!transport) return void res.status(404).json({ error: "Session not found" });
    await transport.handleRequest(req, res);
});

const MCP_PORT = 3000;
app.listen(MCP_PORT, "0.0.0.0", () => {
    console.error(`[mcp] illb-inventory server running on http://0.0.0.0:${MCP_PORT}/mcp`);
});