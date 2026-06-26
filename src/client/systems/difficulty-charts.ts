import { DEFAULT_CHART_STEP_COUNT } from '@/../shared/state';
import type { Chart, ChartStep, LaneId } from '@/../shared/state';

/**
 * Five curated difficulty presets used by the Ready modal when the
 * player wants a quick play session at a chosen intensity (instead of
 * running their own authored chart). Density = fraction of steps with
 * a note; chord rate = fraction of noted steps with a second lane on
 * the same beat (which forces a double-tap). BPM stays at 120 across
 * the board so the lofi backing track stays musically locked.
 */

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

export interface DifficultyPreset {
  level: DifficultyLevel;
  label: string;
  density: number;
  chordRate: number;
}

export const DIFFICULTY_PRESETS: Record<DifficultyLevel, DifficultyPreset> = {
  1: { level: 1, label: 'COZY', density: 0.25, chordRate: 0 },
  2: { level: 2, label: 'EASY', density: 0.4, chordRate: 0.05 },
  3: { level: 3, label: 'GROOVE', density: 0.55, chordRate: 0.15 },
  4: { level: 4, label: 'FAST', density: 0.75, chordRate: 0.25 },
  5: { level: 5, label: 'FRENZY', density: 0.9, chordRate: 0.4 },
};

export const DIFFICULTY_LEVELS: DifficultyLevel[] = [1, 2, 3, 4, 5];

/**
 * Build a 32-step chart matching the requested difficulty preset. Each
 * step rolls independently for note presence, then for chord upgrade.
 * Every lane is guaranteed to appear at least once so no rhythm bar
 * sits silent for the whole loop.
 */
export function makeChartForDifficulty(level: DifficultyLevel): Chart {
  const preset = DIFFICULTY_PRESETS[level];
  const steps: ChartStep[] = [];
  for (let i = 0; i < DEFAULT_CHART_STEP_COUNT; i++) {
    if (Math.random() < preset.density) {
      const lanes: LaneId[] = [Math.floor(Math.random() * 3) as LaneId];
      if (Math.random() < preset.chordRate) {
        let second: LaneId;
        do {
          second = Math.floor(Math.random() * 3) as LaneId;
        } while (second === lanes[0]);
        lanes.push(second);
      }
      steps.push({ lanes });
    } else {
      steps.push({ lanes: [] });
    }
  }
  for (const laneId of [0, 1, 2] as LaneId[]) {
    if (!steps.some((s) => s.lanes.includes(laneId))) {
      const emptyIdx = steps.findIndex((s) => s.lanes.length === 0);
      const targetIdx =
        emptyIdx >= 0 ? emptyIdx : Math.floor(Math.random() * steps.length);
      steps[targetIdx] = { lanes: [laneId] };
    }
  }
  return {
    authorId: 'meowcert',
    title: `Difficulty ${level} — ${preset.label}`,
    stepCount: DEFAULT_CHART_STEP_COUNT,
    bpm: 120,
    steps,
    updatedAt: Date.now(),
  };
}
