const BASE = "http://localhost:8787";

async function getJson(path: string) {
    const res = await fetch(`${BASE}${path}`);
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