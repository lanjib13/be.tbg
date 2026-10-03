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
const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  nomor_identitas: z.string().trim().min(3).max(64),
  no_hp: z.string().trim().min(5).max(30),
  alamat: z.string().trim().min(3).max(500),
  tanggal_lahir: z.string().date().nullable().optional(),
  email: z.union([z.string().trim().email().max(254), z.literal("")]).optional(),
  username,
  password,
});
const updateUserSchema = createUserSchema.omit({ password: true });
const statusSchema = z.object({ status: z.enum(["active", "inactive"]) });
const resetPasswordSchema = z.object({ password });
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

function mapDatabaseError(error, fallback) {
  if (error?.code === "23505") throw new AppError(409, "Username atau nomor identitas sudah digunakan");
  if (error?.code === "42501") throw new AppError(403, "Operasi ini tidak diizinkan untuk akun Anda");
  if (error?.code === "PGRST202") throw new AppError(503, "Migration database terbaru belum diterapkan");
  throw new AppError(400, fallback);
}

async function loadUserProfile(admin, id) {
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, auth_user_id, name, username, email, role, status, created_at, updated_at")
    .eq("id", id)
    .eq("role", "user")
    .maybeSingle();
  if (profileError) throw new AppError(500, "Pengguna gagal dimuat");
  if (!profile) throw new AppError(404, "Pengguna tidak ditemukan");

  const [details, savings] = await Promise.all([
    admin.from("user_profiles").select("nomor_identitas, no_hp, alamat, tanggal_lahir").eq("profile_id", id).maybeSingle(),
    admin.from("savings").select("id, nomor_rekening, saldo, status, created_at").eq("user_id", id).maybeSingle(),
  ]);
  if (details.error || savings.error) throw new AppError(500, "Detail pengguna gagal dimuat");
  return { ...profile, user_details: details.data, savings: savings.data };
}

router.use(requireSession, requireCsrf, allowRoles("admin", "super_admin"));

router.get("/", validate(listSchema, "query"), asyncRoute(async (request, response) => {
  const { page, pageSize, search, status } = request.validated;
  const admin = getSupabaseAdminClient();
  let query = admin.from("profiles")
    .select("id, auth_user_id, name, username, email, role, status, created_at", { count: "exact" })
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (status) query = query.eq("status", status);
  if (search) {
    const term = search.replace(/[,%()]/g, "").trim();
    if (term) query = query.or(`name.ilike.%${term}%,username.ilike.%${term}%`);
  }

  const { data: profiles, error, count } = await query;
  if (error) throw new AppError(500, "Daftar pengguna gagal dimuat");
  const ids = (profiles ?? []).map((profile) => profile.id);
  const [detailsResult, savingsResult] = ids.length === 0 ? [{ data: [], error: null }, { data: [], error: null }] : await Promise.all([
    admin.from("user_profiles").select("profile_id, nomor_identitas, no_hp, alamat, tanggal_lahir").in("profile_id", ids),
    admin.from("savings").select("user_id, id, nomor_rekening, saldo, status").in("user_id", ids),
  ]);
  if (detailsResult.error || savingsResult.error) throw new AppError(500, "Detail pengguna gagal dimuat");

  const detailsByProfile = new Map((detailsResult.data ?? []).map((row) => [row.profile_id, row]));
  const savingsByUser = new Map((savingsResult.data ?? []).map((row) => [row.user_id, row]));
  const users = (profiles ?? []).map((profile) => ({
    ...profile,
    user_details: detailsByProfile.get(profile.id) ?? null,
    savings: savingsByUser.get(profile.id) ?? null,
  }));
  return sendSuccess(response, "Daftar pengguna berhasil dimuat", {
    items: users,
    pagination: { page, pageSize, total: count ?? 0 },
  });
}));

router.post("/", validate(createUserSchema), asyncRoute(async (request, response) => {
  const input = request.validated;
  const admin = getSupabaseAdminClient();
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email: internalAuthEmail(input.username),
    password: input.password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    if (authError?.code === "email_exists") throw new AppError(409, "Username sudah digunakan");
    throw new AppError(400, "Akun Auth pengguna gagal dibuat");
  }

  const { data, error } = await admin.rpc("provision_managed_profile", {
    p_actor_profile_id: request.profile.id,
    p_auth_user_id: authData.user.id,
    p_name: input.name,
    p_username: input.username,
    p_email: input.email || null,
    p_role: "user",
    p_nomor_identitas: input.nomor_identitas,
    p_no_hp: input.no_hp,
    p_alamat: input.alamat,
    p_tanggal_lahir: input.tanggal_lahir ?? null,
    p_ip_address: request.ip ?? null,
    p_user_agent: request.get("user-agent") ?? null,
  });

  if (error) {
    await admin.auth.admin.deleteUser(authData.user.id);
    mapDatabaseError(error, "Pengguna gagal disimpan");
  }
  const created = Array.isArray(data) ? data[0] : data;
  return sendSuccess(response, "Pengguna berhasil dibuat", {
    id: created.profile_id,
    username: input.username,
    initialPassword: input.password,
    savingsId: created.savings_id,
    nomorRekening: created.nomor_rekening,
  }, 201);
}));

router.get("/:id", asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  return sendSuccess(response, "Detail pengguna berhasil dimuat", await loadUserProfile(getSupabaseAdminClient(), id));
}));

router.put("/:id", validate(updateUserSchema), asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const input = request.validated;
  const { data, error } = await getSupabaseAdminClient().rpc("update_managed_profile", {
    p_actor_profile_id: request.profile.id,
    p_target_profile_id: id,
    p_name: input.name,
    p_username: input.username,
    p_email: input.email || null,
    p_nomor_identitas: input.nomor_identitas,
    p_no_hp: input.no_hp,
    p_alamat: input.alamat,
    p_tanggal_lahir: input.tanggal_lahir ?? null,
    p_ip_address: request.ip ?? null,
    p_user_agent: request.get("user-agent") ?? null,
  });
  if (error) mapDatabaseError(error, "Pengguna gagal diperbarui");
  return sendSuccess(response, "Pengguna berhasil diperbarui", data);
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
  if (error) mapDatabaseError(error, "Status pengguna gagal diperbarui");
  return sendSuccess(response, "Status pengguna berhasil diperbarui", data);
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
  if (error) mapDatabaseError(error, "Pengguna gagal dinonaktifkan");
  return sendSuccess(response, "Pengguna berhasil dinonaktifkan", data);
}));

router.post("/:id/reset-password", validate(resetPasswordSchema), asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const admin = getSupabaseAdminClient();
  const { data: profile, error: profileError } = await admin.from("profiles")
    .select("id, auth_user_id, username, role")
    .eq("id", id)
    .eq("role", "user")
    .maybeSingle();
  if (profileError) throw new AppError(500, "Pengguna gagal dimuat");
  if (!profile) throw new AppError(404, "Pengguna tidak ditemukan");

  const { error } = await admin.auth.admin.updateUserById(profile.auth_user_id, { password: request.validated.password });
  if (error) throw new AppError(400, "Password pengguna gagal direset");
  const { error: auditError } = await admin.from("audit_logs").insert({
    user_id: request.profile.id,
    action: "RESET_PASSWORD",
    description: `Admin ${request.profile.username} mereset password ${profile.username}.`,
    ip_address: request.ip ?? null,
    user_agent: request.get("user-agent") ?? null,
  });
  if (auditError) throw new AppError(500, "Password telah direset tetapi audit log gagal ditulis");
  return sendSuccess(response, "Password pengguna berhasil direset", { username: profile.username });
}));

module.exports = { managedUsersRouter: router };
