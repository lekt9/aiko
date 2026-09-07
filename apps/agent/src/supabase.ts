import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function required(name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function supabaseAdmin(): SupabaseClient {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
