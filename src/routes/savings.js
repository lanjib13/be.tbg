const express = require("express");
const { z } = require("zod");
const { getSupabaseAdminClient } = require("../config/supabase");
const { asyncRoute, sendSuccess, AppError } = require("../utils/http");
const { requireSession } = require("../middleware/session");

const router = express.Router();

router.get("/", requireSession, asyncRoute(async (request, response) => {
  const admin = getSupabaseAdminClient();
  let query = admin.from("savings").select("id, user_id, nomor_rekening, saldo, status, created_at, updated_at").order("created_at", { ascending: false });
  if (request.profile.role === "user") query = query.eq("user_id", request.profile.id);

  const { data: savings, error } = await query;
  if (error) throw new AppError(500, "Data tabungan gagal dimuat");
  const userIds = [...new Set((savings ?? []).map((item) => item.user_id))];
  const { data: profiles, error: profileError } = userIds.length === 0
    ? { data: [], error: null }
    : await admin.from("profiles").select("id, name, username, status").in("id", userIds);
  if (profileError) throw new AppError(500, "Data pemilik rekening gagal dimuat");

  const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  return sendSuccess(response, "Data tabungan berhasil dimuat", {
    items: (savings ?? []).map((item) => ({ ...item, owner: profilesById.get(item.user_id) ?? null })),
  });
}));

router.get("/:id", requireSession, asyncRoute(async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  let query = getSupabaseAdminClient().from("savings")
    .select("id, user_id, nomor_rekening, saldo, status, created_at, updated_at")
    .eq("id", id);
  if (request.profile.role === "user") query = query.eq("user_id", request.profile.id);

  const { data, error } = await query.maybeSingle();
  if (error) throw new AppError(500, "Rekening gagal dimuat");
  if (!data) throw new AppError(404, "Rekening tidak ditemukan");
  return sendSuccess(response, "Rekening berhasil dimuat", data);
}));

module.exports = { savingsRouter: router };
