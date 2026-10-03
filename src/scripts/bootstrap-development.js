require("dotenv").config();

const { z } = require("zod");
const { environment } = require("../config/env");
const { getSupabaseAdminClient } = require("../config/supabase");

const bootstrapSchema = z.object({
  INITIAL_SUPER_ADMIN_NAME: z.string().trim().min(2).max(120),
  INITIAL_SUPER_ADMIN_USERNAME: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/),
  INITIAL_SUPER_ADMIN_PASSWORD: z.string().min(8).max(128),
  INITIAL_ADMIN_NAME: z.string().trim().min(2).max(120).optional(),
  INITIAL_ADMIN_USERNAME: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/).optional(),
  INITIAL_ADMIN_PASSWORD: z.string().min(8).max(128).optional(),
}).superRefine((values, context) => {
  const optionalAdminFields = [values.INITIAL_ADMIN_NAME, values.INITIAL_ADMIN_USERNAME, values.INITIAL_ADMIN_PASSWORD];
  if (optionalAdminFields.some(Boolean) && !optionalAdminFields.every(Boolean)) {
    context.addIssue({ code: "custom", message: "Semua INITIAL_ADMIN_* harus diisi bersama atau dikosongkan" });
  }
});

function internalAuthEmail(username) {
  return `${username}@accounts.simpanku.invalid`;
}

async function createAccount(admin, input, role) {
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email: internalAuthEmail(input.username),
    password: input.password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Supabase Auth account creation failed (${authError?.code ?? "unknown"})`);
  }

  const { data: profile, error: profileError } = await admin.from("profiles").insert({
    auth_user_id: authData.user.id,
    name: input.name,
    username: input.username,
    role,
    status: "active",
  }).select("id").single();

  if (profileError || !profile) {
    await admin.auth.admin.deleteUser(authData.user.id);
    throw new Error(`Profile creation failed (${profileError?.code ?? "unknown"})`);
  }

  return { authUserId: authData.user.id, profileId: profile.id, username: input.username };
}

async function main() {
  if (environment.NODE_ENV !== "development") {
    throw new Error("Bootstrap ditolak: script ini hanya boleh berjalan dengan NODE_ENV=development");
  }

  const input = bootstrapSchema.parse(process.env);
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin.from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "super_admin");
  if (error) throw new Error(`Could not check existing super admin (${error.code ?? "unknown"})`);
  if ((count ?? 0) > 0) throw new Error("Bootstrap ditolak: Super Admin sudah terdaftar");

  const superAdmin = await createAccount(admin, {
    name: input.INITIAL_SUPER_ADMIN_NAME,
    username: input.INITIAL_SUPER_ADMIN_USERNAME,
    password: input.INITIAL_SUPER_ADMIN_PASSWORD,
  }, "super_admin");

  let adminUsername = null;
  if (input.INITIAL_ADMIN_NAME && input.INITIAL_ADMIN_USERNAME && input.INITIAL_ADMIN_PASSWORD) {
    try {
      const initialAdmin = await createAccount(admin, {
        name: input.INITIAL_ADMIN_NAME,
        username: input.INITIAL_ADMIN_USERNAME,
        password: input.INITIAL_ADMIN_PASSWORD,
      }, "admin");
      adminUsername = initialAdmin.username;
    } catch (error) {
      console.error("Super Admin awal berhasil dibuat; Admin opsional gagal dibuat.", error.message);
      process.exitCode = 1;
      return;
    }
  }

  console.info(JSON.stringify({
    created: true,
    superAdminUsername: superAdmin.username,
    adminUsername,
    message: "Akun dibuat. Password tidak dicatat; hapus nilai INITIAL_* dari environment setelah bootstrap.",
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
