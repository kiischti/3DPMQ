# 3DPMQ – 3D Printer Makerspace Queue

Self-hosted print-request gateway for a makerspace with Prusa printers (PrusaLink).
Sits between PrusaSlicer and the printers: users submit sliced G-code through a web page, the server
**validates it**, **collects who/what filament**, staff **approve**, and the job is **queued and sent to a free printer**.

```
PrusaSlicer ──export G-code──▶ 3DPMQ (validate · name · filament · approve · queue) ──PrusaLink──▶ printers
```

## What it does

**For users** (no account needed)
- Drop a `.gcode` / `.bgcode` file; instant feedback: printer profile, material, colour, time, grams, and a list of problems *before* sending.
- Enter name (+ optional e-mail), pick a filament from the makerspace's list (pre-selected from the G-code colour), add a note.
- Public queue with live status, queue position and progress; cancel your own request while it is pending/approved.

**Automatic validation** (all limits editable by staff on the *Rules* tab)
- File is G-code from PrusaSlicer, with readable metadata
- Printer profile matches a printer you actually have (`MK4` ≠ `MK4S`), nozzle diameter matches
- Material allowed (default PLA, PETG), chosen filament matches the sliced material, filament in stock
- Max print time, max grams, max nozzle / bed temperature actually used in the file
- Dangerous commands rejected (`M997` firmware update, `M500–M503` settings, `M301/M303` PID, `M92`, `M112`, …); `M600/M0/M1` pauses warn
- Multi-material off by default; max open requests per person; optional monthly gram quota per person

**For staff** (shared password)
- Review queue with all details and the G-code download; approve / reject with reason; priority up/down
- Printers: add by IP, test connection, set which filament is loaded, "bed is clear" button, pause / resume / stop
- *Start* uploads the file over PrusaLink and starts printing; or enable **auto-start** per printer (starts the next eligible job only after someone pressed "bed is clear")
- Filament catalogue, rules, audit log, CSV export
- Live dashboard (Server-Sent Events): state, temperatures, progress, time left, who is printing what

## Quick start

Needs Node.js ≥ 22.13 (uses the built-in SQLite).

```bash
npm install
STAFF_PASSWORD='something-long' npm run dev     # http://localhost:3000
# production:
npm run build && STAFF_PASSWORD='something-long' npm start
```

Docker: `cp .env.example .env`, edit `STAFF_PASSWORD`, then `docker compose up -d --build`.
(The Dockerfile was written but **not built/tested** in the environment where this was created.)

Try it without printers: `npm run mock` starts two fake PrusaLink printers on `:8081` / `:8082` (user `maker`, password `test`).

### Setting up a printer
1. On the printer enable PrusaLink (Settings → Network) and note the IP, username (`maker`) and password / API key.
2. 3DPMQ → Staff → Printers → *Add printer*: address `http://<ip>`, username, password,
   **model exactly as in the G-code** (the `printer_model` value, e.g. `MK4S`, `MINI`, `XL`, `COREONE`), nozzle.
   Use *Test connection*, then set the loaded filament.
3. Give users a PrusaSlicer tip: export with **Ctrl+G** and choose the right printer profile.

Environment variables: `STAFF_PASSWORD` (required), `PORT`, `DATA_DIR`, `POLL_MS`, `MAX_UPLOAD_MB`, `RETENTION_DAYS` (G-code files of finished jobs are deleted after this), `SESSION_SECRET`.

## Tests
- `npm test` — end-to-end: real server + two mock printers; 53 checks (validation rules, approval, upload, auto-start, limits, access control).
- `npx tsx test/ui.ts` — drives the web UI in headless Chromium and saves screenshots to `test/shots/`.

## Honest limitations — read before relying on it

**Not yet tested against real hardware.** Everything above was verified against a mock written from the
PrusaLink OpenAPI spec. Digest authentication was cross-checked with `curl` and Python `requests`, but please run a
first-day checklist on one real printer:
1. *Test connection* shows the right state (IDLE).
2. Submit → approve → *Start* with a small file; confirm it appears on the printer and prints.
3. Check the job finishes in 3DPMQ (state `FINISHED`) and that *Stop* from the staff page works.

Specific assumptions to confirm on your firmware:
- Printer state names (`IDLE, READY, PRINTING, PAUSED, FINISHED, STOPPED, ERROR, ATTENTION, BUSY`) and `job.progress` being 0–100.
- *Stop* uses `DELETE /api/v1/job/{id}`; pause/resume use `PUT /api/v1/job/{id}/pause|resume`.
- Default storage name is `usb`; change it per printer if yours differs (e.g. `local`).
- Uploaded files are named `MQ<id>.gcode` / `.bgcode` on the printer's storage and are not deleted afterwards.

**Binary G-code (`.bgcode`).** Metadata is read (format taken from the libbgcode specification and tested on a synthetic
file, not a real PrusaSlicer export). The G-code *inside* is compressed, so temperatures/forbidden commands cannot be
scanned; such files get a warning. If you want the full scan for everything, turn off *Binary G-code* in PrusaSlicer's printer settings, or set a rule/process that rejects `.bgcode`.

**Security model is deliberately simple** — meant for a trusted LAN:
- Users are not authenticated: the name is whatever they type. Staff share one password (12 h cookie, login rate-limited).
- Printer passwords are stored in plain text in the SQLite file (they have to be, to talk to the printer). Protect `DATA_DIR`.
- No HTTPS built in; put it behind a reverse proxy (Caddy/nginx) if it is reachable beyond the makerspace network.
- Validation catches mistakes and obvious abuse; it is not a sandbox. Staff review is the real safeguard.

**Not included** (compared with a commercial platform like SimplyPrint): cloud slicing, camera streams / AI failure detection,
SSO, e-mail notifications (e-mail is only collected), non-Prusa printers (the PrusaLink client in `src/prusalink.ts` is the one place to add other brands), a mobile app, multi-language UI.

## Layout
```
src/gcode.ts      G-code / bgcode metadata parser, command scanner, validation rules
src/prusalink.ts  PrusaLink v1 client with HTTP Digest auth
src/server.ts     REST API, queue, scheduler/poller, SSE, staff auth
src/db.ts         SQLite schema, rules
public/           web UI (no build step)
mock/             fake PrusaLink printers
test/             end-to-end + UI tests, sample G-code generator
```
