const express = require("express");
const { z } = require("zod");
const { getSupabaseAdminClient } = require("../config/supabase");
const { allowRoles } = require("../middleware/access");
const { requireSession } = require("../middleware/session");
const { AppError, asyncRoute, sendSuccess, validate } = require("../utils/http");

const router = express.Router();
const reportSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  userId: z.string().uuid().optional(),
  type: z.enum(["deposit", "withdrawal"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

router.use(requireSession);

router.get("/transactions", validate(reportSchema, "query"), asyncRoute(async (request, response) => {
  const filters = request.validated;
  if (request.profile.role === "user" && filters.userId && filters.userId !== request.profile.id) {
    throw new AppError(403, "Anda hanya dapat melihat laporan transaksi milik sendiri");
  }
  if (!['user', 'admin', 'super_admin'].includes(request.profile.role)) {
    throw new AppError(403, "Anda tidak memiliki izin melihat laporan");
  }
  const scopedUserId = request.profile.role === "user" ? request.profile.id : filters.userId ?? null;
  const from = filters.from ? `${filters.from}T00:00:00.000Z` : null;
  const to = filters.to ? `${filters.to}T23:59:59.999Z` : null;
  const admin = getSupabaseAdminClient();
  const [{ data: summary, error: summaryError }, rowsResult] = await Promise.all([
    admin.rpc("get_transaction_report_summary", {
      p_actor_profile_id: request.profile.id,
      p_from: from,
      p_to: to,
      p_user_id: scopedUserId,
      p_type: filters.type ?? null,
    }),
    (async () => {
      let query = admin.from("transactions")
        .select("id, transaction_code, user_id, admin_id, type, amount, balance_before, balance_after, description, transaction_date", { count: "exact" })
        .order("transaction_date", { ascending: false })
        .range((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize - 1);
      if (from) query = query.gte("transaction_date", from);
      if (to) query = query.lte("transaction_date", to);
      if (scopedUserId) query = query.eq("user_id", scopedUserId);
      if (filters.type) query = query.eq("type", filters.type);
      return query;
    })(),
  ]);
  if (summaryError || rowsResult.error) throw new AppError(400, "Laporan transaksi gagal dimuat");

  const profileIds = [...new Set((rowsResult.data ?? []).flatMap((item) => [item.user_id, item.admin_id]))];
  const { data: profiles, error: profileError } = profileIds.length === 0
    ? { data: [], error: null }
    : await admin.from("profiles").select("id, name, username").in("id", profileIds);
  if (profileError) throw new AppError(500, "Nama pada laporan gagal dimuat");
  const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return sendSuccess(response, "Laporan transaksi berhasil dimuat", {
    summary,
    items: (rowsResult.data ?? []).map((item) => ({
      ...item,
      user: profilesById.get(item.user_id) ?? null,
      admin: profilesById.get(item.admin_id) ?? null,
    })),
    pagination: { page: filters.page, pageSize: filters.pageSize, total: rowsResult.count ?? 0 },
  });
}));

router.get("/savings", allowRoles("admin", "super_admin"), asyncRoute(async (_request, response) => {
  const admin = getSupabaseAdminClient();
  const [{ data: savings, error }, { count: users, error: usersError }] = await Promise.all([
    admin.from("savings").select("saldo, status"),
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "user"),
  ]);
  if (error || usersError) throw new AppError(500, "Laporan tabungan gagal dimuat");

  const items = savings ?? [];
  const summary = items.reduce((result, item) => {
    result.totalBalance += Number(item.saldo);
    result.totalSavings += 1;
    if (item.status === "active") result.activeSavings += 1;
    else result.inactiveSavings += 1;
    return result;
  }, { totalBalance: 0, totalSavings: 0, activeSavings: 0, inactiveSavings: 0 });
  return sendSuccess(response, "Laporan tabungan berhasil dimuat", { ...summary, totalUsers: users ?? 0 });
}));

const monthlyReportSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).default(new Date().getFullYear()),
});

