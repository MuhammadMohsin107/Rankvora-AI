// ─── The write gate is real (npm test) ───────────────────────────────
//
// Guided setup asks the merchant one question with teeth: may Rankvora AI change your store? The
// schema has called `onboarding_state.automation_consent` "THE WRITE GATE" since it was added, and
// for as long as it existed NOTHING enforced it — a merchant who chose "Never change my store"
// could still have fixes written to their catalogue by the Fix Center.
//
// Asking a permission question and ignoring the answer is worse than never asking, because the
// merchant believes they are protected. These tests hold the gate shut.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { writeIsPermitted } from '../services/onboarding.service.js';

function source(relativePath: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relativePath), 'utf8');
}

describe('automation consent decides whether Rankvora AI may write', () => {
  it('refuses every write when the merchant said never', () => {
    const verdict = writeIsPermitted('none');
    assert.equal(verdict.allowed, false);
    // The refusal names their own answer back to them and where to change it. A bare "not
    // permitted" is a door with no handle.
    assert.match(verdict.reason, /Never change my store/);
    assert.match(verdict.reason, /Settings/);
  });

  it('allows a write the merchant approved fix by fix', () => {
    // 'ask' is satisfied BY this path: a human selected these specific fixes and pressed Apply.
    assert.equal(writeIsPermitted('ask').allowed, true);
    assert.equal(writeIsPermitted('low_risk').allowed, true);
  });

  it('treats an unanswered question as ask-first, not as permission', () => {
    // null is allowed here only because this path carries a per-fix human approval. The rule that
    // matters is that null is never read as 'low_risk' — nothing may write UNATTENDED without an
    // explicit answer, which is what this documents for any future automatic path.
    assert.equal(writeIsPermitted(null).allowed, true);
    assert.notEqual(writeIsPermitted(null).allowed, writeIsPermitted('none').allowed);
  });

  it('recognises no consent value beyond the three the schema permits', () => {
    // A typo or a stale value must not open the gate wider than 'none' closes it. Anything that is
    // not 'none' is allowed only because this path is itself an approval.
    const schema = source('../db/schema.ts');
    assert.match(schema, /IN \('none', 'ask', 'low_risk'\)/);
  });
});

describe('the apply path checks consent before it writes', () => {
  const applyService = source('../services/fix-apply.service.ts');

  it('checks the gate inside applyApprovedProposals', () => {
    assert.ok(applyService.includes('automationConsentFor'), 'the apply path no longer reads the merchant’s consent');
    assert.ok(applyService.includes('writeIsPermitted'));
    assert.ok(applyService.includes('AUTOMATION_NOT_PERMITTED'));
  });

  it('checks it before anything is materialised or written', () => {
    // Ahead of scopes, ahead of proposal state, ahead of materializeFixes — which CREATES rows for
    // hand-typed values. A gate checked after that would already have written to the database.
    const fn = applyService.slice(applyService.indexOf('export async function applyApprovedProposals'));
    const gateAt = fn.indexOf('writeIsPermitted');
    const materializeAt = fn.indexOf('materializeFixes(');
    const scopesAt = fn.indexOf('getFixContext(');
    assert.ok(gateAt > 0, 'the gate is gone from the apply path');
    assert.ok(gateAt < materializeAt, 'consent is checked after fixes are materialised');
    assert.ok(gateAt < scopesAt, 'consent is checked after Shopify scopes');
  });

  it('refuses the whole call rather than skipping each proposal', () => {
    // "This store does not permit writes" is one fact. Reported as twenty skipped rows it would be
    // buried in exactly the list the merchant is scanning for results.
    const fn = applyService.slice(applyService.indexOf('export async function applyApprovedProposals'));
    const gateAt = fn.indexOf('writeIsPermitted');
    assert.match(fn.slice(gateAt, gateAt + 400), /throw new ApiError\(403/);
  });
});
