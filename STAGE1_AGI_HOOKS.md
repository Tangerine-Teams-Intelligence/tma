# Stage 1 — Context AGI Future-Proof Hooks

**Status:** Active spec. All Stage 1 agents (W2+) MUST conform.
**Stage 2 (~6 mo out):** plugs the actual reasoning loop into these hooks.
**Goal:** Stage 1 ships a correct data backbone with every component pre-wired so Stage 2 doesn't need schema migration.

---

## Background

CEO direction (locked):

> Tangerine = **Context AGI for AI-native teams**. Continuous reasoning over team work, ensures every member + their AI tools are synchronized.

Stage 1 = ingest + index + multi-source + basic UX (data backbone). Stage 2 = reasoning loop + world model + multi-agent + personalization.

For Stage 2 to plug in cleanly, **Stage 1 schema and component contracts must reserve the right slots from day one.**

---

## Hook 1 — Atom schema additions (CRITICAL — ship in Stage 1)

Every atomic event written by ANY source connector MUST include these fields, even if they are null/empty defaults in Stage 1:

```yaml
---
id: evt-2026-04-26-aBc12dEf
ts: 2026-04-26T14:32:11Z
source: discord | linear | github | slack | calendar | system
actor: daizhe
actors: [daizhe, david]
kind: meeting_chunk | decision | pr_event | comment | ticket_event | brief | summary
refs: { ... }
status: active
lifecycle: { ... }
sample: false

# === Stage 2 hooks — Stage 1 ships them with defaults ===
embedding: null            # vector[1536] — Stage 2 fills via OpenAI ada / Cohere / local
concepts: []               # entity list — Stage 2 fills via NER + concept resolution
confidence: 1.0            # 0-1 — Stage 1 = 1.0 (raw). Stage 2 = LLM-graded freshness/correctness
alternatives: []           # alternative interpretations — Stage 2 fills when ambiguous
source_count: 1            # how many independent sources confirm this — Stage 2 cross-references
reasoning_notes: null      # Stage 2 reasoning loop annotations
sentiment: null            # tone analysis — Stage 2 fills
importance: null           # 0-1 — Stage 2 fills (vs raw recency)
---
<markdown body>
```

**Why these 8 fields?** Each maps to a Stage 2 capability (see table at bottom).

**Validation:** every atom write passes through `validate_atom(atom)` which enforces the full schema. If a connector forgets a field, the validator injects the default. **No atom without all 8 future fields.**

---

## Hook 2 — Event Router subscription API

`event_router.process(atom)` MUST emit an event after fan-out:

```python
# Python
@event_router.on_atom
def my_handler(atom: dict, fanout_paths: list[str]):
    """Called after every atom is written + distributed."""
    pass
```

Stage 1: 0 subscribers (just the fan-out runs).
Stage 2: reasoning agents subscribe — concept extractor, conflict detector, brief composer, etc.

**Reserve the dispatcher mechanism in Stage 1**, even if no subscribers exist yet.

---

## Hook 3 — Daemon extension points

Daemon runs every 5 min. MUST expose extension points:

```rust
// Rust
pub struct DaemonExtension {
    pub name: &'static str,
    pub schedule: Schedule,        // every-N-min, daily, on-event
    pub run: Box<dyn Fn(&DaemonCtx) -> Result<()>>,
}

impl Daemon {
    pub fn register_extension(&mut self, ext: DaemonExtension) { ... }
}
```

Stage 1 built-in extensions:
- `git-sync` (pull/push every 5 min)
- `index-rebuild` (timeline.json refresh)
- `alert-detect` (stale/overdue/thrash basic rules)
- `brief-generator` (daily, simple template)

Stage 2 will register additional extensions:
- `embedding-refresh` (compute vectors for new atoms)
- `concept-extractor` (NER + concept graph update)
- `world-model-update` (team state inference)
- `personalization-trainer` (learn per-user preferences)
- `coach-agent` (proactive insight generator)

Daemon doesn't need to KNOW about Stage 2 extensions — they register themselves. Just need the registry mechanism.

---

## Hook 4 — MCP response envelope

Every MCP tool response MUST wrap its payload in this envelope:

```json
{
  "data": { ... actual response ... },
  "confidence": 1.0,
  "freshness_seconds": 60,
  "source_atoms": ["evt-...", "evt-..."],
  "alternatives": [],
  "reasoning_notes": null
}
```

Stage 1: confidence = 1.0, alternatives = [], reasoning_notes = null (defaults).
Stage 2: confidence is real, alternatives surface when ambiguous, reasoning_notes explains why.

The MCP CLIENT (Cursor / Claude Code) can show confidence indicators to user from day 1, even if always 1.0. Stage 2 makes them meaningful.

---

## Hook 5 — View "Tangerine Notes" reserved area

Every UX view (`/today`, `/people/<x>`, `/projects/<x>`, `/threads/<x>`, `/alignment`, `/inbox`) MUST reserve a top-of-page area for "Tangerine notes":

```tsx
{tangerineNotes.length > 0 && (
  <section className="tangerine-notes border-l-4 border-orange-500 ...">
    {tangerineNotes.map(note => <NoteCard {...note} />)}
  </section>
)}
```

Stage 1: `tangerineNotes = []` (always empty). Component still mounts.
Stage 2: reasoning loop pushes insights here:
- "/today: thrashing detected on pricing thread, suggest decision draft"
- "/people/eric: Eric hasn't ack'd 5 decisions, here's a brief to send"
- "/projects/v1-launch: timeline slipping by 30%, here's what's blocking"

