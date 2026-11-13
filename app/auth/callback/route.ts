import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Supabase OAuth Callback Route Handler (Next.js 14 App Router)
 * Exchanges OAuth authorization code for session and immediately redirects to /dashboard
 * with zero intermediate pages.
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');

  if (code) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://rtqeevykhqomyoyxeebf.supabase.co';
    const supabaseAnonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      'sb_publishable_xmsGv26EwRbB0C2xtMVwAA_Rs8-3O9Q';

    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    await supabase.auth.exchangeCodeForSession(code);
  }

  // Immediately redirect to /dashboard with no intermediate page
  return NextResponse.redirect(new URL('/dashboard', request.url));
}

