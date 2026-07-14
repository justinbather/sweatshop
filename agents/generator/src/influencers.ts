import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { DATA_DIR } from "./paths";
import { usePg, db } from "./db";

/**
 * Multi-influencer store + posting schedule, shared by the Creator (fan-out) and
 * Poster (which account + which slot). Dual backend:
 *   fs (desktop): ~/.sweatshop/influencers.json + schedule-state.json
 *   pg (server):  influencers table; the "next slot" derives from posts.scheduled_at
 * Reference images live under DATA_DIR/refs/<id> in both modes.
 */

/** Content style of an account: UGC photo slideshows vs designed graphic cards. */
export type Profile = "ugc" | "graphic";

/** Design system for a graphic account — free-text tokens fed to the image model. */
export type Design = {
  palette?: string;   // e.g. "#0F172A background, #FACC15 accent, white text"
  fontStyle?: string; // e.g. "bold condensed sans display, clean sans body"
  style?: string;     // e.g. "minimal dark cards, big numbers, thin dividers"
  voice?: string;     // e.g. "authoritative, listy"
};

export type Influencer = {
  id: string;
  name: string;
  postizIntegrationId: string; // the TikTok account in Postiz this character posts to
  timeslots: string[];         // daily post times, "HH:MM" 24h
  enabled: boolean;
  profile?: Profile;           // default "ugc"
  design?: Design;             // graphic accounts: the design system
  pillars?: string[];          // example hooks this account rotates through ("random" = explore slot)
};

export const profileOf = (i?: Influencer | null): Profile => (i?.profile === "graphic" ? "graphic" : "ugc");

const FILE = join(DATA_DIR, "influencers.json");
const STATE_FILE = join(DATA_DIR, "schedule-state.json");

export async function loadInfluencers(): Promise<Influencer[]> {
  if (usePg()) {
    const { rows } = await db().query(
      "SELECT id, name, postiz_integration_id, timeslots, enabled, profile, design, pillars FROM influencers ORDER BY created_at",
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      postizIntegrationId: r.postiz_integration_id || "",
      timeslots: r.timeslots || [],
      enabled: !!r.enabled,
      profile: r.profile === "graphic" ? "graphic" : "ugc",
      design: r.design || undefined,
      pillars: r.pillars || [],
    }));
  }
  try {
    const d = JSON.parse(readFileSync(FILE, "utf8"));
    const list: Influencer[] = Array.isArray(d?.influencers) ? d.influencers : [];
    return list.filter((i) => i && i.id && i.name);
  } catch {
    return [];
  }
}

export const refsDirFor = (id: string) => join(DATA_DIR, "refs", id);

/** Next datetime strictly after `from` whose time-of-day is one of the slots. */
export function nextSlot(timeslots: string[], from: Date): Date {
  const slots = [...timeslots].filter((t) => /^\d{1,2}:\d{2}$/.test(t)).sort();
  if (slots.length === 0) return new Date(from.getTime() + 60 * 60 * 1000); // no slots → ~now
  for (let day = 0; day < 90; day++) {
    for (const t of slots) {
      const [h, m] = t.split(":").map(Number);
      const d = new Date(from);
      d.setDate(d.getDate() + day);
      d.setHours(h, m, 0, 0);
      if (d.getTime() > from.getTime()) return d;
    }
  }
  return new Date(from.getTime() + 60 * 60 * 1000);
}

/**
 * Claim the next open slot for an influencer, so successive posts fill successive
 * slots across days (9 posts, 3 slots/day → 3 days).
 *   pg: derives "last claimed" from posts.scheduled_at (the Poster records each post
 *       right after scheduling, so sequential claims see each other — no state file).
 *   fs: persists the last claim in schedule-state.json.
 */
export async function claimSlot(inf: Influencer): Promise<Date> {
  if (usePg()) {
    const { rows } = await db().query(
      "SELECT max(scheduled_at) AS last FROM posts WHERE influencer_id = $1",
      [inf.id],
    );
    const last = rows[0]?.last ? new Date(rows[0].last) : new Date(0);
    const from = new Date(Math.max(Date.now(), last.getTime()));
    return nextSlot(inf.timeslots, from);
  }
  let state: Record<string, string> = {};
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* fresh */ }
  const last = state[inf.id] ? new Date(state[inf.id]) : new Date(0);
  const from = new Date(Math.max(Date.now(), last.getTime()));
  const slot = nextSlot(inf.timeslots, from);
  state[inf.id] = slot.toISOString();
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
  return slot;
}
