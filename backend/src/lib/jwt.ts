import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "30d";

interface AccessTokenPayload {
  sub: number;
  type: "access";
}

interface RefreshTokenPayload {
  sub: number;
  type: "refresh";
}

export function signAccessToken(userId: number): string {
  return jwt.sign(
    { sub: userId, type: "access" } satisfies AccessTokenPayload,
    env.jwtAccessSecret,
    {
      expiresIn: ACCESS_TOKEN_TTL,
    },
  );
}

/**
 * Every refresh token carries a random `jti`, so no two are ever the same string.
 *
 * Without it a token is just {sub, type, iat, exp} with `iat` in whole seconds, so two tokens
 * signed for the same account in the same second came out identical. user_sessions.token_hash is
 * unique, so the second write failed. That surfaced as a 500 from /auth/refresh whenever a sign-in
 * and a refresh, or two tabs, landed in the same second, and the app read it as an expired session.
 */
export function signRefreshToken(userId: number): string {
  return jwt.sign(
    { sub: userId, type: "refresh" } satisfies RefreshTokenPayload,
    env.jwtRefreshSecret,
    {
      expiresIn: REFRESH_TOKEN_TTL,
      jwtid: randomUUID(),
    },
  );
}

export function refreshTokenTtlMs(): number {
  return 30 * 24 * 60 * 60 * 1000;
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.jwtAccessSecret) as jwt.JwtPayload;
  if (payload.type !== "access" || typeof payload.sub !== "number")
    throw new Error("Not an access token");
  return payload as unknown as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, env.jwtRefreshSecret) as jwt.JwtPayload;
  if (payload.type !== "refresh" || typeof payload.sub !== "number")
    throw new Error("Not a refresh token");
  return payload as unknown as RefreshTokenPayload;
}

interface ShopifyStatePayload {
  sub: number;
  shop: string;
  /**
   * WHICH store row the install belongs to — the one the merchant had on screen when they pressed
   * Connect, resolved through the same tenancy seam every read path uses.
   *
   * Optional only so a state token minted by the previous build (10-minute TTL) still completes
   * instead of failing its security check; the callback falls back to the caller's current store,
   * which is the same value this now carries.
   */
  storeId?: number;
  type: "shopify_state";
}

/** Short-lived signed nonce carrying the authenticated user's id AND target store through
 * Shopify's OAuth redirect (which is otherwise unauthenticated from Rankvora AI's perspective —
 * Shopify only echoes it back). Same shape as signGoogleState below, for the same reason. */
export function signShopifyState(
  userId: number,
  storeId: number,
  shop: string,
): string {
  return jwt.sign(
    {
      sub: userId,
      storeId,
      shop,
      type: "shopify_state",
    } satisfies ShopifyStatePayload,
    env.jwtAccessSecret,
    { expiresIn: "10m" },
  );
}

/**
 * The same short-lived signed nonce, for Google's OAuth redirect.
 *
 * Google's callback carries no signature of its own — unlike Shopify's, which HMACs its query — so
 * this state IS the entire CSRF defence and the only thing that says which Rankvora AI user and store
 * the returning code belongs to. An unsigned or guessable state would let anyone hand Rankvora AI an
 * authorization code and have the resulting tokens filed against someone else's store.
 */
/**
 * Where in the app the merchant started a Google connection from, so they can be returned there.
 *
 * A WORD, NEVER A URL. The callback maps it to a fixed in-app path, so a forged or tampered state
 * cannot send a browser anywhere else — and it is inside the signed token, so it cannot be altered
 * in flight either. Anything not on this list is ignored and the merchant lands on Integrations.
 */
export type GoogleReturnTo = "onboarding";

export function signGoogleState(
  userId: number,
  storeId: number,
  returnTo?: GoogleReturnTo,
): string {
  return jwt.sign(
    {
      sub: userId,
      storeId,
      type: "google_state",
      ...(returnTo ? { returnTo } : {}),
    },
    env.jwtAccessSecret,
    { expiresIn: "10m" },
  );
}

