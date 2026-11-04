import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/**
 * ─── Signed state for OAuth redirects ────────────────────────────────
 *
 * The app issues no session token of its own — inside the Shopify admin every request proves itself
 * with a Shopify ID token (shopify-id-token.ts). What is signed here is the short-lived `state` that
 * travels through an OAuth redirect to Shopify or Google and back: those callbacks arrive from a
 * browser that is on someone else's site, with no app credential at all, so the signed state is the
 * only thing that says which user and store the returning code belongs to.
 *
 * Signed with JWT_ACCESS_SECRET (the name is from when the same secret signed session tokens; it
 * now signs only these). Ten minutes is enough for one round trip.
 */

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
