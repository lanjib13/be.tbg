const { randomBytes } = require("node:crypto");
const { getSupabaseAdminClient, createSupabaseAuthClient } = require("../config/supabase");
const { sendFailure } = require("../utils/http");

const ACCESS_COOKIE = "simpanku_access";
const REFRESH_COOKIE = "simpanku_refresh";
const CSRF_COOKIE = "simpanku_csrf";

function cookieOptions(httpOnly, maxAge) {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge,
  };
}

function setSessionCookies(response, session, csrfToken) {
  response.cookie(ACCESS_COOKIE, session.access_token, cookieOptions(true, 15 * 60 * 1000));
  response.cookie(REFRESH_COOKIE, session.refresh_token, cookieOptions(true, 30 * 24 * 60 * 60 * 1000));
  response.cookie(CSRF_COOKIE, csrfToken, cookieOptions(false, 30 * 24 * 60 * 60 * 1000));
}

function clearSessionCookies(response) {
  for (const [name, httpOnly] of [
    [ACCESS_COOKIE, true],
    [REFRESH_COOKIE, true],
    [CSRF_COOKIE, false],
  ]) {
    response.clearCookie(name, cookieOptions(httpOnly));
  }
}

async function requireSession(request, response, next) {
  const accessToken = request.cookies?.[ACCESS_COOKIE];
  const refreshToken = request.cookies?.[REFRESH_COOKIE];
  const authClient = createSupabaseAuthClient();
  let activeRefreshToken = refreshToken;
  let authResult = accessToken
    ? await authClient.auth.getUser(accessToken)
    : { data: { user: null }, error: new Error("Missing access token") };
  let activeAccessToken = accessToken;

  if ((!authResult.data.user || authResult.error) && refreshToken) {
    const refreshResult = await authClient.auth.refreshSession({ refresh_token: refreshToken });
    if (!refreshResult.error && refreshResult.data.session && refreshResult.data.user) {
      activeAccessToken = refreshResult.data.session.access_token;
        activeRefreshToken = refreshResult.data.session.refresh_token;
      authResult = { data: { user: refreshResult.data.user }, error: null };
      setSessionCookies(
        response,
        refreshResult.data.session,
        request.cookies?.[CSRF_COOKIE] ?? randomBytes(32).toString("hex"),
      );
    }
  }

  if (authResult.error || !authResult.data.user) {
    clearSessionCookies(response);
    return sendFailure(response, 401, "Sesi tidak valid atau sudah berakhir");
  }

  const { data: profile, error } = await getSupabaseAdminClient()
    .from("profiles")
    .select("id, auth_user_id, name, username, email, role, status, created_at, updated_at")
    .eq("auth_user_id", authResult.data.user.id)
    .maybeSingle();

  if (error || !profile || profile.status !== "active") {
    clearSessionCookies(response);
    return sendFailure(response, 401, "Akun tidak aktif atau profil tidak ditemukan");
  }

  request.authUser = authResult.data.user;
  request.profile = profile;
  request.sessionTokens = {
    accessToken: activeAccessToken,
    refreshToken,
    refreshToken: activeRefreshToken,
  };
  return next();
}

module.exports = {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  requireSession,
  setSessionCookies,
};
