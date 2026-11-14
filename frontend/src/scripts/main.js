/**
 * NuraSense — Application Entry Point
 * Orchestrates Landing interactions, Patient Dashboard state, and Google OAuth Authentication
 */

import '../styles/main.css';
import { supabase, signInWithGoogle } from './supabase.js';
import { initLandingInteractions } from './landing.js';
import {
  initDashboardListeners,
  initLiveTelemetryStream,
  initCloudEcgMonitor,
  checkDashboardAuth,
  renderAll,
  updateDashIdentity,
  updateDashDate,
  dashState,
  closePopovers,
  setActiveNav
} from './dashboard.js';
import { initPairDeviceModal } from './pair-device.js';
import {
  displayNameFromEmail,
  initialsFrom,
  visible,
  showToast
} from './modals.js';

const ORIGINAL_TITLE = document.title;

const authState = {
  signedIn: false,
  id: '',
  name: '',
  email: '',
  avatar: '',
  token: ''
};

let lastLoginTrigger = null;

// Persistent session storage helpers
function saveSession(user, token) {
  try {
    localStorage.setItem('nurasense_session', JSON.stringify({
      user,
      token,
      timestamp: Date.now()
    }));
  } catch (_) {}
}

function clearSession() {
  try {
    localStorage.removeItem('nurasense_session');
  } catch (_) {}
}

function extractUser(user) {
  if (!user) return null;
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || displayNameFromEmail(user.email || 'patient@nurasense.app');
  const avatar = meta.avatar_url || meta.picture || '';
  const email = user.email || '';
  return { id: user.id, name, avatar, email };
}

function applyUserSession(user, token) {
  if (user) {
    authState.signedIn = true;
    authState.id = user.id || '';
    authState.name = user.name;
    authState.email = user.email;
    authState.avatar = user.avatar || '';
    authState.token = token || '';
  } else {
    authState.signedIn = false;
    authState.id = '';
    authState.name = '';
    authState.email = '';
    authState.avatar = '';
    authState.token = '';
  }
  renderHeader();
}

function renderHeader() {
  const signedInCluster = document.getElementById('signedInCluster');
  const headerLogin = document.getElementById('headerLogin');
  const headerName = document.getElementById('headerName');
  const headerAvatar = document.getElementById('headerAvatar');

  if (signedInCluster) signedInCluster.hidden = !authState.signedIn;
  if (headerLogin) headerLogin.hidden = authState.signedIn;

  if (authState.signedIn) {
    if (headerName) headerName.textContent = authState.name;
    if (headerAvatar) {
      if (authState.avatar) {
        headerAvatar.innerHTML = `<img src="${authState.avatar}" alt="${authState.name}" class="avatar-photo" />`;
      } else {
        headerAvatar.textContent = initialsFrom(authState.name);
      }
    }
  }
}

export function openLoginDialog(trigger) {
  const dialog = document.getElementById('loginDialog');
  lastLoginTrigger = trigger || null;
  if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal();
  }
}

export function closeLoginDialog() {
  const dialog = document.getElementById('loginDialog');
  if (dialog && dialog.open) dialog.close();
}

export function openDashboard(trigger) {
  // If user visits /dashboard without being signed in, redirect to / (login page)
  if (!authState.signedIn) {
    if (window.location.pathname !== '/') {
      history.replaceState({ page: 'home' }, ORIGINAL_TITLE, '/');
    }
    openLoginDialog(trigger);
    return;
  }

  const dashboardApp = document.getElementById('dashboardApp');
  const siteHeader = document.querySelector('.site-header');
  const siteMain = document.getElementById('main');
  const siteFooter = document.querySelector('.site-footer');
  const siteSkip = document.querySelector('.skip-link');
  const dashGreeting = document.getElementById('dashGreeting');

  dashState.lastTrigger = trigger || null;
  dashState.homeScroll = window.scrollY;

  renderHeader();
  closeLoginDialog();
  closePopovers();

  if (dashboardApp) dashboardApp.hidden = false;
  if (siteHeader) siteHeader.hidden = true;
  if (siteMain) siteMain.hidden = true;
  if (siteFooter) siteFooter.hidden = true;
  if (siteSkip) siteSkip.hidden = true;

  document.body.classList.add('app-mode');
  document.title = 'Patient dashboard · NuraSense';

  // Push /dashboard to browser history so URL is /dashboard
  if (window.location.pathname !== '/dashboard') {
    history.replaceState({ page: 'dashboard' }, 'Patient dashboard · NuraSense', '/dashboard');
  }

  // Update navbar with user's Google photo + name
  updateDashIdentity(authState.name, authState.avatar);
  updateDashDate();
  renderAll();

  // Initialize live cloud ECG telemetry for the authenticated patient
  if (authState.id) {
    initCloudEcgMonitor(authState.id);
  }

  window.scrollTo(0, 0);
  setActiveNav('dash-overview');

  window.setTimeout(() => {
    if (dashGreeting) dashGreeting.focus({ preventScroll: true });
  }, 80);
}