export function verifyGoogleState(token: string): {
  sub: number;
  storeId: number;
  returnTo?: GoogleReturnTo;
} {
  const payload = jwt.verify(token, env.jwtAccessSecret) as jwt.JwtPayload;
  if (
    payload.type !== "google_state" ||
    typeof payload.sub !== "number" ||
    typeof payload.storeId !== "number"
  ) {
    throw new Error("Not a google_state token");
  }
  return {
    sub: payload.sub,
    storeId: payload.storeId,
    ...(payload.returnTo === "onboarding"
      ? { returnTo: "onboarding" as const }
      : {}),
  };
}

/**
 * ─── Sign in with Shopify ────────────────────────────────────────────
 *
 * Two tokens, both short-lived, neither naming a Rankvora AI user until Shopify has vouched for one.
 *
 * STATE travels through Shopify's OAuth redirect. It carries no user — the merchant is signed out —
 * only the shop the flow was started for and a SHA-256 of a nonce the starting browser holds in
 * sessionStorage.
 *
 * GRANT is what the callback hands back to the frontend once Shopify has authenticated the shop.
 * It names the account, but is redeemable only together with the raw nonce, so a grant lifted from
 * one browser (or planted into another, which is login CSRF) cannot start a session anywhere else.
 * Two minutes is enough for one redirect and one POST.
 */
interface ShopifyLoginStatePayload {
  shop: string;
  nonceHash: string;
  type: "shopify_login_state";
}

export function signShopifyLoginState(shop: string, nonceHash: string): string {
  return jwt.sign(
    {
      shop,
      nonceHash,
      type: "shopify_login_state",
    } satisfies ShopifyLoginStatePayload,
    env.jwtAccessSecret,
    { expiresIn: "10m" },
  );
}

export function verifyShopifyLoginState(token: string): {
  shop: string;
  nonceHash: string;
} {
  const payload = jwt.verify(token, env.jwtAccessSecret) as jwt.JwtPayload;
  if (
    payload.type !== "shopify_login_state" ||
    typeof payload.shop !== "string" ||
    typeof payload.nonceHash !== "string"
  ) {
    throw new Error("Not a shopify_login_state token");
  }
  return { shop: payload.shop, nonceHash: payload.nonceHash };
}

/** Whether an OAuth state belongs to sign-in rather than to connecting a store from Integrations.
 * Both flows share one registered redirect URI, so the callback branches on this. */
export function isShopifyLoginState(token: string): boolean {
  try {
    verifyShopifyLoginState(token);
    return true;
  } catch {
    return false;
  }
}

export function signShopifyLoginGrant(
  userId: number,
  nonceHash: string,
): string {
  return jwt.sign(
    { sub: userId, nonceHash, type: "shopify_login_grant" },
    env.jwtAccessSecret,
    { expiresIn: "2m" },
  );
}

export function verifyShopifyLoginGrant(token: string): {
  sub: number;
  nonceHash: string;
} {
  const payload = jwt.verify(token, env.jwtAccessSecret) as jwt.JwtPayload;
  if (
    payload.type !== "shopify_login_grant" ||
    typeof payload.sub !== "number" ||
    typeof payload.nonceHash !== "string"
  ) {
    throw new Error("Not a shopify_login_grant token");
  }
  return { sub: payload.sub, nonceHash: payload.nonceHash };
}

export function verifyShopifyState(token: string): ShopifyStatePayload {
  const payload = jwt.verify(token, env.jwtAccessSecret) as jwt.JwtPayload;
  if (
    payload.type !== "shopify_state" ||
    typeof payload.sub !== "number" ||
    typeof payload.shop !== "string"
  ) {
    throw new Error("Not a shopify_state token");
  }
  // `storeId` is validated but not required — see the note on ShopifyStatePayload.
  if (payload.storeId !== undefined && typeof payload.storeId !== "number") {
    throw new Error("Not a shopify_state token");
  }
  return payload as unknown as ShopifyStatePayload;
}
