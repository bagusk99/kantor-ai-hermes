# Kantor Kita (Our Office)

The visual style follows a warm office reference: light wood, parquet floors, leafy plants, padded chairs, and sage sofas. Chibi avatars use oval heads, voluminous hair, simple faces, rounded bodies, and share the same animation rig. Ivory white panels use dark green accents. Reference images serve as a style guide, not a guarantee of identical rendering. The cardboard/soft block style notes below are historical progression markers.

All interface text is in English.

A four-story office diorama with a dynamic team list, open workspace, and local task management. Names and roles follow the active Hermes profiles list. The floor plan, furniture, and human figures are illustrative interpretations, not exact measurements or portraits.

The appearance mimics a cardboard architectural diorama: cream colors, ink lines on object edges, and a single brick-red accent. Avatars have a blocky style, with jointed limbs and simple faces. Each team member uses either a long-haired female variant or a short-haired male variant, assigned alternately. Everything remains illustrative. Work animations, chatting, drinking, taking calls, and other routines run continuously.

Labels, team selectors, details, logs, and tasks display member initials. The storage identity uses the full name so tasks, desk groups, and prayer room preferences remain matched.

## Exploring the Office

- **01:** Barber, chairs and mirrors, waiting area, car and motorcycle parking.
- **02:** Kitchen, stove, sink, fridge, and two shared dining tables.
- **03:** Open workspace with four desk groups on their respective rugs. Idea boards separate Leadership and Marketing & Business, while low shelves separate Engineering & Design and Customer Service. There is a glass meeting room, two phone booths, a glass-walled pantry & lounge, a prayer room, pendant lights, and windows.
- **04:** Rooftop garden following the fourth reference: wooden floor, lounge under a pergola, shared table with sage chairs, coffee bar, edge planters, and warm lanterns. A billiard table is available. The team randomly chooses spots, including the sofa, tables, billiards, and coffee bar; stair access remains on the left.
- **View whole building:** All four floors are visible with a two-flight staircase on the left side connecting each floor. Click any floor to enter. In this view, the floors are stacked tightly like a real building: floors 1 to 3 have glass walls, the stairs are in a glass tower on the left, and the parking side of floor 1 is left open. The floor contents remain visible through the glass; click a floor's glass to enter it. Transitioning between a single floor and the whole building uses a 1.4-second camera animation. The animation is skipped if the system prefers reduced motion, and stops instantly if the screen is touched or dragged. This view also displays a round city base with roads, trees, other buildings, distant slow-moving clouds, and circling birds. When a single floor is selected, only that floor is shown; external stairs and people on the stairs are only visible in the whole building view.

Drag to rotate and tilt the camera. Shift + drag or right-click to pan, scroll or pinch the trackpad to zoom, two-finger swipe sideways to rotate. On touch screens: one finger rotates, two fingers pinch and pan. Keyboard: arrows rotate/tilt, W A S D pan, Q/E zoom. **+**, **−**, **Rotate**, and **Reset** buttons remain available.

**Character cameras:** Select a team member, then **First-person view** or **Follow from behind**. Drag or use arrow keys to look around, scroll or pinch for the rear camera distance. The camera follows the character across floors when they use the stairs. Press Esc, **Exit camera**, or **Reset** to return to the diorama view.

The meeting room, both phone booths, the prayer room, and the pantry & lounge have doors that open automatically when someone approaches, then close behind them.

On floor 3, the team has their own routines: approaching colleagues to chat, getting drinks in the pantry, resting in the lounge, taking calls in the phone booth, reading the idea board, having small meetings for two or three, or standing up to stretch. Speech bubbles alternate to indicate who is talking. A maximum of four people leave their desks at once, and characters with active tasks leave their desks less often. **Routine: on/off** stops new activities; ongoing ones are finished before returning to desks. Routines default to off if the system prefers reduced motion.

**Office log** records simulation events and task status changes, newest at the top. It contains simulation events, not AI messages. On small screens, the log is opened via the **Log** button.

**Prayer time** sends members who have **Join at prayer time** checked (in the character detail panel) to the prayer room. None are checked by default, and no one is sent automatically. Preferences are saved in the browser. The prayer room accommodates eight prayer mats.

**Lunch**, **To the rooftop**, and **Back to work** move the team via the visible 3D stair path. The camera and currently viewed floor do not change when an activity command is given. From the whole building view, the journey can be observed without changing views. If the destination changes while on the stairs, characters reach the next landing before heading to the new destination. **Pause** stops the journey at the current position. 

**Music** plays relaxing synthetic instrumentals (soft chords, bass, and melody at 72 BPM), generated via Web Audio without external audio files. Click again to stop it. The **Vol.** slider saves the volume in the browser. The music always starts muted when the page loads; user interaction is required to play. Pausing the simulation does not stop the music.

## Task Management

- Click **Tasks** at the top or select a character then **View / assign tasks**.
- Fill in the work, assignee, and optional instructions. The task goes into the queue.
- Use status or assignee filters to search for tasks. **Show character** closes the panel and opens the floor where the character is located.
- Click **Export tasks** to download a JSON copy.

## Hermes Integration (AI Agents & Server)

When run using the Node.js server, this application acts as a visual wrapper and proxy for **Hermes Agent**. It reads profiles and connects to **Hermes Kanban** (`kanban.db`).

Team members shown in the office are actual Hermes AI profiles on your system. AI agents will automatically process tasks assigned to them behind the scenes, while our office UI provides the visualization.

### Hermes Setup

1. Ensure **Hermes CLI** is installed on your system.
2. Initialize a Kanban board if you haven't already:
   ```sh
   hermes kanban init
   ```
3. To add AI agents, you can create them directly from the web UI using the **+ New profile** button, or via CLI:
   ```sh
   hermes profile create frontend_dev
   ```