export function exitDashboard() {
  const dashboardApp = document.getElementById('dashboardApp');
  const siteHeader = document.querySelector('.site-header');
  const siteMain = document.getElementById('main');
  const siteFooter = document.querySelector('.site-footer');
  const siteSkip = document.querySelector('.skip-link');
  const appToast = document.getElementById('appToast');
  const headerDashboard = document.getElementById('headerDashboard');
  const previewDashboardBtn = document.getElementById('previewDashboardBtn');

  closePopovers();
  if (appToast) appToast.hidden = true;
  if (dashboardApp) dashboardApp.hidden = true;

  document.body.classList.remove('app-mode');
  if (siteHeader) siteHeader.hidden = false;
  if (siteMain) siteMain.hidden = false;
  if (siteFooter) siteFooter.hidden = false;
  if (siteSkip) siteSkip.hidden = false;

  document.title = ORIGINAL_TITLE;

  // Restore URL to /
  if (window.location.pathname !== '/') {
    history.pushState({ page: 'home' }, ORIGINAL_TITLE, '/');
  }

  window.scrollTo(0, dashState.homeScroll || 0);

  let target = dashState.lastTrigger;
  if (!target || !visible(target)) {
    target = authState.signedIn ? headerDashboard : previewDashboardBtn;
  }
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  dashState.lastTrigger = null;
}

function initAuthModalListeners() {
  const dialog = document.getElementById('loginDialog');
  const dialogClose = document.getElementById('dialogClose');
  const googleBtn = document.getElementById('googleBtn');
  const googleLabel = document.getElementById('googleLabel');
  const googleSpinner = document.getElementById('googleSpinner');
  const signOutBtn = document.getElementById('signOutBtn');
  const headerSignOut = document.getElementById('headerSignOut');
  const dashSignOut = document.getElementById('dashSignOut');
  const loginTriggers = document.querySelectorAll('.js-login');

  loginTriggers.forEach((trigger) => {
    trigger.addEventListener('click', () => openLoginDialog(trigger));
  });

  if (dialogClose) dialogClose.addEventListener('click', closeLoginDialog);
  if (dialog) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeLoginDialog();
    });
  }

  // Google Sign-In with Supabase OAuth
  if (googleBtn) {
    googleBtn.addEventListener('click', async () => {
      if (googleBtn.disabled) return;
      googleBtn.disabled = true;
      googleBtn.setAttribute('aria-busy', 'true');
      if (googleLabel) googleLabel.textContent = 'Redirecting to Google…';
      if (googleSpinner) googleSpinner.hidden = false;

      try {
        const { error } = await signInWithGoogle();
        if (error) throw error;
      } catch (err) {
        console.warn('OAuth trigger notice:', err.message);
        showToast(err.message || 'Google sign-in failed');
        googleBtn.disabled = false;
        googleBtn.removeAttribute('aria-busy');
        if (googleLabel) googleLabel.textContent = 'Continue with Google';
        if (googleSpinner) googleSpinner.hidden = true;
      }
    });
  }

  async function handleSignOut() {
    try {
      await supabase.auth.signOut();
    } catch (_) {}
    clearSession();
    applyUserSession(null);
    closeLoginDialog();
    exitDashboard();
    history.replaceState(null, '', '/');
    showToast('Signed out of NuraSense');
  }

  if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);
  if (headerSignOut) headerSignOut.addEventListener('click', handleSignOut);
  if (dashSignOut) dashSignOut.addEventListener('click', handleSignOut);
}

