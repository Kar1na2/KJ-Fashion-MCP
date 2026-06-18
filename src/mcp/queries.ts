import "dotenv/config";

const BASE = "http://localhost:8787";

// The backend gates every /api route behind operator login (see server/index.ts).
// The MCP server is a headless read-only client, so it logs in once with the
// operator credentials from .env, caches the session token, and re-logs in if the
// token is ever rejected (the backend keeps sessions in memory, so a server
// restart invalidates ours).
const APP_USER = process.env.APP_USER;
const APP_PASS = process.env.APP_PASS;

let token: string | null = null;

async function login(): Promise<string> {
    if (!APP_USER || !APP_PASS) {
        throw new Error("APP_USER and APP_PASS must be set in .env for the MCP server to query the backend");
    }
    const res = await fetch(`${BASE}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: APP_USER, password: APP_PASS }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Login failed: ${res.status}`);
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error("Login succeeded but no token was returned");
    token = data.token;
    return token;
}

async function getJson(path: string): Promise<unknown> {
    if (!token) await login();

    let res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });

    // A stale/invalid session (e.g. the backend restarted) returns 401 — log in
    // again once and retry before giving up.
    if (res.status === 401) {
        await login();
        res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
    }

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
    }
    return res.json();
}

export const getWeeklyTrend = (start_date: string, end_date: string) =>
    getJson(`/api/trend/weekly?start_date=${encodeURIComponent(start_date)}&end_date=${encodeURIComponent(end_date)}`);
export const getMonthlyTrend = (year: number, month: number) => getJson(`/api/trend/monthly/${year}/${month}`);
export const getYearlyTrend = (year: number) => getJson(`/api/trend/${year}`);
export const getStyleHistory = (styleCode: string) => getJson(`/api/style/${encodeURIComponent(styleCode)}`);
export const listStyles = () => getJson(`/api/styles`);
