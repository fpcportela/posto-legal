# SPEC.md: Bead Board Dashboard

## 1. Objective
The Bead Board is an isolated observability tool designed to visualize the internal state and execution flow of the `rb-ai-team` multi-agent factory. It bridges the gap between raw CLI output (the generated view `.beads/active.yaml`) and high-level product management by providing an intuitive, gamified 2.5D interface.

## 2. Architectural Decisions

### 2.1 Complete Isolation
- **Requirement:** The tool must reside entirely within `aiteam/tools/bead_board/`.
- **Reasoning:** Ensures that the dashboard can be seamlessly ported or upgraded across different `rb-ai-team` repositories without causing dependency conflicts or polluting the core LangGraph/FastAPI backend logic.

### 2.2 Server Proxy (`server.py`)
- Instead of building a heavy backend, `server.py` acts as a minimal proxy using Python's built-in `http.server`.
- **Routing:** 
  - `/` serves `room.html`
  - `/kanban` serves `index.html`
  - `/api/state` returns a JSON payload with the view `.beads/active.yaml`, the index `.beads/index.yaml` (legacy fallback: `.beads/archive/index.yaml`) and the current git `branch`. The views are generated (aiteam/docs/beads-schema.md §7); when `.beads/tasks/` is newer than them, the server first runs `node aiteam/scripts/beads-views.mjs --quiet` with a fixed argv, no shell and a 10 s timeout. The payload also has `elsewhere` (a list), `elsewhere_partial`, `elsewhere_available` (`false` when `node` or the script is missing or the command failed — an empty list alone cannot tell that from "nothing elsewhere") and `elsewhere_stale`: the beads that other branches and worktrees changed and that are not merged yet (aiteam/docs/beads-schema.md §13), taken from `node aiteam/scripts/beads.mjs status --json --quiet` (fixed argv, no shell, 20 s timeout — above the command's own 15 s `AGGREGATE_DEADLINE_MS`, so a `partial` by deadline reaches the UI instead of being killed first and turned into "unavailable"; a test pins that relation) and cached for 15 s, since the Kanban polls every 2 s. The server is single-threaded (`socketserver.TCPServer`) and the command takes ~2 s with 600 beads, so it is never run inside a request once there is a value to serve: an expired cache answers with the last value and `elsewhere_stale: true` while one background thread (at most one at a time, daemon) renews it; a renewal that comes back unavailable replaces the value (the board then says "indisponível") and one that raises leaves the old value, still stale, to be retried on the next request. Only the first query (cold cache, nothing to serve) runs the command in the request, and `server.py` warms the cache at startup. The command runs as a tracked child (`Popen`, stdin closed): an `atexit` hook kills the one in flight, so Ctrl+C or a shutdown does not leave the `node` process orphaned (the background thread is a daemon and dies with the server, and its timeout with it). Each item: `{id, title, aqui, la, fontes}` — `aqui` is the state in this tree (`null` for a bead that only exists elsewhere), `la` the combined state with the other sources, `fontes` where it comes from (`origem`: `<ref> (local <sha7>)`, `<ref> (worktree, não commitado)`, never a remote by default). It is a preview: never merged into the generated views, never counted in the column totals.
- **Not-merged marks (UI):** the Kanban draws a dashed *ghost card* (`↗ <origem> · não mergeado`) for a bead that exists only elsewhere, in the column of its state there, and a badge on the local card when the state there differs (the status of there, plus the stage next to it when that is what differs: `↗ in_progress (implement → review) em <origem> · não mergeado`, or `(review)` when this tree has no stage); the room animates the desk as working, with a `↗`, when the bead is `in_progress` elsewhere, and lists it in the desk history — one row per bead: a bead that also exists in this tree keeps its local row (the state of this branch), which gets the `↗ <state there> em <origem> · não mergeado` mark instead of a second row. When the aggregation is partial (`elsewhere_partial: true`) or unavailable (`elsewhere_available: false`, which wins), both pages show a discreet fixed-text note — `↗ agregação parcial` / `↗ agregação indisponível` — in the Kanban header and in the room status panel, set with `textContent` and only for a real `true`/`false` (a server without the fields shows nothing; a stale value alone is not a warning, it happens every 15 s). Every text from another branch goes through `esc()` before it becomes HTML.
- This prevents CORS issues and file-protocol (`file://`) security blocks that browsers enforce when reading local files via fetch.

### 2.3 Image Hotspot Pattern
- Rendering a true 3D or Canvas-based isometric environment introduces immense complexity and dependency overhead.
- **Solution:** We use static AI-generated isometric illustrations (`office_bg.png` and `sv_office_bg.png`) as CSS background images. We map interactive zones using absolute-positioned CSS `div` elements (hotspots).
- This provides AAA visual fidelity with near-zero performance cost.

### 2.4 State Machine & Client-Side Polling
- **Polling:** The frontend polls `/api/state` every 2000ms.
- **Parsing:** The browser uses `js-yaml` to parse the YAML string into a JS object.
- **Node Routing:** A heuristic function (`getPersonaDeskId`) scans the `task.id` for keywords (e.g., 'ui', 'api', 'spec') to route the task to the appropriate agent node (Frontend, Backend, PM, Orchestrator). The keyword table is the contract defined in `aiteam/docs/beads-schema.md` §5 — agents MUST prefix bead ids accordingly, and changes to the table must update both places.
- **Input Contract:** All YAML consumed by the board is generated by `aiteam/scripts/beads-views.mjs` from beads that follow `aiteam/docs/beads-schema.md` (enforced by `npm --prefix aiteam run validate:beads` and the pre-commit hook). The frontend additionally hardens against malformed data: ids are string-coerced, `description` falls back to `title`, numbers are `parseFloat`-coerced, and all task text is HTML-escaped before injection.
- **Animation States:** DOM manipulation adds/removes `.working` and `.idle` CSS classes, triggering CSS keyframe animations (no heavy JS animation libraries used).

## 3. Design System (Stitch Methodology)

The dashboard implements a dual-theme architecture driven by a `<body data-theme="...">` toggle.

### 3.1 Theme: Retro Gamer (`data-theme="gamer"`)
- **Vibe:** Fun, chaotic, nostalgic.
- **Typography:** `Press Start 2P`.
- **Avatars:** Oversized emojis (🎨, 🤖) with CSS drop shadows.
- **Animations:** Bouncy, rapid vertical translations (`translateY`).
- **Kanban:** Designed to look like a physical corkboard with pixel-art pins and yellow paper cards.

### 3.2 Theme: Silicon Valley (`data-theme="sv"`)
- **Vibe:** Premium SaaS, professional, clinical.
- **Typography:** `Inter`.
- **Avatars:** Sleek SVG icons encapsulated in circular glass badges.
- **Animations:** Slow opacity pulses (breathing) and continuous rotating dashed rings (data processing).
- **Kanban:** Flat white UI, soft box shadows, rounded corners, similar to Linear or Trello.
- **Popovers:** Replaces retro speech bubbles with frosted `backdrop-filter: blur(12px)` glassmorphism tooltips.

## 4. Future Roadmap & Out of Scope
- **Out of Scope (Current):** Bi-directional editing. The dashboard is strictly read-only. Beads change by appending entries to `.beads/tasks/<id>/<branch>.yaml`, never by editing the views.
- **Future:** If the multi-agent system evolves beyond 4 core roles, the `getPersonaDeskId` function and the hardcoded CSS desk hotspots will need to be refactored into a dynamic grid system.
