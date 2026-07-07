import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { DATA_DIR } from "./paths";
import { usePg, db, getConfigValue, setConfigValue } from "./db";

/**
 * The system of record for hooks / posts / metrics. Dual backend:
 *   fs (desktop): a single JSON file (~/.sweatshop/store.json) shaped like the
 *                 Postgres schema, so migration is a 1:1 import.
 *   pg (server):  the real tables (db/migrations/001_init.sql).
 * All access goes through these functions — swapping backends touches nothing else.
 */
export type StoredHook = {
  id: string;            // h_xxxxxx
  text: string;
  angle: string;
  rationale?: string;
  ticket?: string;       // the autopilot ticket that carried it (e.g. CON-61)
  createdAt: string;
};

export type StoredPost = {
  id: string;            // postiz post id
  ticket: string;        // the Linear post ticket (e.g. CON-64)
  conceptId?: string;    // the concept ticket (e.g. CON-62)
  hookId?: string;
  influencerId: string;
  scheduledAt: string;
  createdAt: string;
};

/** Channel-level daily sample (Postiz public analytics is per-integration). */
export type ChannelMetric = {
  influencerId: string;
  label: string;         // e.g. "Followers", "Impressions"
  value: number;
  date: string;          // YYYY-MM-DD
  capturedAt: string;
};

/** Reserved for per-post metrics once a per-post source exists (post_metrics). */
export type PostMetric = {
  postId: string;
  label: string;
  value: number;
  capturedAt: string;
};

type StoreData = {
  hooks: StoredHook[];
  posts: StoredPost[];
  channelMetrics: ChannelMetric[];
  postMetrics: PostMetric[];
  state: Record<string, string>; // small KV (e.g. autopilot lastRunAt)
};

const FILE = join(DATA_DIR, "store.json");
const EMPTY: StoreData = { hooks: [], posts: [], channelMetrics: [], postMetrics: [], state: {} };

function load(): StoreData {
  try { return { ...EMPTY, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { return { ...EMPTY }; }
}
function save(d: StoreData): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(d, null, 2));
}

export async function addHooks(hooks: Omit<StoredHook, "id" | "createdAt">[]): Promise<StoredHook[]> {
  const created = hooks.map((h) => ({
    ...h,
    id: "h_" + Math.random().toString(36).slice(2, 8),
    createdAt: new Date().toISOString(),
  }));
  if (usePg()) {
    for (const h of created) {
      await db().query(
        "INSERT INTO hooks (id, text, angle, rationale, ticket) VALUES ($1,$2,$3,$4,$5)",
        [h.id, h.text, h.angle, h.rationale ?? null, h.ticket ?? null],
      );
    }
    return created;
  }
  const d = load();
  d.hooks.push(...created);
  save(d);
  return created;
}

export async function recordPost(post: Omit<StoredPost, "createdAt">): Promise<void> {
  if (usePg()) {
    await db().query(
      `INSERT INTO posts (id, ticket, concept_id, hook_id, influencer_id, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [post.id, post.ticket, post.conceptId ?? null, post.hookId ?? null, post.influencerId, post.scheduledAt],
    );
    return;
  }
  const d = load();
  if (d.posts.some((p) => p.id === post.id)) return; // idempotent
  d.posts.push({ ...post, createdAt: new Date().toISOString() });
  save(d);
}

/** Upsert daily channel samples (dedupe on influencer+label+date, keep newest). */
export async function addChannelMetrics(samples: Omit<ChannelMetric, "capturedAt">[]): Promise<void> {
  if (usePg()) {
    for (const s of samples) {
      await db().query(
        `INSERT INTO account_metrics (influencer_id, label, value, date)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (influencer_id, label, date) DO UPDATE SET value = EXCLUDED.value, captured_at = now()`,
        [s.influencerId, s.label, s.value, s.date],
      );
    }
    return;
  }
  const d = load();
  const key = (m: { influencerId: string; label: string; date: string }) => `${m.influencerId}|${m.label}|${m.date}`;
  const byKey = new Map(d.channelMetrics.map((m) => [key(m), m]));
  const capturedAt = new Date().toISOString();
  for (const s of samples) byKey.set(key(s), { ...s, capturedAt });
  d.channelMetrics = [...byKey.values()];
  save(d);
}

export async function recentHooks(limit = 15): Promise<StoredHook[]> {
  if (usePg()) {
    const { rows } = await db().query(
      "SELECT id, text, angle, rationale, ticket, created_at FROM hooks ORDER BY created_at DESC LIMIT $1", [limit],
    );
    return rows.reverse().map((r) => ({
      id: r.id, text: r.text, angle: r.angle, rationale: r.rationale ?? undefined,
      ticket: r.ticket ?? undefined, createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  return load().hooks.slice(-limit);
}

export async function postsForHook(hookId: string): Promise<StoredPost[]> {
  if (usePg()) {
    const { rows } = await db().query(
      "SELECT id, ticket, concept_id, hook_id, influencer_id, scheduled_at, created_at FROM posts WHERE hook_id = $1", [hookId],
    );
    return rows.map((r) => ({
      id: r.id, ticket: r.ticket, conceptId: r.concept_id ?? undefined, hookId: r.hook_id ?? undefined,
      influencerId: r.influencer_id, scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : "",
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  return load().posts.filter((p) => p.hookId === hookId);
}

/** First→last delta per influencer+label over the stored window (trend summary). */
export async function channelTrends(): Promise<{ influencerId: string; label: string; first: number; last: number }[]> {
  if (usePg()) {
    const { rows } = await db().query(`
      SELECT DISTINCT ON (influencer_id, label) influencer_id, label,
        first_value(value) OVER w AS first, last_value(value) OVER w AS last
      FROM account_metrics
      WINDOW w AS (PARTITION BY influencer_id, label ORDER BY date
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)`);
    return rows.map((r) => ({ influencerId: r.influencer_id, label: r.label, first: Number(r.first), last: Number(r.last) }));
  }
  const d = load();
  const groups = new Map<string, ChannelMetric[]>();
  for (const m of d.channelMetrics) {
    const k = `${m.influencerId}|${m.label}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
  }
  return [...groups.values()].map((arr) => {
    const sorted = arr.sort((a, b) => a.date.localeCompare(b.date));
    return { influencerId: sorted[0].influencerId, label: sorted[0].label, first: sorted[0].value, last: sorted[sorted.length - 1].value };
  });
}

export async function getState(key: string): Promise<string | undefined> {
  if (usePg()) return (await getConfigValue<string>(`state:${key}`)) ?? undefined;
  return load().state[key];
}
export async function setState(key: string, value: string): Promise<void> {
  if (usePg()) { await setConfigValue(`state:${key}`, value); return; }
  const d = load();
  d.state[key] = value;
  save(d);
}
