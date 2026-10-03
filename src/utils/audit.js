const { getSupabaseAdminClient } = require("../config/supabase");

async function writeAudit(request, action, description, actorId = request.profile?.id ?? null) {
  const { error } = await getSupabaseAdminClient().from("audit_logs").insert({
    user_id: actorId,
    action,
    description,
    ip_address: request.ip ?? null,
    user_agent: request.get("user-agent") ?? null,
  });

  if (error) {
    throw new Error(`Audit write failed (${error.code ?? "unknown"})`);
  }
}

module.exports = { writeAudit };
