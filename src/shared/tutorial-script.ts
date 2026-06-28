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
    "let's check the merch table — looks like you've got two boxes to open. one for cosmetics (hats, bows, accessories) and one for effects (sparkles, flames, particle flair that makes your cats stand out).",
  'box-cosmetic':
    "let's see what's in the cosmetic box…",
  'box-effect':
    "and now the effect box…",
  'stage-set-confirm':
    "your stage is set! you can always come back here when you've got more merch, hired more bandmembers, or even found cooler venues for your gigs — change them up any time.",
  'rehearsal-intro':
    "now let's get to rehearsing. you'll find REHEARSE in here whenever you want to practice. tap it to head to the stage.",
  'play-tutorial-intro':
    "your stage is set! let's rehearse for your first show. we'll be pspspsing the cat — they prefer little ps sounds over loud claps.",
  'play-tutorial': [
    "nice! those are taps. they're the basic note.",
    "your cat lives in the middle for now, but the side lanes still work — they're ready for when you hire more bandmembers.",
    "two or three lanes at once? both work — it's just a chord.",
    "holds are tap-and-hold — keep your finger down until it ends.",
    "slides! tap and drag to the next lane.",
    "you can jump 2 lanes too — same gesture, longer drag.",
    "and the ◀▶ one — drag out, then drag back. takes practice.",
    "ok! you're ready for an insane run!",
    "...just kidding 😼. you've got a long way to go before that.",
    "let's move on to the editor.",
  ],
  'editor-tour-intro':
    "now let's check out the editor — that's where you'll create your own shows.",
  'editor-tour':
    "tap a cell to place a note. drag down in one lane for a hold. drag across lanes for a slide. drag out and back for the ◀▶ one. you can come back to the editor any time to keep tweaking — and when you're happy, you have to REHEARSE and PASS the chart before you can post it for others to play.",
  'visit-pointer':
    "when you want to catch other people's shows, head here.",
  'route-a-outro':
    "you're all set! go run wild — your show, your rules.",
  'route-b-outro':
    "now that you know the lay of the land, let's get you back to <poster>'s show!",
};

/** Always-array view of the dialogue for a given step. Callers that
 *  only care about single-line beats can use `getTutorialDialogue(step)[0]`. */
export function getTutorialDialogue(step: TutorialStepId): string[] {
  const d = TUTORIAL_DIALOGUE[step];
  return Array.isArray(d) ? d : [d];
}

/** Substitute `<poster>` with a real Reddit username for the route-b
 *  outro. Returns the line unchanged if `<poster>` isn't present. */
export function personalize(line: string, posterUsername: string | undefined): string {
  if (!posterUsername) return line.replace('<poster>', 'your friend');
  return line.replace('<poster>', `u/${posterUsername}`);
}