UX layout doesn't change between Stage 1 and Stage 2. Just content fills in.

---

## Hook 6 — Vector index slot

`<root>/.tangerine/index.json` schema MUST include:

```json
{
  "version": 1,
  "atoms": [...],
  "vector_store": {
    "type": "none",          // Stage 1
    "dimensions": null,
    "model": null
  }
}
```

Stage 1: `vector_store.type = "none"`.
Stage 2: switches to `"sqlite-vec"` or `"turso"` or `"pinecone"`, populates from `atom.embedding`.

Search functions MUST check `vector_store.type` and fall back to substring (Stage 1) vs vector (Stage 2) cleanly.

---

## Hook 7 — Personalization profile

`<root>/.tangerine/cursors/<user>.json` MUST reserve:

```json
{
  "user": "daizhe",
  "last_opened_at": "...",
  "atoms_viewed": {...},
  
  "preferences": {
    "brief_style": "default",     // Stage 1: only "default". Stage 2: "terse" | "detailed" | "numbers-first"
    "brief_time": "08:00",        // Stage 1: fixed 8 AM. Stage 2: learned from open patterns
    "notification_channels": ["os", "email"],  // Stage 1: fixed. Stage 2: learned
    "topics_of_interest": [],     // Stage 2 fills from interaction patterns
    "topics_to_skip": []          // Stage 2 learns
  }
}
```

Stage 1: defaults only. Stage 2: trainer extension updates preferences.

---

## Hook 8 — World Model file

Reserve `<root>/.tangerine/world_model.json`:

```json
{
  "version": 1,
  "team_state": {
    "members": {
      "daizhe": { "role": "founder", "focus": null, "load": null },
      "david": { "role": "engineer", "focus": null, "load": null }
    },
    "active_projects": [],
    "open_threads": [],
    "recent_decisions": [],
    "team_health": {
      "alignment": null,
      "velocity": null,
      "thrash_score": null,
      "decision_freshness": null
    }
  },
  "last_inference_at": null
}
```

Stage 1: alignment computed (real number from cursors), rest null.
Stage 2: reasoning loop maintains team_state continuously.

---

## Mapping: hooks → Stage 2 capability

| Hook | Stage 2 Capability Unlocked |
|------|------------------------------|
| 1.embedding | Vector search, semantic similarity, "find similar past discussions" |
| 1.concepts | Concept graph, entity-linked browsing, "everything about postgres" |
| 1.confidence | Trust calibration, AI uncertainty surfacing |
| 1.alternatives | "AI thinks A but also B and C — pick" |
| 1.source_count | Cross-source verification, "3 sources agree" |
| 1.sentiment | Tone analysis, conflict detection, "david seemed frustrated" |
| 1.importance | Priority ranking beyond recency |
| 2.event subscriptions | Real-time reasoning agents |
| 3.daemon extensions | Plug-and-play reasoning capabilities |
| 4.MCP envelope | Calibrated AI responses |
| 5.tangerine-notes | Proactive insight surfacing |
| 6.vector index | Semantic search, "what's relevant to this prompt" |
| 7.personalization | Per-user adapted briefs/views |
| 8.world model | Team state inference, predictive briefing |

---

## Estimated Stage 2 work (after Stage 1 ships)

| Component | Effort |
|---|---|
| Vector index + embedding pipeline | 1 week |
| Concept graph + NER pipeline | 1.5 weeks |
| Multi-agent reasoning framework | 2 weeks |
| World model + inference loop | 2 weeks |
| Personalization trainer | 1.5 weeks |
| Trust calibration + uncertainty | 1 week |
| Coach / insight generator agents | 2 weeks |
| **Total Stage 2** | **~11 weeks (~3 months)** |

→ Stage 1 (9-10 weeks) + Stage 2 (~11 weeks) = **~5-6 months to Context AGI complete.**

---

## What Stage 1 ships WITHOUT (and Stage 2 fills)

- Real semantic search (Stage 1 = substring)
- Real per-user personalization (Stage 1 = same brief for all)
- Conflict / contradiction detection (Stage 1 = none)
- Predictive briefing (Stage 1 = scheduled fixed-time)
- Trust calibration (Stage 1 = always confident)
- Pattern recognition (Stage 1 = none)
- Proactive insights ("Tangerine Notes" area is empty)
- World model (Stage 1 = no team-state inference)

These are KNOWN GAPS. Stage 1 documentation must label these "Coming Stage 2" so users see the trajectory.

---

## Success criteria for "Stage 1 architecture is AGI-ready"

When CEO acceptance-tests Stage 1, I should be able to demo:

1. **Add a new atom field** (e.g., embedding) → Stage 2 doesn't need to migrate existing atoms (defaults populate)
2. **Register a new daemon extension** → 5 lines of code, no daemon refactor
3. **Subscribe to atom events** → 1 decorator/macro call
4. **Add a Tangerine Note to a view** → existing component renders without UI refactor
5. **Switch search backend from substring to vector** → 1 config change in `vector_store.type`

If all 5 demos work, Stage 1 architecture is AGI-ready. If any requires real refactor, hook is wrong — fix in Stage 1.

---

## For agents reading this

**You are implementing a Stage 1 component.** When you encounter a place where Stage 2 will need to plug in (per the table above), you MUST reserve the slot — even with default/empty value. Document the future use in inline comment.

If unclear which hook applies, default to: **add the field with sensible empty value + comment "// Stage 2: <what this becomes>"**.

This is non-negotiable. Adding the hooks adds ~5-10% to Stage 1 effort. Skipping them costs Stage 2 a full schema migration (~2 extra weeks + risk).