router.get("/monthly", allowRoles("admin", "super_admin"), validate(monthlyReportSchema, "query"), asyncRoute(async (request, response) => {
  const { year } = request.validated;
  const admin = getSupabaseAdminClient();

  const startOfYear = `${year}-01-01T00:00:00.000Z`;
  const endOfYear = `${year}-12-31T23:59:59.999Z`;

  const [{ data: transactions, error }, { data: savings, error: savingsError }] = await Promise.all([
    admin.from("transactions")
      .select("type, amount, transaction_date")
      .gte("transaction_date", startOfYear)
      .lte("transaction_date", endOfYear),
    admin.from("savings").select("saldo"),
  ]);

  if (error || savingsError) throw new AppError(500, "Arsip laporan bulanan gagal dimuat");

  const totalCurrentSavings = (savings ?? []).reduce((sum, item) => sum + Number(item.saldo), 0);

  const monthNames = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
  ];

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonthIdx = now.getUTCMonth();

  const months = monthNames.map((name, index) => {
    const monthNum = index + 1;
    const txInMonth = (transactions ?? []).filter((t) => {
      const d = new Date(t.transaction_date);
      return d.getUTCFullYear() === year && (d.getUTCMonth() + 1) === monthNum;
    });

    const totalDeposits = txInMonth
      .filter((t) => t.type === "deposit")
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const totalWithdrawals = txInMonth
      .filter((t) => t.type === "withdrawal")
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const isCurrent = year === currentYear && index === currentMonthIdx;
    const isPast = year < currentYear || (year === currentYear && index < currentMonthIdx);

    return {
      monthNumber: monthNum,
      monthName: name,
      year,
      totalDeposits,
      totalWithdrawals,
      netFlow: totalDeposits - totalWithdrawals,
      transactionCount: txInMonth.length,
      status: isCurrent ? "current" : isPast ? "closed" : "upcoming",
    };
  });

  return sendSuccess(response, "Arsip laporan bulanan berhasil dimuat", {
    year,
    totalCurrentSavings,
    months,
  });
}));

const monthlyBreakdownSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  userId: z.string().uuid().optional(),
});

router.get("/monthly-breakdown", allowRoles("admin", "super_admin", "user"), validate(monthlyBreakdownSchema, "query"), asyncRoute(async (request, response) => {
  const { from, to, userId } = request.validated;
  const admin = getSupabaseAdminClient();

  if (request.profile.role === "user" && userId && userId !== request.profile.id) {
    throw new AppError(403, "Akses ditolak");
  }
  const scopedUserId = request.profile.role === "user" ? request.profile.id : userId ?? null;

  const now = new Date();
  const defaultToDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const defaultFromDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

  const startDate = from ? new Date(from + "T00:00:00.000Z") : defaultFromDate;
  const endDate = to ? new Date(to + "T23:59:59.999Z") : defaultToDate;

  let txQuery = admin.from("transactions")
    .select("type, amount, transaction_date")
    .gte("transaction_date", startDate.toISOString())
    .lte("transaction_date", endDate.toISOString());

  if (scopedUserId) {
    txQuery = txQuery.eq("user_id", scopedUserId);
  }

  const [{ data: transactions, error }, { data: savings, error: savingsError }] = await Promise.all([
    txQuery,
    request.profile.role === "user"
      ? admin.from("savings").select("saldo").eq("user_id", request.profile.id)
      : admin.from("savings").select("saldo"),
  ]);

  if (error || savingsError) throw new AppError(500, "Laporan bulanan gagal dimuat");

  const totalCurrentSavings = (savings ?? []).reduce((sum, item) => sum + Number(item.saldo), 0);

  const monthNames = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
  ];

  const months = [];
  const cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));

  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    const mNum = m + 1;

    const txInMonth = (transactions ?? []).filter((t) => {
      const d = new Date(t.transaction_date);
      return d.getUTCFullYear() === y && (d.getUTCMonth() + 1) === mNum;
    });

    const totalDeposits = txInMonth
      .filter((t) => t.type === "deposit")
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const totalWithdrawals = txInMonth
      .filter((t) => t.type === "withdrawal")
      .reduce((sum, t) => sum + Number(t.amount), 0);

    months.push({
      year: y,
      monthNumber: mNum,
      monthName: monthNames[m],
      label: `${monthNames[m]} ${y}`,
      totalDeposits,
      totalWithdrawals,
      netFlow: totalDeposits - totalWithdrawals,
      transactionCount: txInMonth.length,
    });

    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }

  return sendSuccess(response, "Rekapitulasi bulanan berhasil dimuat", {
    totalCurrentSavings,
    months,
  });
}));

module.exports = { reportsRouter: router };
