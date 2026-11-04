// ─── Refresh tokens are never repeated (npm test) ───────────────────
// A refresh token is stored by its SHA-256 in user_sessions.token_hash, which is unique. Tokens
// signed for the same account in the same second used to come out identical, so a sign-in and a
// refresh, or two tabs, landing in that second made /auth/refresh fail with a 500. None of these
// touch the database.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signRefreshToken, verifyRefreshToken } from '../lib/jwt.js';
import { hashSessionToken } from '../services/session.service.js';

describe('refresh tokens', () => {
  it('differ when signed for the same account in the same instant', () => {
    const tokens = Array.from({ length: 50 }, () => signRefreshToken(7));
    assert.equal(new Set(tokens).size, tokens.length);
    assert.equal(new Set(tokens.map(hashSessionToken)).size, tokens.length);
  });

  it('still verify as refresh tokens for their account', () => {
    const payload = verifyRefreshToken(signRefreshToken(7));
    assert.equal(payload.sub, 7);
    assert.equal(payload.type, 'refresh');
  });
});
