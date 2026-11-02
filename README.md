<p align="center"><img src="public/icon-512.png" alt="3DPMQ logo" width="128"></p>

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
- Enter name, **e-mail** and **class**, pick a filament from the makerspace's list (pre-selected from the G-code colour), add a note.
- Public queue with live status, queue position and progress; cancel your own request while it is pending/approved.

**Automatic validation** (all limits editable by staff on the *Rules* tab)
- File is G-code from PrusaSlicer, with readable metadata
- Printer profile matches a printer you actually have (`MK4` ≠ `MK4S`), nozzle diameter matches
- Material allowed (default PLA, PETG), chosen filament matches the sliced material, filament in stock
- Max print time, max grams, max nozzle / bed temperature actually used in the file
- Dangerous commands rejected (`M997` firmware update, `M500–M503` settings, `M301/M303` PID, `M92`, `M112`, …); `M600/M0/M1` pauses warn
- Multi-material off by default; max open requests per person; optional monthly gram quota per person (people are identified by their e-mail address)

**For staff** (shared password)
- Review queue with all details and the G-code download; approve / reject with reason; priority up/down
- Printers: add by IP, test connection, set which filament is loaded, "bed is clear" button, pause / resume / stop
- *Start* uploads the file over PrusaLink and starts printing; or enable **auto-start** per printer (starts the next eligible job only after someone pressed "bed is clear")
- **Refused and cancelled** requests are listed on the Review tab; remove them one by one or with *Clear all* (their files are deleted, finished prints are never touched)
- **People** tab: every person who ever submitted (students, staff, others) with e-mail, class, role and notes; search and filter by role / class; add, correct and remove people; statistics per person (see below); CSV export
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

Docker: `cp .env.example .env` (on Windows: `copy .env.example .env`), set `STAFF_PASSWORD` in `.env`, then `docker compose up -d --build`; open http://localhost:3000.
Data (database, uploaded G-code) lives in the `3dpmq-data` volume, so it survives updates (`git pull && docker compose up -d --build`).
The container must be able to reach your printers' IP addresses (the same network as the printers).
(The Dockerfile was written but **not yet built/tested** by its author; please report problems.)

### Unraid
GitHub Actions builds the image on every push to `main` (`.github/workflows/docker.yml`) and publishes it as `ghcr.io/<github-user>/3dpmq:latest` (lower-case).
If the package is private, make it public under the repository's *Packages* settings, or Unraid cannot pull it.
In the Unraid terminal create the data folder: `mkdir -p /mnt/user/appdata/3dpmq && chown 99:100 /mnt/user/appdata/3dpmq`.
Then *Docker → Add Container* (switch to *Advanced View* for the last field):