4. **Configure Webhook (Optional but Recommended):**
   To allow the office UI to react in real-time when an agent uses a tool, claims a task, or blocks a task, add this webhook configuration to your `~/.hermes/config.yaml`:
   ```yaml
   hooks:
     outbound:
       - name: kantor-ai-sync
         url: http://127.0.0.1:3000/api/webhook/hermes
         events:
           - kanban_task_claimed
           - kanban_task_completed
           - kanban_task_blocked
           - pre_tool_call
           - post_tool_call
   ```

### Running the Server
```sh
npm start              # or: node server/server.js  (Node 22+)
```
Open http://127.0.0.1:3000.

- **AI Processing:** To let the AI agents start working on queued tasks, you need to run the Hermes gateway. Open a new terminal and run: `hermes gateway start`. Hermes will pick up tasks assigned to its profiles and work on them.
- **Task Lifecycle:** The AI moves tasks from **Queued → In progress → Review / Needs decision / Done**. 
  - If the agent needs a human decision (Needs decision / Blocked state), you can reply via the UI using the **Your answer** form, or bypass the questions entirely by clicking the **Mark done** button on the task card.
- **Profile Management:** In the web UI, you can fully manage your Hermes profiles:
  - **Create:** Click "+ New profile" in the top header.
  - **Edit:** Select an avatar, click "Edit Hermes profile" to update their Name, Description, and `SOUL.md`.
  - **Delete:** Permanently delete a profile directly from the right-side detail panel.
  - **Seating:** Assign a profile to a specific desk area (Leadership, Marketing, etc.) using the "Desk group" dropdown in their detail panel. These settings are persisted to the server (`data/team-overrides.json`).
- The server does not have login authentication yet, so it only listens on 127.0.0.1 (localhost). Do not expose it to public networks without authentication.

Tasks are visible directly in the office:

- **Speech bubbles**: Characters say "On it!" when a task starts and "Done!" when finished. AI agents show "Drafting…" while working.
- **Task board** on floor 3 shows up to five open tasks with their initials and status.
- **Summary** above the Office log: number of people working on tasks, free people, and tasks completed today.

## Structure

- `public/index.html`: Page structure and task panels.
- `public/office.js`: 3D floors, team data, movement, camera, Hermes profile management, and task integration.
- `public/office.css`: Floor navigation, member panels, and responsive controls.
- `public/tasks.js`: Task UI, validation, storage, filters, and exports.
- `public/tasks.css`: Responsive task panels, keyboard focus, and form styles.
- `public/music.js`: Instrumental composition, playback controls, and volume.
- `server/server.js`: Local Node.js server serving static files and acting as an API proxy to the Hermes CLI/Kanban.

## Browser Tests

`tests/avatar-stairs.cjs` checks avatar variants, initials, task compatibility, 3D positions when using stairs, pauses, destination changes, camera tracking, music, saved volumes, and 375/768/1440px layouts. Run with `node tests/avatar-stairs.cjs`.

`tests/office.cjs` tests team count, floor switching, clicking floors from the building view, character cameras, automatic doors, camera orbit/pan/zoom, automatic routines, office log, prayer room preferences, character selection, tasks, travel, responsive display, and task migration. Run the local server first, then `node tests/office.cjs` with Playwright installed. Add `--visual` to only check floors and take screenshots.

## Member and Division Instructions

Select an avatar or initials in **Team member**. The detail sheet shows **Active task**, its instructions, and **View / assign tasks**. A brick-red underline marks an avatar with an active task; its accessible label and tooltip include the task title. The task remains visible while the character travels or takes a break.

Under **Send instructions to**, choose the selected person, their division, or **Choose people…** for a custom group. **Meet together**, **Lunch**, **Rooftop**, and **Back to work** apply only to that selection and preserve the current camera. The footer still commands the whole team. Meeting places are reserved before anyone moves; an invitation that exceeds the available six seats is rejected without moving a partial group. Explicit meetings last until participants receive another command.

`tests/member-commands.cjs` covers selection scope, room capacity, empty selection, meeting arrival, camera preservation, active-task display, and responsive detail panels.

## Soft-block Avatars

Heads, torsos, limbs, hair and shoes use rounded block geometry shared between characters. Joint poses blend over time instead of snapping between walking, sitting and activities. Small weight shifts, breathing, alternating typing/mouse poses and head turns vary by person. Characters slow down near their final destination. Barber characters share the rounded shapes and pose blending.

`tests/soft-avatar.cjs` exercises character cameras, stairs, pause and arrival at lunch, with screenshots of the new figures. 

## Evening Building Overview

**View whole building** uses a closer camera, navy panels, warm floor lights and a muted dusk sky. Individual floors keep the warm daylight interior. Navigation thumbnails are captured from the actual 3D floors at startup. Counts show team members currently on each floor, excluding people on the stairs and barber visitors; they are not online-presence indicators. Mobile navigation uses compact floor labels and counts instead of thumbnails. No analytics or account controls are implied.

`tests/building-view.cjs` checks thumbnail loading, counts, clicking a floor through the facade, theme switching and 375/768/1440px layouts.

## Review and Task Reliability Updates

Manual results and revision comments are stored temporarily in the browser tab's sessionStorage, so list updates and reloads do not clear unsent drafts. Revision comments are tied to the draft version. Approvals use the task version so old views do not approve changed drafts.

Workers use execution identities: late results or errors do not alter a reassigned task. The API validates the assignee and the one-active-task-per-person limit. Restart the server after updating backend code.

`tests/server.cjs` checks the draft, revision, approval cycles, and text recovery after polling/reloading with dry-run. `tests/worker-reliability.cjs` uses a mock local provider to check for late errors after task reassignment. These tests do not call paid AI services.
