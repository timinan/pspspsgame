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
    "Hey there, I'm Butters. I noticed you're new here, so let me show you the ropes before we put on a Meowcert!",
  'pick-stage':
    "First, let's pick a venue for your show. Don't worry — there will be cooler venues for you to perform at later, but for now pick one of the 3 available.",
  'pick-cat':
    "Next, pick your first bandmember. You'll be able to hire more bandmembers as you earn rewards from hosting and attending shows.",
  'merch-intro':
    "Welcome to the band, <catname>! Let's check the merch table to spice up your new bandmember.",
  'box-cosmetic':
    "First up, let's open a cosmetic box. Here's where you'll get hats, bows, and other accessories for your cats.",
  'box-effect':
    "Next we have effect boxes — where you'll find sparkles, flames, and particle flair that make your cats stand out.",
  'merch-reveal':
    "Wow, looking great!",
  'stage-set-confirm':
    "Your stage is set! Now let's get to practicing.",
  'rehearsal-intro':
    "You can rehearse with your band anytime by coming to this tab.",
  'play-tutorial-intro': [
    // 0 — pspsps explainer. Shown in Game scene before the chart starts;
    //   Continue tap clears it and the next line takes over.
    "When you attend a show or even just practice, you'll want to give the cats on stage some pspspsps — they prefer this over loud claps. Try not to time it wrong or you'll make them mad.",
    // 1 — chart kicks off as this line appears.
    "Ready for the show? You'll start seeing some fuzz balls fall down — the optimal time to tap is when they get inside the circles.",
  ],
  'play-tutorial': [
    // 0 — taps + chord intro (drops chord notes after first tap-only round)
    "Nice! Those are taps — the basic note. Two or three lanes at once? Both work, it's just a chord.",
    // 1 — holds (single + double-lane)
    "Holds are tap-and-hold — keep your finger down until it ends. Double-lane holds need both fingers down at once.",
    // 2 — slides (1 lane)
    "Slides next! Tap and drag to the next lane.",
    // 3 — slides (2 lanes)
    "You can slide across 2 lanes too — same gesture, longer drag.",
    // 4 — double slide
    "And the double slide ◀▶ — drag out, then drag back. Takes practice.",
    // 5 — insane chart, gated by a Yes pre-roll in Game scene. The
    //   bubble line sits on top of the lane view; chart starts on Yes.
    "Wow, it looks like you've got the hang of it. Ready for a real chart?",
    // 6 — outro + menu mock w/ PUT ON A SHOW highlighted
    "Just kidding — you've got a long way to go before that. Now we'll check out the Put on a Show tab and I'll guide you through the process.",
  ],
  'editor-tour-intro':
    "Here is the editor for your chart. You can start with an empty chart or a pregenerated one.",
  'editor-tour': [
    // 0 — tap demo
    "Tap a cell to place a note.",
    // 1 — hold note demo (ball at the BOTTOM, tail extending up)
    "Tap and drag up or down for a hold note.",
    // 2 — slide note demo
    "Tap and drag left or right for a slide note.",
    // 3 — double-slide demo (slide-and-return)
    "Drag out and back for a double slide ◀▶.",
    // 4 — REHEARSE pointer
    "Press the Rehearse button.",
    // 5 — required-to-rehearse-pass gate
    "You must rehearse your chart from the top without failing, then you'll be able to create a post for all to see.",
  ],
  'visit-pointer': [
    // 0 — CATCH A SHOW highlighted
    "Next, the Catch a Show tab — here is where you can find other people's shows to attend.",
    // 1 — MERCH highlighted
    "And then the merch table — where you can find more cosmetics like the ones you just got.",
    // 2 — REWARDS highlighted (stub for now; real feature coming)
    "Be sure to check the rewards tab from time to time for new goodies.",
    // 3 — SETTINGS highlighted
    "And finally, you can come to the settings tab to adjust things to match your playstyle.",
  ],
  'route-a-outro':
    "And that's all! I think you're ready to attend and host Meowcert shows now!",
  'route-b-outro':
    "Now that you know the lay of the land, let's get you back to <poster>'s show!",
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
