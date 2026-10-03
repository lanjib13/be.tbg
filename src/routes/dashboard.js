const express = require("express");
const { getSupabaseAdminClient } = require("../config/supabase");
const { requireSession } = require("../middleware/session");
const { AppError, asyncRoute, sendSuccess } = require("../utils/http");

const router = express.Router();

router.get("/", requireSession, asyncRoute(async (request, response) => {
  const admin = getSupabaseAdminClient();
  const { data: summary, error: summaryError } = await admin.rpc("get_dashboard_summary", {
    p_actor_profile_id: request.profile.id,
  });
  if (summaryError) throw new AppError(500, "Ringkasan dashboard gagal dimuat");

  if (request.profile.role === "user") {
    const [savingsResult, detailsResult, transactionsResult] = await Promise.all([
      admin.from("savings").select("id, nomor_rekening, saldo, status").eq("user_id", request.profile.id).maybeSingle(),
      admin.from("user_profiles").select("nomor_identitas, no_hp, alamat, tanggal_lahir").eq("profile_id", request.profile.id).maybeSingle(),
      admin.from("transactions").select("id, transaction_code, type, amount, balance_after, transaction_date")
        .eq("user_id", request.profile.id).order("transaction_date", { ascending: false }).limit(10),
    ]);
    if (savingsResult.error || detailsResult.error || transactionsResult.error) {
      throw new AppError(500, "Dashboard pengguna gagal dimuat");
    }
    return sendSuccess(response, "Dashboard berhasil dimuat", {
      role: request.profile.role,
      profile: request.profile,
      userDetails: detailsResult.data,
      savings: savingsResult.data,
      summary,
      recentTransactions: transactionsResult.data ?? [],
    });
  }

  const { data: recentTransactions, error: transactionError } = await admin.from("transactions")
    .select("id, transaction_code, type, amount, transaction_date, user_id, admin_id")
    .order("transaction_date", { ascending: false })
    .limit(10);
  if (transactionError) throw new AppError(500, "Transaksi terbaru gagal dimuat");

  const profileIds = [...new Set((recentTransactions ?? []).flatMap((item) => [item.user_id, item.admin_id]))];
  const [{ data: profiles, error: profilesError }, auditResult] = await Promise.all([
    profileIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : admin.from("profiles").select("id, name, username").in("id", profileIds),
    request.profile.role === "super_admin"
      ? admin.from("audit_logs").select("id, user_id, action, description, created_at").order("created_at", { ascending: false }).limit(10)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (profilesError || auditResult.error) throw new AppError(500, "Aktivitas dashboard gagal dimuat");

  const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return sendSuccess(response, "Dashboard berhasil dimuat", {
    role: request.profile.role,
    summary,
    recentTransactions: (recentTransactions ?? []).map((item) => ({
      ...item,
      user: profilesById.get(item.user_id) ?? null,
      admin: profilesById.get(item.admin_id) ?? null,
    })),
    recentAuditLogs: auditResult.data ?? [],
  });
}));

module.exports = { dashboardRouter: router };
