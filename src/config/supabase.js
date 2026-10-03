const { createClient } = require("@supabase/supabase-js");
const { environment } = require("./env");

let adminClient;

function getSupabaseAdminClient() {
  if (!adminClient) {
    adminClient = createClient(
      environment.SUPABASE_URL,
      environment.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }

  return adminClient;
}

function createSupabaseAuthClient() {
  return createClient(environment.SUPABASE_URL, environment.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

module.exports = { createSupabaseAuthClient, getSupabaseAdminClient };