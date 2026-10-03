const express = require("express");
const { z } = require("zod");
const { getSupabaseAdminClient } = require("../config/supabase");
const { allowRoles, requireCsrf } = require("../middleware/access");
const { requireSession } = require("../middleware/session");
const { AppError, asyncRoute, sendSuccess, validate } = require("../utils/http");
const { internalAuthEmail } = require("./auth");

const router = express.Router();
const username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/);
const password = z.string().min(10).max(128);
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.union([z.string().trim().email().max(254), z.literal("")]).optional(),
  username,
  password,
});
const updateSchema = createSchema.omit({ password: true });
const statusSchema = z.object({ status: z.enum(["active", "inactive"]) });
const resetSchema = z.object({ password });
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

function mapDatabaseError(error, fallback) {
  if (error?.code === "23505") throw new AppError(409, "Username sudah digunakan");
  if (error?.code === "42501") throw new AppError(403, "Operasi ini hanya dapat dilakukan Super Admin");
  if (error?.code === "PGRST202") throw new AppError(503, "Migration database terbaru belum diterapkan");
  throw new AppError(400, fallback);
}

router.use(requireSession, requireCsrf, allowRoles("super_admin"));

router.get("/", validate(listSchema, "query"), asyncRoute(async (request, response) => {
  const { page, pageSize, search, status } = request.validated;
  const admin = getSupabaseAdminClient();
  let query = admin.from("profiles")
    .select("id, name, username, email, role, status, created_at, updated_at", { count: "exact" })
    .eq("role", "admin")
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (status) query = query.eq("status", status);
  if (search) {
    const term = search.replace(/[,%()]/g, "").trim();
    if (term) query = query.or(`name.ilike.%${term}%,username.ilike.%${term}%`);
  }
  const { data, error, count } = await query;
  if (error) throw new AppError(500, "Daftar Admin gagal dimuat");
  return sendSuccess(response, "Daftar Admin berhasil dimuat", {
    items: data ?? [],
    pagination: { page, pageSize, total: count ?? 0 },
  });
}));

router.post("/", validate(createSchema), asyncRoute(async (request, response) => {
  const input = request.validated;
  const admin = getSupabaseAdminClient();
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email: internalAuthEmail(input.username),
    password: input.password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    if (authError?.code === "email_exists") throw new AppError(409, "Username sudah digunakan");
    throw new AppError(400, "Akun Auth Admin gagal dibuat");
  }

  const { data, error } = await admin.rpc("provision_managed_profile", {
    p_actor_profile_id: request.profile.id,
    p_auth_user_id: authData.user.id,
    p_name: input.name,
    p_username: input.username,
    p_email: input.email || null,
    p_role: "admin",
    p_ip_address: request.ip ?? null,
    p_user_agent: request.get("user-agent") ?? null,
  });
  if (error) {
    await admin.auth.admin.deleteUser(authData.user.id);
    mapDatabaseError(error, "Admin gagal disimpan");
  }
  const created = Array.isArray(data) ? data[0] : data;
  return sendSuccess(response, "Admin berhasil dibuat", {
    id: created.profile_id,
    username: input.username,
    initialPassword: input.password,
  }, 201);
}));

router.get("/:id", asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const { data, error } = await getSupabaseAdminClient().from("profiles")
    .select("id, name, username, email, role, status, created_at, updated_at")
    .eq("id", id)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new AppError(500, "Admin gagal dimuat");
  if (!data) throw new AppError(404, "Admin tidak ditemukan");
  return sendSuccess(response, "Detail Admin berhasil dimuat", data);
}));

router.put("/:id", validate(updateSchema), asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const input = request.validated;
  const { data, error } = await getSupabaseAdminClient().rpc("update_managed_profile", {
    p_actor_profile_id: request.profile.id,
    p_target_profile_id: id,
    p_name: input.name,
    p_username: input.username,
    p_email: input.email || null,
    p_ip_address: request.ip ?? null,
    p_user_agent: request.get("user-agent") ?? null,
  });
  if (error) mapDatabaseError(error, "Admin gagal diperbarui");
  return sendSuccess(response, "Admin berhasil diperbarui", data);
}));

router.patch("/:id/status", validate(statusSchema), asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const { data, error } = await getSupabaseAdminClient().rpc("set_managed_profile_status", {
    p_actor_profile_id: request.profile.id,
    p_target_profile_id: id,
    p_status: request.validated.status,
    p_ip_address: request.ip ?? null,
    p_user_agent: request.get("user-agent") ?? null,
  });
  if (error) mapDatabaseError(error, "Status Admin gagal diperbarui");
  return sendSuccess(response, "Status Admin berhasil diperbarui", data);
}));

router.delete("/:id", asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const { data, error } = await getSupabaseAdminClient().rpc("set_managed_profile_status", {
    p_actor_profile_id: request.profile.id,
    p_target_profile_id: id,
    p_status: "inactive",
    p_ip_address: request.ip ?? null,
    p_user_agent: request.get("user-agent") ?? null,
  });
  if (error) mapDatabaseError(error, "Admin gagal dinonaktifkan");
  return sendSuccess(response, "Admin berhasil dinonaktifkan", data);
}));

router.post("/:id/reset-password", validate(resetSchema), asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const admin = getSupabaseAdminClient();
  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("id, auth_user_id, username")
    .eq("id", id)
    .eq("role", "admin")
    .maybeSingle();
  if (profileError) throw new AppError(500, "Admin gagal dimuat");
  if (!profile) throw new AppError(404, "Admin tidak ditemukan");

  const { error } = await admin.auth.admin.updateUserById(profile.auth_user_id, { password: request.validated.password });
  if (error) throw new AppError(400, "Password Admin gagal direset");
  const { error: auditError } = await admin.from("audit_logs").insert({
    user_id: request.profile.id,
    action: "RESET_PASSWORD",
    description: `Super Admin ${request.profile.username} mereset password ${profile.username}.`,
    ip_address: request.ip ?? null,
    user_agent: request.get("user-agent") ?? null,
  });
  if (auditError) throw new AppError(500, "Password telah direset tetapi audit log gagal ditulis");
  return sendSuccess(response, "Password Admin berhasil direset", { username: profile.username });
}));

module.exports = { managedAdminsRouter: router };
