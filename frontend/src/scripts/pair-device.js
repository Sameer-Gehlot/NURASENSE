/**
 * NuraSense — Device Pairing & Hardware Management
 * Handles ESP32 telemetry hardware registration, listing, and unpairing via Supabase
 */

import { supabase } from './supabase.js';
import { showToast } from './modals.js';

let currentUserId = null;

/**
 * Initialize Pair Device Modal & Handlers
 */
export function initPairDeviceModal() {
  const modal = document.getElementById('pairDeviceModal');
  const closeBtn = document.getElementById('pairDeviceClose');
  const form = document.getElementById('pairDeviceForm');
  const openBtns = document.querySelectorAll('.js-open-pair-device');

  openBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openPairDeviceModal();
    });
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', closePairDeviceModal);
  }

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePairDeviceModal();
    });
  }

  if (form) {
    form.addEventListener('submit', handlePairDeviceSubmit);
  }
}

/**
 * Open the Pair Device Modal & Load current devices
 */
export async function openPairDeviceModal() {
  const modal = document.getElementById('pairDeviceModal');
  if (!modal) return;

  // Ensure we have current user ID from Supabase
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    showToast('Please sign in to pair telemetry hardware');
    return;
  }

  currentUserId = session.user.id;

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.hidden = false;
  }

  await loadPairedDevices(currentUserId);
}

/**
 * Close Pair Device Modal
 */
export function closePairDeviceModal() {
  const modal = document.getElementById('pairDeviceModal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.hidden = true;
  }
}

/**
 * Fetch and render all paired devices for the user
 */
export async function loadPairedDevices(userId) {
  const listEl = document.getElementById('pairedDevicesList');
  const loadingEl = document.getElementById('pairedDevicesLoading');
  const emptyEl = document.getElementById('pairedDevicesEmpty');

  if (!listEl) return;
  if (loadingEl) loadingEl.hidden = false;
  if (emptyEl) emptyEl.hidden = true;
  listEl.innerHTML = '';

  try {
    const { data: devices, error } = await supabase
      .from('devices')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (loadingEl) loadingEl.hidden = true;

    if (error) {
      console.warn('Devices query note:', error.message);
      listEl.innerHTML = `<p class="device-list-err">Could not load devices: ${error.message}</p>`;
      return;
    }

    if (!devices || devices.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

    // Render list of paired devices
    listEl.innerHTML = devices.map((d) => `
      <div class="paired-device-item" data-id="${d.id || d.device_token}">
        <div class="device-info">
          <div class="device-title-row">
            <span class="device-status-dot online" aria-hidden="true"></span>
            <strong class="device-name">${escapeHtml(d.device_name || 'ESP32 ECG Monitor')}</strong>
            <span class="device-badge">Active</span>
          </div>
          <div class="device-token-row">
            <code class="device-token-code" title="Use this in esp32_cloud_firmware.ino">${escapeHtml(d.device_token)}</code>
            <button type="button" class="btn-copy-token" data-token="${escapeHtml(d.device_token)}" title="Copy token to clipboard">Copy</button>
          </div>
          <div class="device-meta">
            <span>Paired: ${d.created_at ? new Date(d.created_at).toLocaleDateString() : 'Active'}</span>
            <span>Sampling: 250 Hz Lead I</span>
          </div>
        </div>
        <button type="button" class="btn-remove-device" data-id="${d.id || ''}" data-token="${escapeHtml(d.device_token)}" aria-label="Disconnect device">
          Remove
        </button>
      </div>
    `).join('');

    // Attach copy and remove handlers
    listEl.querySelectorAll('.btn-copy-token').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const token = btn.getAttribute('data-token');
        try {
          await navigator.clipboard.writeText(token);
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
        } catch (_) {}
      });
    });

    listEl.querySelectorAll('.btn-remove-device').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const token = btn.getAttribute('data-token');
        await removeDevice(id, token, userId);
      });
    });

  } catch (err) {
    if (loadingEl) loadingEl.hidden = true;
    console.error('Failed to load devices:', err);
  }
}

/**
 * Handle new device pairing submission
 */
async function handlePairDeviceSubmit(e) {
  e.preventDefault();

  const tokenInput = document.getElementById('deviceTokenInput');
  const nameInput = document.getElementById('deviceNameInput');
  const statusEl = document.getElementById('pairDeviceStatus');
  const submitBtn = document.getElementById('pairDeviceSubmitBtn');

  const device_token = tokenInput ? tokenInput.value.trim() : '';
  const device_name = (nameInput && nameInput.value.trim()) || 'ESP32 ECG Monitor';

  if (!device_token) {
    if (statusEl) {
      statusEl.textContent = 'Please enter a device token (e.g. ESP32_BIOAMP_01)';
      statusEl.className = 'pair-status-msg error';
      statusEl.hidden = false;
    }
    return;
  }

  if (!currentUserId) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) currentUserId = session.user.id;
  }

  if (!currentUserId) {
    showToast('Error: User session not found. Please log in.');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Registering…';
  }
  if (statusEl) {
    statusEl.hidden = true;
  }

  try {
    const { data, error } = await supabase
      .from('devices')
      .insert({
        device_token,
        device_name,
        user_id: currentUserId
      })
      .select();

    if (error) {
      throw error;
    }

    // Success
    if (statusEl) {
      statusEl.textContent = `✓ Device "${device_name}" paired successfully!`;
      statusEl.className = 'pair-status-msg success';
      statusEl.hidden = false;
    }

    if (tokenInput) tokenInput.value = '';
    if (nameInput) nameInput.value = '';

    showToast(`Device paired: ${device_name}`);
    await loadPairedDevices(currentUserId);

  } catch (err) {
    console.error('Pairing error:', err);
    if (statusEl) {
      statusEl.textContent = `Pairing failed: ${err.message || 'Token might already be registered.'}`;
      statusEl.className = 'pair-status-msg error';
      statusEl.hidden = false;
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Pair Device';
    }
  }
}

/**
 * Remove / unpair a device
 */
async function removeDevice(id, token, userId) {
  if (!confirm(`Are you sure you want to disconnect device "${token}"?`)) {
    return;
  }

  try {
    let query = supabase.from('devices').delete();
    if (id) {
      query = query.eq('id', id);
    } else {
      query = query.eq('device_token', token);
    }

    const { error } = await query;
    if (error) throw error;

    showToast(`Device ${token} disconnected`);
    await loadPairedDevices(userId);

  } catch (err) {
    console.error('Failed to remove device:', err);
    showToast(`Failed to remove: ${err.message}`);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

