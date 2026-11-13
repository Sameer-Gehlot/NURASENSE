import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Next.js Middleware: Route Guard for NuraSense TPP
 * - If user visits /dashboard without being signed in -> redirect to / (login page)
 * - If user is already signed in and visits / -> redirect straight to /dashboard
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Supabase stores auth session cookies prefixed by sb- or containing auth-token
  const cookies = request.cookies.getAll();
  const hasAuthToken = cookies.some(
    (cookie) =>
      cookie.name.includes('-auth-token') ||
      cookie.name.includes('sb-') ||
      cookie.name === 'nurasense_session'
  );

  // If user visits /dashboard without being signed in, redirect to /
  if (pathname.startsWith('/dashboard') && !hasAuthToken) {
    const loginUrl = new URL('/', request.url);
    loginUrl.searchParams.set('auth', 'required');
    return NextResponse.redirect(loginUrl);
  }

  // If user is already signed in and visits /, redirect them straight to /dashboard
  if (pathname === '/' && hasAuthToken) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/dashboard/:path*'],
};
