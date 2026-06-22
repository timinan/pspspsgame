# Audio assets

## Current state (Step 1 + samples wired)

The Game scene boots a `SongPlayer` (see `src/client/systems/song-player.ts`)
that turns every active step of the round's chart into a pitched meow on
beat over the prototype's lofi loop.

Wired in `Game.ts`:
- `meowSamples: { C4: 'assets/audio/meows/meow.wav' }` — one real meow
  sample at C4; Tone.Sampler pitch-shifts to E4 and G4 for the other lanes.
- `backingTrackUrl: 'assets/sounds/background.mp3'` — the prototype's
  lofi loop, sync'd to Transport so it pauses with the round.

The `ChartEditor` preview uses the same sampler but skips the backing
track, so authoring you hear the meow placement cleanly.

To upgrade to per-note recordings (sharper pitch, no interpolation
artifacts on G4), drop these files into `public/assets/audio/meows/` and
extend the `meowSamples` map:

| Filename             | Note    | Role in chart                             |
| -------------------- | ------- | ----------------------------------------- |
| `meow_C4.wav`        | C4      | Lane 0 (left)  — root note                |
| `meow_E4.wav`        | E4      | Lane 1 (center) — major third             |
| `meow_G4.wav`        | G4      | Lane 2 (right) — perfect fifth            |

Optional but recommended:

| Filename             | Note    | Role                                       |
| -------------------- | ------- | ------------------------------------------ |
| `meow_C5.wav`        | C5      | Octave — useful if we later add lane shift |

The procedural fallback inside `SongPlayer` kicks in whenever the
`meowSamples` option is empty, so it's safe to add these files
incrementally — `meow_C4.wav` alone still works as a fallback for
all three lanes via Tone.Sampler's automatic pitch-shifting.

## How to make samples from a single source meow

If you only have one clean meow recording, you don't have to manually
pitch-shift it — Tone.Sampler interpolates. Just provide it as `C4`
and Tone shifts to E4 and G4 automatically with reasonable quality
for cat noises:

```ts
// in Game.ts initChartPlayer:
this.songPlayer = new SongPlayer({
  chart: playChart,
  meowSamples: {
    C4: 'assets/audio/meows/meow_C4.wav',
  },
});
```

For better fidelity, pre-render the variants offline with `ffmpeg`:

```bash
# Drop your source recording at meow_source.wav, then:
ffmpeg -i meow_source.wav -af "asetrate=44100*1.0,aresample=44100" meow_C4.wav
ffmpeg -i meow_source.wav -af "asetrate=44100*1.2599,aresample=44100" meow_E4.wav
ffmpeg -i meow_source.wav -af "asetrate=44100*1.4983,aresample=44100" meow_G4.wav
```

(Multipliers are equal-temperament ratios: C→E = 1.2599, C→G = 1.4983.)

## Backing track (optional)

`SongPlayer` accepts a `backingTrackUrl` option that streams a looping
backdrop track underneath the meows. Use a track in **C major** at
**90 BPM** so it harmonizes with the lane-to-note mapping. Suggested
filename: `public/assets/audio/lofi-loop-90bpm.mp3`.

When wired, pass it through:

```ts
this.songPlayer = new SongPlayer({
  chart: playChart,
  backingTrackUrl: 'assets/audio/lofi-loop-90bpm.mp3',
});
```

Royalty-free sources for the loop:
- pixabay.com/music — search "lofi 90 bpm c major"
- incompetech.com (CC-BY)
- A one-shot MusicGen generation (Step 2 of the audio plan)

## Disabling audio

If audio causes any playtest weirdness, set
`Balance.audioEnabled = false` in `src/client/constants/balance.ts`.
The whole SongPlayer path is skipped — no Tone.js boot, no scheduling,
no audio context unlock.
