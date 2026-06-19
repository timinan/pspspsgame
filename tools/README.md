# Tools

In-repo dev tools that aren't part of the shipped game build. Each tool
lives in its own subfolder with everything it needs (HTML, server,
output file) colocated. None of these are referenced from `src/` and
none ship to Devvit — they're purely for local content authoring.

## Index

| Tool | Purpose | Launch | Output |
| --- | --- | --- | --- |
| [`cosmetics/`](cosmetics/) | Visual calibrator for the 17 cosmetic sprites — set name, slot, X/Y offset, scale per cosmetic. Edits autosave to disk. | `node tools/cosmetics/server.mjs`, open `http://localhost:3000/` | `tools/cosmetics/cosmetics.json` |

## Adding a new tool

1. Create `tools/<name>/` with whatever the tool needs.
2. Prefer a self-contained HTML + small Node static server pattern (zero
   build step, runs anywhere Node runs). The cosmetics tool is a good
   template.
3. Have the tool autosave its output to a file inside its own folder so
   future-you can find it without grep.
4. Add a row to the table above with name, purpose, launch command, and
   output path.
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
