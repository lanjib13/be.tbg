const express = require("express");
const { z } = require("zod");
const { getSupabaseAdminClient } = require("../config/supabase");
const { allowRoles } = require("../middleware/access");
const { requireSession } = require("../middleware/session");
const { AppError, asyncRoute, sendSuccess, validate } = require("../utils/http");

const router = express.Router();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  action: z.enum([
    "CREATE_USER", "UPDATE_USER", "CREATE_DEPOSIT", "CREATE_WITHDRAWAL", "RESET_PASSWORD",
    "LOGIN", "LOGOUT", "DISABLE_USER", "CREATE_ADMIN", "UPDATE_ADMIN",
  ]).optional(),
  actorId: z.string().uuid().optional(),
});

router.get("/", requireSession, allowRoles("super_admin"), validate(listSchema, "query"), asyncRoute(async (request, response) => {
  const { page, pageSize, action, actorId } = request.validated;
  const admin = getSupabaseAdminClient();
  let query = admin.from("audit_logs")
    .select("id, user_id, action, description, ip_address, user_agent, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (action) query = query.eq("action", action);
  if (actorId) query = query.eq("user_id", actorId);
  const { data: logs, error, count } = await query;
  if (error) throw new AppError(500, "Audit log gagal dimuat");

  const actorIds = [...new Set((logs ?? []).flatMap((item) => item.user_id ? [item.user_id] : []))];
  const { data: actors, error: actorsError } = actorIds.length === 0
    ? { data: [], error: null }
    : await admin.from("profiles").select("id, name, username, role").in("id", actorIds);
  if (actorsError) throw new AppError(500, "Aktor audit gagal dimuat");
  const actorsById = new Map((actors ?? []).map((actor) => [actor.id, actor]));

  return sendSuccess(response, "Audit log berhasil dimuat", {
    items: (logs ?? []).map((item) => ({ ...item, actor: item.user_id ? actorsById.get(item.user_id) ?? null : null })),
    pagination: { page, pageSize, total: count ?? 0 },
  });
}));

module.exports = { auditLogsRouter: router };
