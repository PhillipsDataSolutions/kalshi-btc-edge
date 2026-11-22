// Password gate. Set the PASSWORD environment variable (Vercel → Settings → Environment Variables).
// The cookie holds a SHA-256 digest of the password, never the password itself, so changing
// PASSWORD logs every device out.

export const AUTH_COOKIE = "kbe_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 365; // stay signed in on the home-screen app for a year

export async function authToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`kalshi-btc-edge:v1:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison to avoid leaking how much of a token matched. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
