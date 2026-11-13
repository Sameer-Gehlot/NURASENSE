import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const cookies = request.cookies.getAll();
  const hasAuthToken = cookies.some(
    (cookie) =>
      cookie.name.includes('-auth-token') ||
      cookie.name.includes('sb-') ||
      cookie.name === 'nurasense_session'
  );

  if (pathname.startsWith('/dashboard') && !hasAuthToken) {
    const loginUrl = new URL('/', request.url);
    loginUrl.searchParams.set('auth', 'required');
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === '/' && hasAuthToken) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/dashboard/:path*'],
};
