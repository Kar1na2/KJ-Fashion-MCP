import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getYearlyTrend, getStyleHistory, listStyles } from "./queries.js";

const server = new McpServer({
    name: "illb-inventory",
    version: "1.0.0",
});

// Tool 1: yearly trend. The description is what Claude READS to decide when
// to call this — write it like documentation for the model.
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
        return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
    }
);

// Tool 2: per-style history.
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

// Tool 3: discovery — what's even in the data.
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

// Connect over stdio. Note: logging to stderr ONLY — stdout is the protocol channel.
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[mcp] illb-inventory server running on stdio");
}

main().catch((err) => {
    console.error("[mcp] fatal:", err);
    process.exit(1);
});