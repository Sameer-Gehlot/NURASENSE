import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SUPABASE_URL) ||
  import.meta.env?.VITE_SUPABASE_URL ||
  'https://rtqeevykhqomyoyxeebf.supabase.co';

export const SUPABASE_ANON_KEY =
  (typeof process !== 'undefined' && (process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)) ||
  import.meta.env?.VITE_SUPABASE_ANON_KEY ||
  'sb_publishable_xmsGv26EwRbB0C2xtMVwAA_Rs8-3O9Q';

/**
 * NuraSense Cloud Database & Google OAuth Client
 * Configured with PKCE flow, session auto-refresh, and URL session detection
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce'
  }
});
