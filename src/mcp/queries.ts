const BASE = "http://localhost:8787";

async function getJson(path: string) {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
    }
    return res.json();
}

export const getYearlyTrend = (year: number) => getJson(`/api/trend/${year}`);
export const getStyleHistory = (styleCode: string) => getJson(`/api/style/${encodeURIComponent(styleCode)}`);
export const listStyles = () => getJson(`/api/styles`);