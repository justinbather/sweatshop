/**
 * Discord alerting via a channel webhook (`DISCORD_WEBHOOK_URL`, set in Settings).
 * Fire-and-forget: alerts must never slow down or crash the pipeline, so sends are
 * unawaited and all failures are swallowed (logged once to the worker console).
 * No webhook configured → no-op.
 */
const COLORS = { info: 0x8b7bf0, success: 0x57f287, warn: 0xfee75c, error: 0xed4245 };

export type NotifyKind = keyof typeof COLORS;

export function notify(kind: NotifyKind, title: string, opts?: { detail?: string; url?: string }): void {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  const embed: Record<string, unknown> = {
    title: title.slice(0, 250),
    color: COLORS[kind],
    timestamp: new Date().toISOString(),
  };
  if (opts?.detail) embed.description = opts.detail.slice(0, 1500);
  if (opts?.url) embed.url = opts.url;
  fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  }).then((res) => {
    if (!res.ok) console.error(`discord notify → ${res.status}`);
  }).catch((e) => console.error("discord notify failed:", e instanceof Error ? e.message : String(e)));
}
