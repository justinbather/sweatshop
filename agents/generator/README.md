# Generator agent

Turns a **brief** into shoot-ready TikTok content concepts (hook, caption, script
beats, hashtags, visual direction, suggested Higgsfield model + credit estimate).

It does **not** spend Higgsfield credits — that stays behind the approval gate.
The Generator only produces concepts for a human to approve.

## Build order

1. **Generation core** (done) — `generate(brief) → Concept[]`. Pure, no Linear
   dependency. Test it standalone via the CLI.
2. **Linear pickup/writeback** (next) — poll Linear for tickets in a "Ready"
   state, run the core, post concepts back as a comment, move the ticket to
   "Needs Approval".

## Run the core

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run generate -- --topic "summer skincare" --count 3
```

Flags:

| Flag | Meaning |
|---|---|
| `--topic` | The brief / theme (stands in for a Linear ticket title) |
| `--details` | Extra context, angle requests, references |
| `--count` | How many distinct concepts (default 3) |
| `--audience` | Who it's for |
| `--constraints` | Hard rules, e.g. `"no faces, product must appear"` |
| `--json` | Emit raw JSON instead of the pretty view |

## Model notes

- Runs on **`claude-opus-4-8`** with structured output (Zod schema → guaranteed
  shape). `messages.parse()` validates the response for us.
- **No `temperature` knob.** Opus 4.8 rejects sampling params — the per-agent
  "temperature 0.8" idea from the project doc doesn't apply here. Creative
  variety is steered by the prompt (`src/prompt.ts`), which is the stronger lever
  anyway.

## Files

```
src/schema.ts    Zod output contract (mirrors the dashboard approval card) + Brief type
src/prompt.ts    system prompt — the TikTok content strategist
src/generate.ts  the generation core: brief -> concepts
src/cli.ts       run it against a brief and print concepts
```
