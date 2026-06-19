# Tools

In-repo dev tools that aren't part of the shipped game build. Each tool
lives in its own subfolder with everything it needs (HTML, server,
output file) colocated. None of these are referenced from `src/` and
none ship to Devvit — they're purely for local content authoring.

## Index

Single launch for every tool:

```bash
node tools/server.mjs
# → http://localhost:3000/  (tool index page)
```

| Tool | Purpose | Page | Output |
| --- | --- | --- | --- |
| [`cosmetics/`](cosmetics/) | Calibrate name / slot / X-Y offset / scale per cosmetic, generate tinted variants. | `/tools/cosmetics/calibrator.html` | `tools/cosmetics/cosmetics.json` |
| [`cats/`](cats/) | Calibrate name / rarity / scale per cat, preview animations frame-by-frame, generate tinted variants. | `/tools/cats/calibrator.html` | `tools/cats/cats.json` |

## Adding a new tool

1. Create `tools/<name>/` with whatever the tool needs (typically a
   `calibrator.html` and a `README.md`).
2. Register the tool in `tools/server.mjs`'s `TOOLS` table — `label`,
   `href`, `savePath`, `description`. The shared server picks it up
   automatically (index page + `POST /save/<name>` endpoint).
3. Have the HTML autosave via `POST /save/<name>` and auto-load from
   the absolute path of its output file (so the JSON survives reloads
   and sessions).
4. Add a row to the table above with page + output path.
5. Update `outputs/portfolio/pspsps-session-state.md` so the session
   tracker mentions the tool.

## Conventions

- **No build step.** Tools should run with `node tools/<name>/server.mjs`
  (or just opened directly if they don't need a server).
- **Output colocated with tool.** Saves write to `tools/<name>/<file>`,
  not the project root.
- **Use absolute paths in HTML** (`/public/assets/...`) so pages still
  resolve from any subfolder.
- **No dependencies.** Stick to Node built-ins. Tools shouldn't change
  `package.json`.
- **Document inline.** A short comment at the top of each script
  explaining what it does and how to run it goes a long way.
