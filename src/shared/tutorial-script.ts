/**
 * Tutorial dialogue script — keyed by TutorialStepId. Strings are
 * what Whiskers-the-host says at each beat; arrays cover multi-line
 * sequences (e.g. dressing-walkthrough has 2 lines, play-tutorial has
 * one per chart section).
 *
 * Multi-line beats are advanced by the consuming scene — Decorate in
 * tutorial mode advances `dressing-walkthrough` from line 1 to line 2
 * when the cat is tapped; Game in tutorial mode advances the
 * `play-tutorial` lines at chart-section boundaries.
 *
 * Voice: cute + brief. "Pspspsing" framing per Tim ("cats prefer ps
 * over loud claps"). Keep lines under ~140 chars so the speech bubble
 * doesn't drag.
 *
 * NB: Personalized substitutions (e.g. "<poster>'s show" in
 * route-b-outro) are done at render time with simple string replace —
 * the script holds the template.
 */

import type { TutorialStepId } from './tutorial-types';

export const TUTORIAL_DIALOGUE: Record<TutorialStepId, string | string[]> = {
  'intro':
    "hey, I'm Butters. I noticed you're new here, so let me show you the ropes before we put on a Meowcert.",
  'pick-stage':
    "first, let's pick a venue for your show. don't worry — there will be cooler venues for you to perform at later, but for now pick one of the 3 available.",
  'pick-cat':
    "next, pick your first bandmember. you'll be able to hire more bandmembers as you earn rewards from hosting and attending shows.",
  'merch-intro':
    "welcome to the band, <catname>! let's check the merch table to spice up your new bandmember.",
  'box-cosmetic':
    "first up, let's open a cosmetic box. here's where you'll get hats, bows, and other accessories for your cats.",
  'box-effect':
    "effect boxes are where you'll find sparkles, flames, and particle flair that make your cats stand out.",
  'stage-set-confirm':
    "your stage is set! this is what you'll see when you practice or when you put on a show for others. you can always come back here with this tab on the menu.",
  'rehearsal-intro':
    "next, you can practice before the big show by coming to the rehearse tab. for each show or practice you attend, we'll be pspspsing the performers — they prefer being cheered on that way over loud claps.",
  'play-tutorial-intro':
    "ready? you'll start seeing some fuzzy balls fall down — that's the optimal time for a lil ps for the kitties. tap them as they get inside the circle.",
  'play-tutorial': [
    // 0 — taps + chord intro (drops chord notes after first tap-only round)
    "nice! those are taps — the basic note. two or three lanes at once? both work, it's just a chord.",
    // 1 — holds (single + double-lane)
    "holds are tap-and-hold — keep your finger down until it ends. double-lane holds need both fingers down at once.",
    // 2 — slides (1 lane)
    "slides next! tap and drag to the next lane.",
    // 3 — slides (2 lanes)
    "you can slide across 2 lanes too — same gesture, longer drag.",
    // 4 — double slide
    "and the double slide ◀▶ — drag out, then drag back. takes practice.",
    // 5 — "ready for a real chart?" pre-roll. Yes-only beat handled by
    //   orchestrator; on Yes the insane chart runs.
    "wow, it looks like you've got the hang of it. ready for a real chart?",
    // 6 — insane chart (5s timer). No bubble copy — let the chaos speak.
    "",
    // 7 — outro + menu mock w/ PUT ON A SHOW highlighted
    "just kidding — you've got a long way to go before that. now let's hit the put on a show tab and i'll guide you through it!",
  ],
  'editor-tour-intro':
    "tap a cell to place a note.",
  'editor-tour': [
    // 0 — hold note demo
    "tap and drag up or down for a hold note.",
    // 1 — slide note demo
    "tap and drag left or right for a slide note (double notes too).",
    // 2 — ready-to-rehearse pointer
    "when you're ready, press rehearse to practice your chart. you can come back here anytime to keep tweaking.",
    // 3 — required-to-rehearse-pass gate
    "before you can put on a show, you must rehearse your chart from the top and pass it.",
  ],
  'visit-pointer': [
    // 0 — CATCH A SHOW highlighted
    "here's where you can go find other people's shows to attend.",
    // 1 — MERCH highlighted
    "the merch table is where you can find more cosmetics — like the ones you just got.",
    // 2 — REWARDS highlighted (stub for now; real feature coming)
    "the rewards tab — be sure to check it often for new goodies.",
    // 3 — SETTINGS highlighted
    "and the settings tab lets you adjust things to match your gameplay style.",
  ],
  'route-a-outro':
    "and that's all! i think you're ready to attend and host meowcert shows now!",
  'route-b-outro':
    "now that you know the lay of the land, let's get you back to <poster>'s show!",
};

/** Always-array view of the dialogue for a given step. Callers that
 *  only care about single-line beats can use `getTutorialDialogue(step)[0]`. */
export function getTutorialDialogue(step: TutorialStepId): string[] {
  const d = TUTORIAL_DIALOGUE[step];
  return Array.isArray(d) ? d : [d];
}

/** Substitute template placeholders:
 *   - `<poster>` → the deep-link poster's username (route-b-outro)
 *   - `<catname>` → the player's seated starter cat name (merch-intro)
 *  Returns the line unchanged where a placeholder isn't present.
 *  Missing values get sensible fallbacks. */
export function personalize(
  line: string,
  posterUsername: string | undefined,
  catName?: string,
): string {
  let out = posterUsername
    ? line.replace('<poster>', `u/${posterUsername}`)
    : line.replace('<poster>', 'your friend');
  if (catName) {
    out = out.replace('<catname>', catName);
  } else {
    out = out.replace('<catname>', 'your new bandmember');
  }
  return out;
}
