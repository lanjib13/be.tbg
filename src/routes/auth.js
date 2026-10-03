const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { createSupabaseAuthClient, getSupabaseAdminClient } = require("../config/supabase");
const { allowRoles, requireCsrf } = require("../middleware/access");
const { requireSession, setSessionCookies, clearSessionCookies } = require("../middleware/session");
const { AppError, asyncRoute, sendFailure, sendSuccess, validate } = require("../utils/http");
const { writeAudit } = require("../utils/audit");

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Terlalu banyak percobaan login", errors: {} },
});
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/);
const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10).max(128),
});

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    email: profile.email,
    role: profile.role,
    status: profile.status,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

function internalAuthEmail(username) {
  return `${username}@accounts.simpanku.invalid`;
}

router.post(
  "/auth/login",
  loginLimiter,
  validate(loginSchema),
  asyncRoute(async (request, response) => {
    const { username, password } = request.validated;
    const authClient = createSupabaseAuthClient();
    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email: internalAuthEmail(username),
      password,
    });

    if (authError || !authData.user || !authData.session) {
      return sendFailure(response, 401, "Username atau password salah");
    }

    const { data: profile, error: profileError } = await getSupabaseAdminClient()
      .from("profiles")
      .select("id, auth_user_id, name, username, email, role, status, created_at, updated_at")
      .eq("auth_user_id", authData.user.id)
      .maybeSingle();

    if (profileError || !profile || profile.status !== "active" || profile.username !== username) {
      await authClient.auth.signOut({ scope: "local" });
      return sendFailure(response, 401, "Akun tidak aktif atau profil tidak ditemukan");
    }

    await writeAudit(request, "LOGIN", `Login berhasil untuk ${profile.username}.`, profile.id);
    const csrfToken = require("../middleware/access").newCsrfToken();
    setSessionCookies(response, authData.session, csrfToken);
    return sendSuccess(response, "Login berhasil", { profile: publicProfile(profile) });
  }),
);

router.get("/auth/me", requireSession, (request, response) => {
  return sendSuccess(response, "Session aktif", { profile: publicProfile(request.profile) });
});

router.post("/auth/logout", requireSession, requireCsrf, asyncRoute(async (request, response) => {
  const authClient = createSupabaseAuthClient();
  const { error: sessionError } = await authClient.auth.setSession({
    access_token: request.sessionTokens.accessToken,
    refresh_token: request.sessionTokens.refreshToken,
  });
  if (!sessionError) await authClient.auth.signOut({ scope: "local" });
  await writeAudit(request, "LOGOUT", `Logout untuk ${request.profile.username}.`);
  clearSessionCookies(response);
  return sendSuccess(response, "Logout berhasil", {});
}));

router.get("/profile", requireSession, asyncRoute(async (request, response) => {
  const admin = getSupabaseAdminClient();
  const [detailsResult, savingsResult] = await Promise.all([
    admin.from("user_profiles").select("nomor_identitas, no_hp, alamat, tanggal_lahir").eq("profile_id", request.profile.id).maybeSingle(),
    admin.from("savings").select("id, nomor_rekening, saldo, status, created_at").eq("user_id", request.profile.id).maybeSingle(),
  ]);

  if (detailsResult.error || savingsResult.error) {
    throw new AppError(500, "Profil gagal dimuat");
  }

  return sendSuccess(response, "Profil berhasil dimuat", {
    profile: publicProfile(request.profile),
    userDetails: detailsResult.data,
    savings: savingsResult.data,
  });
}));

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.union([z.string().trim().email().max(254), z.literal("")]).nullable().optional(),
  no_hp: z.string().trim().min(5).max(30).optional(),
  alamat: z.string().trim().min(3).max(500).optional(),
  tanggal_lahir: z.string().date().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "Minimal satu field harus diisi");

router.patch("/profile", requireSession, requireCsrf, allowRoles("admin", "super_admin"), validate(updateProfileSchema), asyncRoute(async (request, response) => {
  const admin = getSupabaseAdminClient();
  const updates = request.validated;
  const profileUpdates = {};
  for (const key of ["name", "email"]) {
    if (Object.hasOwn(updates, key)) profileUpdates[key] = updates[key] || null;
  }

  if (Object.keys(profileUpdates).length > 0) {
    const { error } = await admin.from("profiles").update(profileUpdates).eq("id", request.profile.id);
    if (error) throw new AppError(409, "Profil gagal diperbarui");
  }

  const detailsUpdates = {};
  for (const key of ["no_hp", "alamat", "tanggal_lahir"]) {
    if (Object.hasOwn(updates, key)) detailsUpdates[key] = updates[key];
  }
  if (Object.keys(detailsUpdates).length > 0) {
    const { error } = await admin.from("user_profiles").update(detailsUpdates).eq("profile_id", request.profile.id);
    if (error) throw new AppError(409, "Detail profil gagal diperbarui");
  }

  await writeAudit(request, "UPDATE_USER", `Profil ${request.profile.username} diperbarui.`);
  const { data: updatedProfile, error } = await admin.from("profiles")
    .select("id, name, username, email, role, status, created_at, updated_at")
    .eq("id", request.profile.id)
    .single();
  if (error) throw new AppError(500, "Profil gagal dimuat ulang");

  return sendSuccess(response, "Profil berhasil diperbarui", { profile: updatedProfile });
}));

router.post("/profile/password", requireSession, requireCsrf, validate(passwordSchema), asyncRoute(async (request, response) => {
  if (request.profile.role === "user") {
    throw new AppError(403, "Pengguna/Santri tidak diizinkan mengubah password mandiri");
  }

  const authClient = createSupabaseAuthClient();
  const { data: verifiedSession, error: verificationError } = await authClient.auth.signInWithPassword({
    email: internalAuthEmail(request.profile.username),
    password: request.validated.currentPassword,
  });
  if (verificationError || !verifiedSession.session) throw new AppError(401, "Password saat ini tidak cocok");

  const { data: passwordUpdate, error } = await authClient.auth.updateUser({ password: request.validated.newPassword });
  if (error || !passwordUpdate.user) throw new AppError(400, "Password gagal diperbarui");

  setSessionCookies(response, verifiedSession.session, request.cookies.simpanku_csrf);
  await writeAudit(request, "RESET_PASSWORD", `Password sendiri diperbarui untuk ${request.profile.username}.`);
  return sendSuccess(response, "Password berhasil diperbarui", {});
}));

module.exports = { authRouter: router, internalAuthEmail, publicProfile };