function initAppRouting() {
  const previewDashboardBtn = document.getElementById('previewDashboardBtn');
  const headerDashboard = document.getElementById('headerDashboard');
  const exitBtns = document.querySelectorAll('[data-exit-dashboard]');

  if (previewDashboardBtn) {
    previewDashboardBtn.addEventListener('click', () => openDashboard(previewDashboardBtn));
  }
  if (headerDashboard) {
    headerDashboard.addEventListener('click', () => openDashboard(headerDashboard));
  }
  exitBtns.forEach((btn) => {
    btn.addEventListener('click', exitDashboard);
  });

  // Global keybindings: Escape to exit or close modals
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopovers();
    }
  });
}

async function initSessionAndRouting() {
  // 0. Immediate handling for OAuth callback (?code= or /auth/callback)
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');

  if (code) {
    try {
      await supabase.auth.exchangeCodeForSession(code);
    } catch (err) {
      console.warn('OAuth code exchange note:', err.message);
    }
    // Smooth redirect directly to /dashboard with zero intermediate pages or buttons
    window.location.replace('/dashboard');
    return;
  }

  let activeUser = null;
  let activeToken = '';

  // 1. Check Supabase session (handles OAuth redirect ?code= or #access_token=)
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session?.user) {
      activeUser = extractUser(data.session.user);
      activeToken = data.session.access_token;
      saveSession(activeUser, activeToken);
    }
  } catch (_) {}

  // 2. Check local persistent session if not yet loaded
  if (!activeUser) {
    try {
      const raw = localStorage.getItem('nurasense_session');
      if (raw) {
        const stored = JSON.parse(raw);
        if (stored?.user?.name) {
          activeUser = stored.user;
          activeToken = stored.token || '';
        }
      }
    } catch (_) {}
  }

  // 3. Apply state
  if (activeUser) {
    applyUserSession(activeUser, activeToken);
  }

  // 4. Route protection:
  // - If user visits /dashboard without being signed in, redirect to / (login page)
  // - If user is already signed in and visits /, redirect them straight to /dashboard
  const currentPath = window.location.pathname;

  if (activeUser) {
    // Authenticated: visiting / -> redirect straight to /dashboard
    if (currentPath === '/' || currentPath === '' || currentPath.endsWith('index.html')) {
      history.replaceState({ page: 'dashboard' }, 'Patient dashboard · NuraSense', '/dashboard');
      openDashboard();
    } else if (currentPath.startsWith('/dashboard')) {
      openDashboard();
    }
  } else {
    // Unauthenticated: visiting /dashboard -> redirect to / (login page)
    if (currentPath.startsWith('/dashboard')) {
      history.replaceState({ page: 'home' }, ORIGINAL_TITLE, '/');
      exitDashboard();
      openLoginDialog();
    }
  }

  // 5. Listen to Supabase auth state changes for real-time OAuth callback resolution
  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      const u = extractUser(session.user);
      saveSession(u, session.access_token);
      applyUserSession(u, session.access_token);
      closeLoginDialog();
      // Immediately redirect to /dashboard with no intermediate page
      openDashboard();
    } else if (event === 'SIGNED_OUT') {
      clearSession();
      applyUserSession(null);
      exitDashboard();
    }
  });

  // Handle browser back/forward buttons
  window.addEventListener('popstate', (e) => {
    if (window.location.pathname === '/dashboard') {
      if (authState.signedIn) openDashboard();
      else {
        history.replaceState(null, '', '/');
        exitDashboard();
        openLoginDialog();
      }
    } else {
      exitDashboard();
    }
  });
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
  initLandingInteractions();
  initAuthModalListeners();
  initDashboardListeners();
  initLiveTelemetryStream();
  initPairDeviceModal();
  initAppRouting();
  renderHeader();
  initSessionAndRouting();
});
