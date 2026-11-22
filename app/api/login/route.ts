import { NextResponse } from "next/server";
import { AUTH_COOKIE, AUTH_MAX_AGE, authToken, safeEqual } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const expected = process.env.PASSWORD;
  if (!expected) return NextResponse.json({ error: "PASSWORD is not set on the server" }, { status: 503 });
  let given = "";
  try {
    const body = await req.json();
    given = typeof body?.password === "string" ? body.password : "";
  } catch {}
  const ok = safeEqual(await authToken(given), await authToken(expected));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await authToken(expected), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}
