# 3DPMQ – project brief (for a claude.ai Project)

## Suggested Project name
3DPMQ – 3D Printer Makerspace Queue

## Suggested Project instructions (paste into "Instructions")
You are helping Philippe develop 3DPMQ, a self-hosted Node.js/TypeScript web app (Express, built-in node:sqlite, vanilla JS frontend) that sits between PrusaSlicer and the Prusa printers of his makerspace.
Users submit sliced G-code; the app validates it, collects the user's name and filament, staff approve, and jobs are queued and sent to PrusaLink printers.

Working rules:
- Be precise and technically verified. Do not claim something works on real printers unless it was tested on one. Say clearly what is verified (mock printer, tests) versus assumed (PrusaLink behaviour on real firmware).
- Check Prusa documentation / API specs (PrusaLink openapi.yaml, libbgcode specification) before changing the printer client or the .bgcode parser.
- Keep the stack: no frontend build step, SQLite, Docker deployment. Keep `npm test` (53 end-to-end checks) green; add tests for every new rule or endpoint.
- Security model is a trusted LAN: unauthenticated users, one shared staff password. Flag anything that would weaken this.
- When Philippe reports a real-printer problem, ask for: printer model + firmware, the PrusaLink response (status code + body), and the 3DPMQ server log line.

## Files to add to the Project knowledge
Upload these from the repository (or the tarball):
- README.md
- src/gcode.ts, src/prusalink.ts, src/server.ts, src/db.ts
- public/app.js (and index.html, style.css if UI work is planned)
- test/run.ts, test/make-samples.ts, mock/mock-prusalink.ts
- package.json

Do not upload `data/` (contains printer passwords and users' G-code).

## Current status
- Built and tested against a mock PrusaLink only (53 e2e checks + browser smoke test pass).
- NOT yet tested on a real printer; Dockerfile not built; .bgcode parser tested only on a synthetic file.

## Open items / next steps
1. First-day checklist on one real printer: test connection, submit -> approve -> start, finish detection, stop.
2. Verify on real firmware: printer state names, job.progress range (0-100), stop/pause/resume endpoints, storage name (`usb` vs `local`).
3. Get a real PrusaSlicer .bgcode export and a real .gcode export; confirm the parsers read model, material, colour, time and grams.
4. Build and run the Docker image; put behind HTTPS reverse proxy if exposed beyond the LAN.
5. Decide on features: e-mail notifications, per-user accounts/SSO, delete uploaded files from printer storage after printing, other printer brands, EN/FR/DE UI.

## Useful first messages in the Project
- "Here is the PrusaLink response from our MK4S: ..." (to fix real-hardware differences)
- "Here is a real .bgcode export, check the parser."
- "Add e-mail notifications when a request is approved / finished."
