/**
 * Read-only check that the configured AI provider actually answers.
 *
 *   npm run verify:ai
 *
 * Why this exists: `aiConfigured()` only asks whether a key is PRESENT. It cannot know whether the
 * key is accepted, whether the model name is valid, or whether the project has quota — and all
 * three fail the same way from the outside: the Fix Center quietly falls back to the deterministic
 * suggestion and the merchant sees "AI could not draft these right now" with no way to tell which
 * of the three it was. Every failure in this pipeline is deliberately non-fatal, which is correct
 * at runtime and useless for diagnosis. This is the diagnosis.
 *
 * It makes ONE real request with a small fixed input, writes nothing to the database, and touches
 * no merchant data.
 *
 * NOTHING SECRET IS PRINTED: not the key, not its length. Only the provider, the model, and what
 * came back.
 */
import { aiConfigured, aiModelName, aiProviderKey, env } from '../config/env.js';
import { aiProvider } from '../lib/ai/index.js';
import { FIELD_RULES } from '../lib/ai/fix-policy.js';

const GREEN = '[32m';
const RED = '[31m';
const RESET = '[0m';

function fail(message: string, hint?: string): never {
  console.error(`${RED}FAILED${RESET} ${message}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

console.log(`Provider   ${env.aiProvider}`);
console.log(`Model      ${aiModelName()}`);
console.log(`Key        ${aiProviderKey() ? 'present' : 'MISSING'}`);
console.log(`Enabled    ${env.aiRecommendationsEnabled}`);

if (!env.aiRecommendationsEnabled) {
  fail(
    'AI is switched off (AI_RECOMMENDATIONS_ENABLED=false).',
    'The kill switch is independent of the key: remove it or set it to true to re-enable drafting.',
  );
}

if (!aiConfigured()) {
  // Named per provider, because setting AI_PROVIDER without its matching key is the usual mistake
  // and the generic "not configured" gives no clue which half is missing.
  fail(
    `No API key for the selected provider (${env.aiProvider}).`,
    env.aiProvider === 'gemini'
      ? 'Set AI_API_KEY (or GEMINI_API_KEY) in backend/.env, then restart the API.'
      : 'Set OPENAI_API_KEY in backend/.env, then restart the API.',
  );
}

// A real request, shaped exactly like the one the Fix Center sends — same rule, same bounds — so a
// pass here means the path the merchant uses works, not merely that the credential exists.
const rule = FIELD_RULES['seo.description'];

const result = await aiProvider().planFix({
  findingTitle: 'Meta descriptions are missing',
  problem: 'Some pages have no meta description configured.',
  field: rule.field,
  fieldLabel: rule.label,
  minLength: rule.minLength,
  maxLength: rule.maxLength,
  guidance: rule.guidance,
  storeName: 'Verification Store',
  targets: [
    {
      ref: 'product:verify',
      resourceType: 'product',
      title: 'Merino Wool Running Socks',
      currentValue: '',
      deterministicSuggestion: null,
      sourceText: 'Lightweight merino wool socks for long-distance running, with cushioned soles.',
    },
  ],
});

if (!result.ok) {
  // The provider maps every upstream failure to a reason rather than throwing, so this is where an
  // operator finds out which one it actually was.
  const hint = {
    auth: 'The key was rejected. Check it is the right key for this provider and has not been revoked.',
    quota: 'The project is out of quota or billing is not enabled.',
    rate_limit: 'Rate limited. The key works — try again shortly.',
    invalid_response: 'The model answered, but not in the required shape. Often means AI_MODEL names a model that cannot follow a strict schema — gemini-flash-lite-latest is the tested default.',
    timeout: 'The call did not finish in time. Often a wrong or very slow model name.',
    network: 'Could not reach the provider. Check outbound network access from this host.',
    server: 'The provider returned a server error. Usually transient.',
    disabled: 'AI is switched off.',
  }[result.reason];

  fail(`${result.reason} — ${result.detail}`, hint);
}

console.log(`\n${GREEN}OK${RESET}   ${result.model} answered with ${result.proposals.length} proposal(s)`);

// Printed so an operator can see the model produced usable prose rather than an empty shell. This
// is verification output about a fixed sample product — not merchant data.
for (const proposal of result.proposals) {
  console.log(`\n     ${proposal.proposedValue}`);
  console.log(`     (${proposal.proposedValue.length} chars; the rule allows ${rule.minLength}-${rule.maxLength})`);
}
