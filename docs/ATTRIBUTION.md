# Attribution — implementation guide

How to know **which account, hook, and format drive installs and revenue**, given the
funnel reality: TikTok suppresses outbound App Store navigation, so most installs come
from users *searching the app name on the App Store*. Link/UTM tracking alone is
structurally broken here — the working system is four layers, each cheap, none
sufficient alone:

| Layer | Captures | Effort |
|---|---|---|
| 1. Onboarding survey | everyone who answers (the majority) | ~1h in the Nourish app |
| 2. RevenueCat → PostHog join | revenue per survey answer | ~15 min (dashboard toggle) |
| 3. Collectors + correlation digest | automated per-account signal, no user action | few hours in Sweatshop |
| 4. Custom product pages | the minority who click bio links (clean signal) | ~1h in App Store Connect |

---

## Layer 1 — the onboarding survey (in the Nourish app)

The workhorse. Self-report is the standard attribution method for exactly this funnel.

**Placement:** one screen, immediately after account creation and **before the
paywall** (completion is highest there, and the answer must exist before the purchase
event so revenue can join to it). Skippable, but make skipping the smaller button.

**The question:** "How did you hear about us?" with **stable machine keys** and
per-account options:

```
tiktok_sadie      "TikTok — @nourishsadie"
tiktok_chelsea    "TikTok — @<chelsea handle>"
tiktok_graphics   "TikTok — @<graphics handle>"
appstore_search   "Found it on the App Store"
friend            "A friend"
other             "Other" (free text)
```

- **Randomize option order** (except Other, last) to kill position bias.
- Use the TikTok **handles** users actually saw, not internal names.
- **Maintenance rule:** adding an account to the Cast = adding an option here. Ship
  the list from remote config (PostHog feature flags / your own config endpoint) so
  new accounts don't need an app release.

**Data capture (PostHog):**

```ts
posthog.capture("attribution_survey_answered", { source: "tiktok_sadie" });
posthog.identify(appUserId, { attribution_source: "tiktok_sadie" }); // person property
```

Two things matter: it's a **person property** (so every later event carries it), and
`appUserId` is the **same id RevenueCat uses** (`Purchases.logIn(appUserId)`) — that
identity match is what makes Layer 2 a join instead of a guess.

**Reading it:** PostHog insight — unique persons broken down by `attribution_source`,
filtered to signups this week. At ~100-payer scale, this alone ranks the accounts.

## Layer 2 — revenue per answer (RevenueCat → PostHog)

Enable RevenueCat's built-in **PostHog integration** (RevenueCat dashboard →
Integrations → PostHog, paste the PostHog project key). RevenueCat then forwards
subscription events (`rc_initial_purchase`, `rc_trial_started`, `rc_renewal`,
`rc_cancellation`) into PostHog against the same person.

Because Layer 1 set `attribution_source` as a person property, the money question is
now one PostHog insight, no code:

> `rc_initial_purchase` events, broken down by person's `attribution_source`

That's **attributed revenue per account**. Save it as a dashboard ("Attribution")
next to signups-by-source and trials-by-source.

## Layer 3 — collectors + correlation digest (in Sweatshop)

The automated layer: per-account signal that requires no user action, powered by data
Sweatshop already records (every post's account, hook, and scheduled slot time in
`store.posts`).

**3a. Collect daily app metrics into the store.** Extend `store.ts` with an
`appMetrics` array mirroring `channelMetrics` (`{ label, value, date, capturedAt }`),
and add two pulls to the Strategist's run (it already pulls Postiz analytics on a
schedule — same pattern, same place):

- **RevenueCat** — REST v2 metrics overview (`GET /v2/projects/{project_id}/
  metrics/overview`, secret API key): active trials, active subscriptions, MRR,
  revenue → one snapshot row per metric per day. (Deltas of daily snapshots give
  new-trials/day. Verify exact endpoint + field names at build time; if v2 metrics
  prove awkward, RevenueCat **webhooks** are the better source — but they need the
  hosted backend from docs/HOSTING.md, so snapshot-polling is the pre-hosting
  interim.)
- **PostHog** — query API (`POST /api/projects/{id}/query` with a HogQL query,
  personal API key): daily counts of `attribution_survey_answered` grouped by
  `source`, and daily `rc_initial_purchase` by person `attribution_source` → rows
  like `signups:tiktok_sadie` / `revenue:tiktok_sadie`. This mirrors the *survey
  truth* into the store so the flywheel's learning layer can use it.

New keys in Settings: `REVENUECAT_API_KEY`, `POSTHOG_API_KEY` (+ project ids in
config). Same secrets plumbing as the existing keys.

**3b. Posting-time ↔ install correlation.** With `store.posts`
(account, scheduledAt) and `appMetrics` (trials/day):

- For each account: compare trials in the **24–48h after its posts** vs a baseline
  (trailing 7-day median for the same day-of-week). Report the lift.
- Keep it deliberately dumb — no regression at this scale. It's *directional*, and it
  only separates accounts because their slot times differ (keep them differing).
- Output: a **weekly Discord digest** via the existing `notify()`:

  ```
  📊 Attribution week 28
  Survey:      sadie 14 signups · chelsea 9 · graphics 4 · search 22
  Revenue:     sadie $84 · chelsea $31 · graphics $12
  Post-lift:   sadie +18% vs baseline · chelsea +6% · graphics +2%
  Best hooks:  h_eoerl4 (3 attributed trials) …
  ```

  When survey and lift agree, trust it. When they disagree, survey wins (lift is the
  noisy one at low volume).

**3c. Hooks close the loop.** `store.posts` already links post → hook → account.
Once 3a lands, attributed-trials-per-hook is a join away — and the Strategist's
`performanceContext()` should switch from channel trends to **attributed results**
as its steering signal. That is the flywheel's actual currency: hooks ranked by
revenue, not views.

## Layer 4 — custom product pages (App Store Connect)

For the minority who *do* click the bio link — small slice, but perfectly clean.

1. App Store Connect → your app → **Custom Product Pages** → create one per account
   (limit is 35). Bonus conversion win: match each CPP's screenshots to the
   account's aesthetic — the graphics account's CPP leads with graphic-style shots,
   Sadie's with UGC-style lifestyle shots. Creative continuity from feed → store
   page measurably lifts conversion.
2. Each CPP gets a unique URL (`?ppid=…`). Put each account's CPP URL in that
   account's TikTok bio (directly or behind the link-in-bio tool).
3. Read it in App Store Connect → Analytics → filter by product page: impressions,
   downloads, and (with ATT caveats) proceeds per page.

**Sanity check (free):** App Store Connect → Analytics → Acquisition → sources.
Watch the App-Store-Search vs web-referrer split — it validates the funnel shape and
flags when something changes (e.g. TikTok loosening link handling).

## Sequencing

1. **Survey + PostHog identify** (Nourish app) — do first; everything joins to it. ~1h.
2. **RevenueCat → PostHog integration** — dashboard toggle. ~15 min.
3. **CPPs** — one per account, swap bio links. ~1h, no code.
4. **Collectors (3a)** in the Strategist run + Settings keys. A few hours.
5. **Correlation + weekly digest (3b)** — build after ~2 weeks of collected data
   exists; it's meaningless on day one.
6. **Hook steering (3c)** — flip `performanceContext()` to attributed data once 3a/3b
   are stable.

Total: roughly a day of work spread across two codebases, most of it here. The only
piece Sweatshop can't build itself is the survey screen in the Nourish app — and it's
the keystone; ship it first.