| Field | Value |
|---|---|
| Name | `3DPMQ` |
| Repository | `ghcr.io/<github-user>/3dpmq:latest` |
| Network Type | `bridge` (the server must be able to reach the printers' IP addresses) |
| Port | container `3000` → host `3000` (or any free port) |
| Path | container `/data` → host `/mnt/user/appdata/3dpmq` (read/write) |
| Variable | `STAFF_PASSWORD` = a long password |
| Variable | `TZ` = `Europe/Luxembourg` |
| Extra Parameters | `--user 99:100` (Unraid's "nobody"; lets the app write to appdata) |
| WebUI | `http://[IP]:[PORT:3000]/` |

Updating: *Docker → Check for updates → apply*, or push a change and re-pull the image. Not yet tested on a real Unraid server.

Try it without printers: `npm run mock` starts two fake PrusaLink printers on `:8081` / `:8082` (user `maker`, password `test`).

### Setting up a printer
1. On the printer enable PrusaLink (Settings → Network) and note the IP, username (`maker`) and password / API key.
2. 3DPMQ → Staff → Printers → *Add printer*: address `http://<ip>`, username, password,
   **model exactly as in the G-code** (the `printer_model` value, e.g. `MK4S`, `MINI`, `XL`, `COREONE`), nozzle.
   Use *Test connection*, then set the loaded filament.
3. Give users a PrusaSlicer tip: export with **Ctrl+G** and choose the right printer profile.

Environment variables: `STAFF_PASSWORD` (required), `PORT`, `DATA_DIR`, `POLL_MS`, `MAX_UPLOAD_MB`, `RETENTION_DAYS` (G-code files of finished jobs are deleted after this), `SESSION_SECRET`.

## People and statistics
Every request is linked to a person. A person is created automatically from the first request (name, e-mail, class) and recognised by e-mail address afterwards (case-insensitive).
The public form never overwrites an existing person: if someone types a different name or class for a known e-mail, staff see a note on the request and can correct the record on the People tab.
Staff and other users are people too, with the same fields, statistics and edit/remove options; set the *role* to Staff or Other (the class is then not required).
Corrections to a person also update the name, e-mail and class shown on their requests.

**Statistics** (per person, per material, per month; overall and per class on the People tab and in the CSV): the number of completed prints, the weight of plastic and the print time.
A finished print counts in full; a print that was stopped or failed part-way counts by the share that was printed (last progress reported by the printer). Weights are the slicer's estimate; print time is the time the printer reported (or the elapsed time if it reported none).

**Removing a person** is only possible when they have no open requests. *Remove person* erases name, e-mail, class and notes everywhere (requests, audit log, uploaded files) and keeps the prints as anonymous statistics; *Remove incl. all requests* also deletes their requests and the statistics.
Only staff can see e-mail addresses and classes; the public queue shows names only.

**Upgrading from an older version:** the database is migrated automatically on start. Existing requests are grouped into people by e-mail (or by name when there was none). People without an e-mail or class are marked with a warning on the People tab so staff can complete them.

## Releases and versions
The version lives in one place, `package.json`, and is shown in the page footer, the server log and `/api/config`. Changes are listed in [CHANGELOG.md](CHANGELOG.md).
Numbers follow `MAJOR.MINOR.PATCH` (`0.11.0` = "version 0.11"): bump the minor number for new features, the patch number for fixes.

To publish a new version:
1. Add the changes under `## [Unreleased]` in `CHANGELOG.md` while you work. When releasing, rename that heading to the new version and date and add a fresh empty `[Unreleased]` above it.
2. Commit, then run `npm version minor` (or `patch`). This updates `package.json` and `package-lock.json`, commits, and creates the git tag `v0.12.0`. (`npm version 0.12.0` sets an exact number.)
   Without npm (for example on a PC without Node.js): change `version` in `package.json` and in the two places at the top of `package-lock.json`, commit, then run `git tag -a v0.12.0 -m "Version 0.12.0"`.
3. `git push --follow-tags`. GitHub Actions then builds the image and publishes it as `ghcr.io/<github-user>/3dpmq:0.12.0` **and** `:latest`.

On Unraid you can pin the exact version (`...:0.12.0`) in the container's *Repository* field instead of `:latest`, so updates only happen when you change it.
Optional: set `SOURCE_URL` (environment variable) to your repository address to show a "source code" link in the footer.

### Logo and icons
`public/logo.svg` (mark, transparent) and `public/favicon.svg` (app icon with background) are the sources; `icon-512.png`, `icon-192.png`, `apple-touch-icon.png` and `favicon.ico` are exported from them.
The logo is an original design (a block of printed layers, top layer with infill lines) released under the same license as the code.
For the Unraid Docker tab, set the container's *Icon URL* (Advanced View) to
`https://raw.githubusercontent.com/<github-user>/3DPMQ/main/public/icon-512.png`; this works once the repository is public.

## Tests
- `npm test` — (1) `.bgcode` reader checks on real encoder output in `test/fixtures`, (2) end-to-end with a real server and two mock printers: validation rules, approval, upload, auto-start, limits, access control.
- `BGCODE_BIN=/path/to/bgcode npx tsx test/bgcode.ts` — full cross-check: encodes the sample with every compression / encoding / checksum combination using Prusa's `bgcode` tool (build it from https://github.com/prusa3d/libbgcode) and compares the decoded commands with the original.
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

**Binary G-code (`.bgcode`).** Fully read: metadata and the G-code itself, with all compression types (none, Deflate,
Heatshrink 11/4 and 12/4), all encodings (plain, MeatPack, MeatPack with comments) and CRC32 checks, so the same limits
(temperatures, forbidden commands, pauses) apply as for plain G-code. This was verified against Prusa's own open-source
encoder (libbgcode) on 96 combinations of settings, but **not yet on a file exported by your PrusaSlicer**. If a real
export is rejected as unreadable, please report it. Corrupt or truncated files are rejected. Scanning takes roughly 1.5 s per 8 MB of binary file.

**Security model is deliberately simple** — meant for a trusted LAN:
- Users are not authenticated: the name is whatever they type. Staff share one password (12 h cookie, login rate-limited).
- Printer passwords are stored in plain text in the SQLite file (they have to be, to talk to the printer). Protect `DATA_DIR`.
- No HTTPS built in; put it behind a reverse proxy (Caddy/nginx) if it is reachable beyond the makerspace network.
- Validation catches mistakes and obvious abuse; it is not a sandbox. Staff review is the real safeguard.

**Not included** (compared with a commercial platform like SimplyPrint): cloud slicing, camera streams / AI failure detection,
SSO, e-mail notifications (e-mail is only collected), non-Prusa printers (the PrusaLink client in `src/prusalink.ts` is the one place to add other brands), a mobile app, multi-language UI.

## License

3DPMQ is free software, licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). See [LICENSE](LICENSE).
Copyright (C) 2026 Philippe Kirsch.

In short: you may use, study, change and share it, including running it in a makerspace or school, without any extra obligations as long as you run it unmodified or only for your own use.
If you modify it and let others use your modified version over a network, you must offer those users the source code of your version under the same license (section 13).
This is a plain-language summary, not legal advice; the license text is what counts.

### Third-party software
3DPMQ contains no code copied from other projects. It depends on open-source packages, all under permissive licenses that are compatible with the AGPL
(checked against the installed dependency tree: 135 packages, MIT 109 · Apache-2.0 21 · ISC 4 · BSD-3-Clause 1):

| Used for | Package | License |
|---|---|---|
| Web server | Express | MIT |
| File uploads | Multer (with busboy, streamsearch) | MIT |
| Language / build | TypeScript | Apache-2.0 |
| Development runner | tsx | MIT |
| Database | `node:sqlite`, built into Node.js | MIT (Node.js) |

Optional, for the browser test `test/ui.ts` only (not part of the repo's dependencies, install yourself): Playwright (Apache-2.0) with Chromium (BSD-3-Clause and other open-source licenses).
The Docker image is based on the official `node:22-alpine` image.

The PrusaLink API and the binary G-code format (libbgcode) were used as documentation only; PrusaLink itself is a separate program that 3DPMQ talks to over the network.
"3DPMQ" is not affiliated with Prusa Research or SimplyPrint; product names belong to their owners.

If you re-use the dependency list, re-run a license check after adding packages (for example `npx license-checker --summary`).

## Layout
```
src/gcode.ts      G-code metadata parser, validation rules
src/scan.ts       line scanner (temperatures, forbidden commands)
src/bgcode.ts     binary G-code reader (Heatshrink, MeatPack, Deflate, CRC32)
src/prusalink.ts  PrusaLink v1 client with HTTP Digest auth
src/server.ts     REST API, queue, scheduler/poller, SSE, staff auth
src/db.ts         SQLite schema, rules
public/           web UI (no build step)
mock/             fake PrusaLink printers
test/             .bgcode + end-to-end + UI tests, fixtures, sample G-code generator
```
