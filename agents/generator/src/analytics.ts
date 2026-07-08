import { addChannelMetrics } from "./store";
import type { Influencer } from "./influencers";

/**
 * Pull channel-level analytics from Postiz (per-integration daily series —
 * followers, impressions, …) into account_metrics. Shared by the Strategist
 * (pre-run refresh) and the server's daily report collector.
 */
const POSTIZ_BASE = process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1";

export async function pullChannelAnalytics(influencers: Influencer[]): Promise<string> {
  const apiKey = process.env.POSTIZ_API_KEY;
  if (!apiKey) return "no POSTIZ_API_KEY — skipped";
  let stored = 0;
  for (const inf of influencers) {
    if (!inf.postizIntegrationId) continue;
    try {
      const res = await fetch(`${POSTIZ_BASE}/analytics/${inf.postizIntegrationId}?date=7`, {
        headers: { Authorization: apiKey },
      });
      if (!res.ok) { console.error(`  analytics ${inf.name}: ${res.status}`); continue; }
      const series: { label: string; data: { total: string; date: string }[] }[] = await res.json();
      const samples = (Array.isArray(series) ? series : []).flatMap((s) =>
        (s.data || []).map((p) => ({ influencerId: inf.id, label: s.label, value: Number(p.total) || 0, date: p.date })),
      );
      await addChannelMetrics(samples);
      stored += samples.length;
    } catch (e) {
      console.error(`  analytics ${inf.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return `${stored} sample(s) stored`;
}
