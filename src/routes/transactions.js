const express = require("express");
const { z } = require("zod");
const { getSupabaseAdminClient } = require("../config/supabase");
const { allowRoles, requireCsrf } = require("../middleware/access");
const { requireSession } = require("../middleware/session");
const { AppError, asyncRoute, sendFailure, sendSuccess, validate } = require("../utils/http");

const router = express.Router();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.string().uuid().optional(),
  type: z.enum(["deposit", "withdrawal"]).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  search: z.string().trim().max(80).optional(),
});
const transactionSchema = z.object({
  savingsId: z.string().uuid(),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  description: z.string().trim().max(500).default(""),
  transactionDate: z.string().datetime({ offset: true }).optional(),
});

function mapTransactionError(error) {
  if (error?.message?.includes("INSUFFICIENT_BALANCE")) {
    throw new AppError(409, "Penarikan gagal. Saldo tidak mencukupi.");
  }
  if (error?.message?.includes("SAVINGS_NOT_FOUND")) throw new AppError(404, "Rekening tidak ditemukan");
  if (error?.message?.includes("SAVINGS_INACTIVE") || error?.message?.includes("SAVINGS_OWNER_INACTIVE")) {
    throw new AppError(409, "Pengguna atau rekening tidak aktif");
  }
  if (error?.message?.includes("ACTIVE_ADMIN_REQUIRED")) throw new AppError(403, "Transaksi hanya dapat dibuat Admin aktif");
  if (error?.message?.includes("AMOUNT_MUST_BE_POSITIVE") || error?.message?.includes("INVALID_TRANSACTION_TYPE")) {
    throw new AppError(400, "Data transaksi tidak valid");
  }
  throw new AppError(500, "Transaksi gagal disimpan");
}

router.get("/", requireSession, validate(listSchema, "query"), asyncRoute(async (request, response) => {
  const { page, pageSize, userId, type, dateFrom, dateTo, search } = request.validated;
  const admin = getSupabaseAdminClient();
  let query = admin.from("transactions")
    .select("id, savings_id, user_id, admin_id, transaction_code, type, amount, balance_before, balance_after, description, transaction_date, created_at", { count: "exact" })
    .order("transaction_date", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (request.profile.role === "user") query = query.eq("user_id", request.profile.id);
  else if (userId) query = query.eq("user_id", userId);
  if (type) query = query.eq("type", type);
  if (dateFrom) query = query.gte("transaction_date", `${dateFrom}T00:00:00.000Z`);
  if (dateTo) query = query.lte("transaction_date", `${dateTo}T23:59:59.999Z`);
  if (search) {
    const term = search.replace(/[,%()]/g, "").trim();
    if (term) {
      const { data: matchedProfiles } = await admin
        .from("profiles")
        .select("id")
        .or(`name.ilike.%${term}%,username.ilike.%${term}%`);
      const matchedUserIds = (matchedProfiles ?? []).map((p) => p.id);

      if (matchedUserIds.length > 0) {
        query = query.or(`transaction_code.ilike.%${term}%,description.ilike.%${term}%,user_id.in.(${matchedUserIds.join(",")})`);
      } else {
        query = query.or(`transaction_code.ilike.%${term}%,description.ilike.%${term}%`);
      }
    }
  }

  const { data: transactions, error, count } = await query;
  if (error) throw new AppError(500, "Riwayat transaksi gagal dimuat");
  const profileIds = [...new Set((transactions ?? []).flatMap((transaction) => [transaction.user_id, transaction.admin_id]))];
  const { data: profiles, error: profileError } = profileIds.length === 0
    ? { data: [], error: null }
    : await admin.from("profiles").select("id, name, username").in("id", profileIds);
  if (profileError) throw new AppError(500, "Informasi transaksi gagal dimuat");
  const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

  return sendSuccess(response, "Riwayat transaksi berhasil dimuat", {
    items: (transactions ?? []).map((transaction) => ({
      ...transaction,
      user: profilesById.get(transaction.user_id) ?? null,
      admin: profilesById.get(transaction.admin_id) ?? null,
    })),
    pagination: { page, pageSize, total: count ?? 0 },
  });
}));

router.get("/:id", requireSession, asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const admin = getSupabaseAdminClient();
  let query = admin.from("transactions")
    .select("id, savings_id, user_id, admin_id, transaction_code, type, amount, balance_before, balance_after, description, transaction_date, created_at")
    .eq("id", id);
  if (request.profile.role === "user") query = query.eq("user_id", request.profile.id);

  const { data, error } = await query.maybeSingle();
  if (error) throw new AppError(500, "Transaksi gagal dimuat");
  if (!data) throw new AppError(404, "Transaksi tidak ditemukan");
  const { data: profiles, error: profileError } = await admin.from("profiles")
    .select("id, name, username")
    .in("id", [data.user_id, data.admin_id]);
  if (profileError) throw new AppError(500, "Informasi transaksi gagal dimuat");
  const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return sendSuccess(response, "Detail transaksi berhasil dimuat", {
    ...data,
    user: profilesById.get(data.user_id) ?? null,
    admin: profilesById.get(data.admin_id) ?? null,
  });
}));

function createTransactionHandler(type) {
  return [
    requireSession,
      requireCsrf,
    allowRoles("admin"),
    validate(transactionSchema),
    asyncRoute(async (request, response) => {
      const input = request.validated;
      const { data, error } = await getSupabaseAdminClient().rpc("record_savings_transaction", {
        p_savings_id: input.savingsId,
        p_actor_profile_id: request.profile.id,
        p_type: type,
        p_amount: input.amount,
        p_description: input.description,
        p_transaction_date: input.transactionDate ?? new Date().toISOString(),
        p_ip_address: request.ip ?? null,
        p_user_agent: request.get("user-agent") ?? null,
      });
      if (error) mapTransactionError(error);
      const transaction = Array.isArray(data) ? data[0] : data;
      return sendSuccess(response, type === "deposit" ? "Setoran berhasil disimpan" : "Penarikan berhasil disimpan", transaction, 201);
    }),
  ];
}

router.post("/deposit", ...createTransactionHandler("deposit"));
router.post("/withdrawal", ...createTransactionHandler("withdrawal"));

module.exports = { transactionsRouter: router };
