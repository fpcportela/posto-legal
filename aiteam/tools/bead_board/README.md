# Bead Board (Visual Observability Dashboard)

The **Bead Board** is a standalone, real-time visual observability dashboard designed for the `rb-ai-team` autonomous agent pipeline. It transforms raw state data (`.beads/active.yaml`) into an interactive, 2.5D animated environment, providing a gamified and highly professional way to monitor AI agents at work.

## Features

- **Real-time State Sync:** Automatically polls the generated view `.beads/active.yaml` to reflect the current project, branch, session phase, and individual task progress — and regenerates the view first when a bead file is newer than it.
- **Other branches, not merged yet:** beads that another branch or worktree changed (a dispatched subagent works on its own branch) are not in the generated views, which are only this tree's. The board asks `node aiteam/scripts/beads.mjs status --json --quiet` and shows them marked `↗ <origin> · não mergeado`: a dashed *ghost card* for a bead that exists only elsewhere, a badge on the local card when its state there differs (status, and the stage too when that is what changed), and a `↗` on the desk in the room when the bead is `in_progress` there. It is a preview, never the state of the current branch: the counters and the generated views stay local. When that reading comes back partial (the deadline ran out) or unavailable (no `node`/`beads.mjs`, or the command failed), the Kanban header and the room status panel show a discreet `↗ agregação parcial` / `↗ agregação indisponível` — otherwise an empty list would look the same as "nothing on other branches".
- **Dual Aesthetic Themes:**
  - 🎮 **Retro Gamer:** A fun, 8-bit pixel art isometric room with bouncing emoji avatars and a classic corkboard task wall.
  - 👔 **Silicon Valley (RB Ventures):** A sleek, professional, modern corporate UI featuring SVG icons, smooth glassmorphism popovers, and a clean SaaS-style Kanban board.
- **Alive Office:** Agents have distinct "idle" and "working" animations. Idle agents exhibit subtle breathing or randomized activities, while working agents show data processing rings or typing bounces.
- **Contextual Popovers:** Click on any agent's desk to view a speech bubble / tooltip containing their recent task history and execution summaries.
- **Interactive Kanban Board:** Click the whiteboard to open a detailed Kanban view of all `pending`, `in_progress`, and `completed` tasks, along with budget burn rates.

## Architecture

This tool is designed to be **100% isolated** within the `aiteam/tools/bead_board` directory to facilitate easy migration or drop-in upgrades to any standard `rb-ai-team` repository.

- `server.py`: A lightweight, zero-dependency Python HTTP server that serves static assets and exposes the `/api/state` endpoint (the view YAML, the index and the current git branch as JSON). When `.beads/tasks/` is newer than the views it runs `node aiteam/scripts/beads-views.mjs --quiet` — fixed argv, no shell, 10 s timeout. `/api/state` also carries `elsewhere` (the beads of other branches and worktrees, not merged yet), `elsewhere_partial`, `elsewhere_available` (`false` without `node`/the script, or when the command failed) and `elsewhere_stale`, from `node aiteam/scripts/beads.mjs status --json --quiet` — fixed argv, no shell, 20 s timeout (above the command's own 15 s deadline, so a `partial` by deadline reaches the UI instead of being killed first), cached for 15 s because the Kanban polls every 2 s. The server is single-threaded and the command takes ~2 s with 600 beads, so an expired cache does not wait for it: the request gets the last value with `elsewhere_stale: true` while one background thread renews it (only the very first query, with nothing to serve, runs the command in the request; `server.py` warms the cache at startup). Without `node` or without the script, `elsewhere` is empty and the board works as before.
- `room.html`: The main 2.5D visual entry point. Uses image-mapped CSS hotspots over pre-rendered isometric backgrounds.
- `index.html`: The detailed Kanban board, capable of running standalone or embedded within `room.html` via an iframe.

## Data Contract

The board renders the generated views: `.beads/active.yaml` (live beads) and
`.beads/index.yaml` (every bead, one per line — the Completed column shows the
latest completed ones). Both are generated from `.beads/tasks/<id>/<branch>.yaml`
and stay out of git. **The contract lives in
[`aiteam/docs/beads-schema.md`](../../docs/beads-schema.md)** — bead `id`
prefixes route beads to agent desks (§5), `status` must be one of
`pending | in_progress | completed | blocked`, and `description` is the Kanban
card text. The board falls back to the legacy `.beads/archive/index.yaml` on a
repo that has not migrated yet. Validate the beads with:

```bash
npm --prefix aiteam run validate:beads
```

The board is defensive about malformed data (missing fields render as fallbacks),
but only conformant YAML produces a correct visualization.

## Usage

1. **Start the Server:**
   From the root of your repository, run:
   ```bash
   python aiteam/tools/bead_board/server.py
   ```

2. **Access the Dashboard:**
   Open your browser and navigate to:
   ```
   http://localhost:8080/
   ```
   > The server binds to `127.0.0.1` only — it is a localhost-only dev tool by
   > design (it exposes `.beads` state, `SPEC.md`/`README.md`, and
   > `git worktree list`). It is not meant to be reachable from the LAN.

3. **Navigate:**
   - Click the **"View: Silicon Valley"** button to toggle themes.
   - Click on the **Whiteboard** to open the Kanban view.
   - Click on the **Desks (Avatares)** to see task histories.

## Dependencies

- Python 3.x (Built-in `http.server` and `socketserver`).
- JavaScript libraries (loaded via CDN in the frontend):
  - `js-yaml` (YAML parsing in the browser)
  - `marked` (Markdown rendering in the Kanban board)
