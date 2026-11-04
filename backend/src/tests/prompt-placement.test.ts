// ─── Placement within an assistant answer (npm test) ─────────────────
//
// The ranking view is the single most dangerous thing in the AI Discovery pillar, because a
// fabricated rank is indistinguishable from a real one and flatters the merchant either way. The
// properties below are the ones that stop it inventing a placement:
//
//   · A RANK REQUIRES A COMPARISON SET. With no competitors configured there is no rank at all —
//     not "1st". "First of one" is the absence of a comparison, and reporting it as a win would
//     show every store leading every answer it appears in.
//   · NOT BEING NAMED IS NOT LAST. A store absent from an answer has NO rank. Recording it as
//     last would assert a placement that was never observed.
//   · ONLY THE MERCHANT'S OWN TERMS ARE MATCHED. Nothing is extracted from the prose. A brand
//     Rankvora AI was not told about is never counted, in either direction.
//   · POSITION IS A FRACTION, because answers vary in length and a raw offset is not comparable.
//
// Every answer below is written in the shape an assistant really replies in. They are test inputs,
// not shipped data.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMention, placementInAnswer } from '../services/prompt-tracking.service.js';

const ANSWER = [
  'For specialty coffee beans in the UK, a few roasters stand out.',
  'Origin Coffee is widely recommended for consistency.',
  'Aurora Coffee has an excellent single-origin Ethiopian range.',
  'Pact Coffee is a good subscription option if you want variety.',
].join(' ');

describe('mention detection is unchanged by the ranking work', () => {
  it('quotes the sentence a brand appeared in', () => {
    const context = findMention(ANSWER, 'Aurora Coffee');
    assert.ok(context);
    assert.match(context, /Aurora Coffee/);
  });

  it('does not match a brand inside a longer word', () => {
    assert.equal(findMention('The architecture is modern.', 'Arc'), null);
  });

  it('matches a brand with no word boundary to anchor against', () => {
    assert.ok(findMention('We like M&S for basics.', 'M&S'));
  });
});

describe('a rank requires a comparison set', () => {
  it('returns NO rank when no competitors are configured, even though the brand was named', () => {
    const placement = placementInAnswer(ANSWER, 'Aurora Coffee', []);
    assert.ok(placement.mentionContext, 'the brand was named');
    assert.notEqual(placement.mentionPosition, null, 'and its position was observed');
    // The load-bearing assertions.
    assert.equal(placement.brandRank, null, 'no comparison set means no rank');
    assert.equal(placement.brandsNamed, null);
    assert.equal(placement.competitorsNamed, null, 'null means none configured, not none found');
  });

  it('distinguishes "none configured" from "none named"', () => {
    const configured = placementInAnswer(ANSWER, 'Aurora Coffee', ['nobody-mentioned-here']);
    // Configured but absent → an empty list, NOT null.
    assert.deepEqual(configured.competitorsNamed, []);
    assert.equal(configured.brandRank, 1, 'named, and no rival appeared ahead');
    assert.equal(configured.brandsNamed, 1);
  });
});

describe('placement among named brands is read off the answer', () => {
  const COMPETITORS = ['Origin Coffee', 'Pact Coffee'];

  it('ranks the store behind the competitor named before it', () => {
    const placement = placementInAnswer(ANSWER, 'Aurora Coffee', COMPETITORS);
    // Origin appears first, then Aurora, then Pact.
    assert.equal(placement.brandRank, 2);
    assert.equal(placement.brandsNamed, 3);
  });

  it('lists competitors in the order they appear in the answer', () => {
    const placement = placementInAnswer(ANSWER, 'Aurora Coffee', COMPETITORS);
    assert.deepEqual(placement.competitorsNamed?.map((entry) => entry.term), ['Origin Coffee', 'Pact Coffee']);
  });

  it('ranks the store first when it is named before every competitor', () => {
    const answer = 'Aurora Coffee is the best. Origin Coffee is also fine.';
    assert.equal(placementInAnswer(answer, 'Aurora Coffee', COMPETITORS).brandRank, 1);
  });

  // The failure that would most flatter a merchant.
  it('gives NO rank when the store was not named at all, rather than last place', () => {
    const answer = 'Origin Coffee and Pact Coffee are both excellent choices.';
    const placement = placementInAnswer(answer, 'Aurora Coffee', COMPETITORS);
    assert.equal(placement.brandRank, null, 'absent is not last');
    assert.equal(placement.mentionPosition, null);
    assert.equal(placement.mentionContext, null);
    // What the answer DID name is still recorded — that is the useful half.
    assert.equal(placement.brandsNamed, 2);
    assert.equal(placement.competitorsNamed?.length, 2);
  });

  it('never counts a brand it was not told about', () => {
    const answer = 'Try Monmouth Coffee or Square Mile — both are superb.';
    const placement = placementInAnswer(answer, 'Aurora Coffee', COMPETITORS);
    // Two real roasters are named; neither was configured, so neither is counted.
    assert.deepEqual(placement.competitorsNamed, []);
    assert.equal(placement.brandsNamed, 0);
  });
});

describe('position is a comparable fraction', () => {
  it('is between 0 and 1', () => {
    const placement = placementInAnswer(ANSWER, 'Aurora Coffee', []);
    assert.ok(placement.mentionPosition !== null);
    assert.ok(placement.mentionPosition >= 0 && placement.mentionPosition <= 1);
  });

  it('reports a brand named at the start as earlier than one named at the end', () => {
    const answer = 'Aurora Coffee is great. Filler sentence. Filler sentence. Origin Coffee is also fine.';
    const early = placementInAnswer(answer, 'Aurora Coffee', [])!.mentionPosition!;
    const late = placementInAnswer(answer, 'Origin Coffee', [])!.mentionPosition!;
    assert.ok(early < late, `expected ${early} < ${late}`);
  });

  it('survives an empty answer without producing NaN', () => {
    const placement = placementInAnswer('', 'Aurora Coffee', ['Origin Coffee']);
    assert.equal(placement.mentionPosition, null);
    assert.equal(placement.brandRank, null);
  });

  it('is comparable across answers of very different lengths', () => {
    const short = placementInAnswer('Aurora Coffee wins.', 'Aurora Coffee', [])!.mentionPosition!;
    const long = placementInAnswer(`Aurora Coffee wins.${' Filler.'.repeat(200)}`, 'Aurora Coffee', [])!.mentionPosition!;
    // Named first in both, so both fractions must sit near the start despite a 100x length gap.
    assert.ok(short < 0.2 && long < 0.2, `short=${short} long=${long}`);
  });
});
