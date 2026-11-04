// ─── AI Discovery · the live-read layer (npm test) ───────────────────
//
// The four features that read something real at request time rather than from an audit snapshot:
// AI referral traffic (GA4), Google index coverage (URL Inspection), test-as-a-bot (a real HTTP
// request), and the prompt-tracking trend.
//
// THE PROPERTY THESE TESTS PROTECT is the one the pillar is built on and the one a "live read" is
// most likely to break: a number shown to a merchant must have been measured. Specifically:
//
//   · A SOURCE THAT IS NOT AN AI ASSISTANT MUST NOT BE COUNTED AS ONE. Substring matching would
//     capture aliexpress.com and every .ai domain, and the store would be shown invented AI
//     traffic that is really its own newsletter. This is the single highest-consequence bug
//     available in this feature, because the number looks plausible and nobody can audit it.
//   · A SAMPLE MUST DESCRIBE THE CATALOGUE, not its best-established corner. Sitemaps are ordered
//     oldest-first, so inspecting the first N reports a flattering figure that is consistently
//     wrong.
//   · A CRAWLER WITH NO PUBLISHED USER-AGENT IS NEVER PROBED. Sending an invented header and
//     presenting the result as that crawler's experience is a fabricated measurement.
//
// Nothing here mocks Google or the network. The assertions are on pure functions and on the
// refusals that happen BEFORE any request is made — which is exactly the part that must not drift.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_REFERRERS, matchAiReferrer } from '../audit-engine/storefront/ai-referrers.js';
import { evenSample } from '../services/url-inspection.service.js';
import { listTestableBots, runBotTest } from '../services/bot-test.service.js';
import { AI_CRAWLERS } from '../audit-engine/storefront/ai-crawlers.js';

const ORIGIN = 'https://t.myshopify.com';

describe('AI referrer matching', () => {
  it('recognises each platform by every source spelling it publishes', () => {
    for (const referrer of AI_REFERRERS) {
      for (const source of referrer.sources) {
        assert.equal(
          matchAiReferrer(source)?.id,
          referrer.id,
          `${source} should resolve to ${referrer.id}`,
        );
      }
    }
  });

  it('is case- and whitespace-insensitive, because GA4 is not consistent about either', () => {
    assert.equal(matchAiReferrer('ChatGPT.com')?.id, 'chatgpt');
    assert.equal(matchAiReferrer('  perplexity.ai  ')?.id, 'perplexity');
  });

  // The test that matters most. Every entry here is a real host that a substring or suffix match
  // would wrongly capture, turning ordinary traffic into fabricated "AI sessions".
  it('never counts a non-assistant source as AI traffic', () => {
    const notAi = [
      'google',
      'google.com',
      '(direct)',
      '(none)',
      'bing.com',
      'facebook.com',
      'instagram.com',
      'aliexpress.com', // contains "ai"
      'mail.google.com', // contains "ai" and is a google host
      'klaviyo.com',
      'mailchimp.com', // contains "ai"
      'characters.ai', // a .ai domain that is not in the list
      'some-random.ai', // ditto
      'chatgpt.example.com', // a lookalike host somebody else controls
      'notperplexity.ai',
      // Company websites, not assistants: a visit from OpenAI's blog is not a ChatGPT answer.
      'openai.com',
      'x.ai',
      'mistral.ai',
      't.co',
      '',
      '   ',
    ];
    for (const source of notAi) {
      assert.equal(matchAiReferrer(source), null, `${source || '(blank)'} must not be counted as AI traffic`);
    }
  });

  it('gives every referrer a distinct id, so two platforms cannot collapse into one row', () => {
    const ids = AI_REFERRERS.map((referrer) => referrer.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('claims no source string for two different platforms', () => {
    const seen = new Map<string, string>();
    for (const referrer of AI_REFERRERS) {
      for (const source of referrer.sources) {
        const existing = seen.get(source);
        assert.equal(existing, undefined, `${source} is claimed by both ${existing} and ${referrer.id}`);
        seen.set(source, referrer.id);
      }
    }
  });
});

describe('index-coverage sampling', () => {
  const urls = Array.from({ length: 100 }, (_, index) => `${ORIGIN}/products/p${index}`);

  it('returns everything when the sitemap is smaller than the sample', () => {
    const small = urls.slice(0, 4);
    assert.deepEqual(evenSample(small, 10), small);
  });

  it('returns exactly the requested size from a larger sitemap', () => {
    assert.equal(evenSample(urls, 10).length, 10);
  });

  // The behavioural point: taking the first 10 would only ever inspect the oldest products, which
  // are the most likely to be indexed, and report a figure that flatters every store.
  it('spreads across the whole list rather than taking the first N', () => {
    const sample = evenSample(urls, 10);
    assert.notDeepEqual(sample, urls.slice(0, 10));
    assert.equal(sample[0], urls[0], 'the sample should still start at the beginning');
    // The last pick must come from the far end of the list, not the first tenth.
    const lastIndex = urls.indexOf(sample[sample.length - 1]!);
    assert.ok(lastIndex >= 85, `expected the last sample near the end of the list, got index ${lastIndex}`);
  });

  it('never returns a duplicate, which would spend quota twice on one URL', () => {
    const sample = evenSample(urls, 25);
    assert.equal(new Set(sample).size, sample.length);
  });

  it('returns only URLs that were really in the sitemap', () => {
    for (const url of evenSample(urls, 10)) assert.ok(urls.includes(url));
  });
});

describe('test as a bot', () => {
  it('lists every known crawler, flagging which can actually be probed', () => {
    const bots = listTestableBots();
    assert.equal(bots.length, AI_CRAWLERS.length);

    for (const crawler of AI_CRAWLERS) {
      const listed = bots.find((bot) => bot.name === crawler.name);
      assert.ok(listed, `${crawler.name} is missing from the list`);
      assert.equal(
        listed.probeable,
        crawler.userAgent !== null,
        `${crawler.name} probeable flag must match whether it publishes a User-Agent`,
      );
    }
  });

  it('marks the robots.txt-only tokens as not probeable rather than hiding them', () => {
    const bots = listTestableBots();
    // Both are real controls a merchant sets in robots.txt, so they must appear — just not as
    // something Rankvora AI claims to have fetched as.
    for (const name of ['Google-Extended', 'anthropic-ai']) {
      const listed = bots.find((bot) => bot.name === name);
      assert.ok(listed, `${name} should still be listed`);
      assert.equal(listed.probeable, false);
    }
  });

  // Both refusals happen before any network call, which is what makes them testable here — and
  // what makes them reliable in production.
  it('refuses a crawler it does not know, instead of guessing', async () => {
    await assert.rejects(
      () => runBotTest(ORIGIN, 'TotallyMadeUpBot', '/'),
      (error: Error & { code?: string }) => error.code === 'BOT_UNKNOWN',
    );
  });

  it('refuses to probe a crawler that publishes no User-Agent, rather than inventing one', async () => {
    await assert.rejects(
      () => runBotTest(ORIGIN, 'Google-Extended', '/'),
      (error: Error & { code?: string }) => error.code === 'BOT_NOT_PROBEABLE',
    );
  });

  it('names the reason in the refusal, so the UI never has to invent an explanation', async () => {
    await assert.rejects(
      () => runBotTest(ORIGIN, 'anthropic-ai', '/'),
      (error: Error) => /User-Agent/i.test(error.message) && /robots\.txt token/i.test(error.message),
    );
  });
});
