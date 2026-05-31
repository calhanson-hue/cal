// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://heqxmjrqjnkwgzoaecmi.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_2KhYFU0PDXbLVkzKyBThnw_s6ZzkRu5';

  window.initCloudSync = function (config) {
    const appKey         = config && config.appKey;
    const syncedKeys     = (config && config.syncedKeys)     || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied      = config && config.onApplied;

    if (!appKey || !window.supabase) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa           = null;
    let channel        = null;
    let pushTimer      = null;
    let heartbeat      = null;
    let suppressSync   = false;
    let lastSyncedJson = null;

    // ── Key matching ───────────────────────────────────────────────────────
    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    // ── localStorage patch ─────────────────────────────────────────────────
    const origSet    = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };

    // ── Apply remote → local ───────────────────────────────────────────────
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { origSet(k, incoming); changed = true; } catch (e) {} }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }

    // ── Push local → Supabase ──────────────────────────────────────────────
    // Always use fetch + keepalive=true so the request survives page hide on iOS.
    // The Supabase JS client upsert() is async and CAN be suspended when Safari
    // backgrounds the page; a keepalive fetch cannot be cancelled by the browser.
    function doPush(state) {
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true, // survives page hide / bfcache freeze on iOS Safari
        }).then(function (r) {
          if (r.ok) lastSyncedJson = json;
        }).catch(function () {});
      } catch (e) {}
    }

    function pushNow() {
      doPush(collect());
    }

    // Short debounce (50ms) reduces the window in which an iOS page-hide can
    // land between the localStorage write and the push. Previously 250ms.
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 50);
    }

    // Bypass the debounce — used when the page is about to be hidden.
    function flushNow() {
      clearTimeout(pushTimer);
      pushNow();
    }

    // ── Pull Supabase → local ──────────────────────────────────────────────
    async function pullFromSupabase() {
      if (!supa) return;
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          const incoming = JSON.stringify(data.data);
          if (incoming !== lastSyncedJson) {
            lastSyncedJson = incoming;
            applyRemote(data.data);
          }
        } else if (!error && Object.keys(collect()).length > 0) {
          // Nothing in Supabase yet but we have local data — push it up.
          pushNow();
        }
      } catch (e) {}
    }

    // ── Supabase client + realtime ─────────────────────────────────────────
    // Extracted so it can be re-called after bfcache restoration, where the
    // WebSocket is dead and the realtime subscription is silently broken.
    function initSupabase() {
      if (channel) {
        try { supa.removeChannel(channel); } catch (e) {}
        channel = null;
      }
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      channel = supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, function (payload) {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    }

    (async function init() {
      initSupabase();
      await pullFromSupabase();
    })();

    // ── iOS page-lifecycle events ──────────────────────────────────────────
    //
    // On iOS Safari the page-hide sequence is:
    //   1. visibilitychange (hidden)  ← most reliable signal, fires before freeze
    //   2. pagehide                   ← fires, but page may already be frozen
    //   3. [page is frozen or killed] ← beforeunload does NOT fire on iOS
    //
    // On desktop:
    //   1. beforeunload  ← fires reliably
    //   2. pagehide
    //
    // Strategy: flush on visibilitychange(hidden) — this fires early enough that
    // a keepalive fetch can still be dispatched before Safari freezes the page.

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // Page is being hidden (app switch, home button, tab switch, screen off).
        // This is the iOS "last reliable moment" — flush immediately.
        flushNow();
      } else {
        // Page became visible again. Pull latest from Supabase so any changes
        // from other devices (or a push we made on this device) are reflected.
        pullFromSupabase();
      }
    });

    // pagehide: last-chance flush before bfcache freeze or navigation.
    window.addEventListener('pagehide', function () {
      flushNow();
    });

    // beforeunload: desktop browsers only (iOS ignores this).
    window.addEventListener('beforeunload', function () {
      flushNow();
    });

    // pageshow with persisted=true means the page was restored from bfcache.
    // The old Supabase WebSocket is dead; re-initialise the client and pull.
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) {
        initSupabase();
        pullFromSupabase();
      }
    });

    // Cross-tab sync: another tab on this device wrote to localStorage.
    window.addEventListener('storage', function (e) {
      if (e.key && matches(e.key)) schedulePush();
    });

    // Heartbeat: every 30 s, push any local state that never made it to Supabase.
    // Insurance against missed timer fires, silent fetch failures, or network hiccups.
    heartbeat = setInterval(function () {
      const json = JSON.stringify(collect());
      if (json !== lastSyncedJson) doPush(collect());
    }, 30000);
  };
})();
