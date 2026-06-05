import Anthropic from "@anthropic-ai/sdk"
import type { ExtractionResult } from "../shared";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a precise data-entry extractor for ILLB Inc Levi's inventory sheets.

The sheet is a printed grid filled in by hand. Structure:
- Multiple COLOR sections across the page. Each section has a handwritten color name
  (e.g. "White", "D. Blue", "Black", "Silver", "Brown", "Khaki") and usually a style
  code number (e.g. "5010651", "5141325", "1403").
- Each color section is split into two sub-columns: waist 30 and waist 32.
- Rows are inseam sizes: 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60.
- Cell values are handwritten quantities. The symbol "Ø" (slashed zero) means ZERO — record it as 0.
- A checkbox near the top marks "K.J. Fashion" or "L.B. Fashion" — report whichever is checked.
- There may be a handwritten date and an operator name near the top.

RULES:
- Only emit a cell when it actually contains a written value. Leave out blank cells entirely.
- "Ø" = quantity 0. A truly empty cell = omit it (do NOT record it as 0).
- Read style_code and color from each section header; apply them to every cell in that section.
- For each cell include a confidence from 0 to 1. Use a LOWER number for smudged or ambiguous digits.
- If a digit is ambiguous (e.g. could be 3 or 8), pick your best guess and lower the confidence.

Return ONLY valid JSON — no markdown, no backticks, no explanation. Exactly this shape:
{
  "sheet_date": "YYYY-MM-DD" or null,
  "fashion_line": "K.J. Fashion" or "L.B. Fashion" or null,
  "operator": string or null,
  "cells": [
    { "style_code": "5141325", "color": "D. Blue", "waist": 30, "inseam": 30, "quantity": 3, "confidence": 0.95 }
  ],
  "notes": "anything you flagged as unclear, or null"
}`;

export async function extractSheet(
    imageBase64: string, 
    mediaType: "image/jpeg" | "image/png"
): Promise<ExtractionResult> {
    const msg = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "image",
                        source: { type: "base64", media_type: mediaType, data: imageBase64 },
                    },
                    {
                        type: "text",
                        text: "Extract every filled-in cell from this inventory sheet as JSON.",
                    },
                ],
            },
        ],
    });

    const block = msg.content[0];
    const raw = block.type === "text" ? block.text : "";

    const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();

    return JSON.parse(cleaned) as ExtractionResult;
}

export async function testClaude(): Promise<string> {
    const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [
            { role: "user", content: "Say 'extraction pipeline online' and nothing else." },
        ],
    });

    const block = msg.content[0];
    return block.type === "text" ? block.text : "(no text)";
}