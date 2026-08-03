import { createCookieSessionStorage, redirect } from "react-router";
import { prisma } from "./db.server";

/**
 * No silent fallback: a missing SESSION_SECRET used to mean cookies were signed
 * with a constant checked into the repo, which lets anyone forge a session for
 * any user id. Fail loudly at boot instead.
 */
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
  throw new Error(
    "SESSION_SECRET is not set. Add it to your .env file (any long random string) before starting the server."
  );
}

if (process.env.NODE_ENV === "production" && sessionSecret.length < 32) {
  throw new Error(
    "SESSION_SECRET must be at least 32 characters long in production."
  );
}

export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__family_finance_session",
    secure: process.env.NODE_ENV === "production",
    secrets: [sessionSecret],
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
  },
});

export async function getSession(request: Request) {
  const cookie = request.headers.get("Cookie");
  return sessionStorage.getSession(cookie);
}

/**
 * Reads the session and confirms it still matches the stored user record.
 * Returns null for a missing, malformed, deleted-user, or superseded session
 * (superseded = the password changed on another device after this cookie was
 * issued).
 */
async function readValidSession(
  request: Request
): Promise<{ id: string; name: string; email: string } | null> {
  const session = await getSession(request);
  const userId = session.get("userId");
  const sessionVersion = session.get("sessionVersion");

  if (!userId || typeof userId !== "string") return null;
  if (typeof sessionVersion !== "number") return null;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, sessionVersion: true },
    });

    if (!user) return null;
    if (user.sessionVersion !== sessionVersion) return null;

    return { id: user.id, name: user.name, email: user.email };
  } catch {
    return null;
  }
}

export async function getUserId(request: Request): Promise<string | null> {
  const user = await readValidSession(request);
  return user ? user.id : null;
}

export async function getUser(request: Request) {
  return readValidSession(request);
}

/** Throws a redirect (clearing the cookie) when there is no valid session. */
export async function requireUser(request: Request) {
  const user = await readValidSession(request);
  if (user) return user;

  const session = await getSession(request);
  const searchParams = new URLSearchParams([
    ["redirectTo", new URL(request.url).pathname],
  ]);
  throw redirect(`/login?${searchParams}`, {
    headers: {
      "Set-Cookie": await sessionStorage.destroySession(session),
    },
  });
}

export async function requireUserId(request: Request): Promise<string> {
  const user = await requireUser(request);
  return user.id;
}

export async function createUserSession({
  request,
  userId,
  sessionVersion,
  redirectTo,
}: {
  request: Request;
  userId: string;
  sessionVersion: number;
  redirectTo: string;
}) {
  const session = await getSession(request);
  session.set("userId", userId);
  session.set("sessionVersion", sessionVersion);
  return redirect(safeRedirect(redirectTo), {
    headers: {
      "Set-Cookie": await sessionStorage.commitSession(session),
    },
  });
}

export async function logout(request: Request) {
  const session = await getSession(request);
  return redirect("/login", {
    headers: {
      "Set-Cookie": await sessionStorage.destroySession(session),
    },
  });
}

/**
 * Only allow same-site relative redirects, so `?redirectTo=https://evil.test`
 * can't turn the login form into an open redirect.
 */
export function safeRedirect(to: unknown, fallback: string = "/"): string {
  if (!to || typeof to !== "string") return fallback;
  if (!to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\")) {
    return fallback;
  }
  return to;
}
