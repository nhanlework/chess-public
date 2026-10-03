// CharacterFactory: creates a CharacterBase for a given (type, color, id).
// Phase 7 (WP-09, plan §12.3): init() loads assets/models/models.json (or a
// caller-supplied manifest, see below) and one AssetContainer per referenced
// GLB file; create() returns a GlbCharacter when a model is configured for
// that type/color, otherwise the Phase 4 ProceduralCharacter.
(function () {
  // Deviation (documented in docs/agents/handoff/WP-09.md): init() accepts an optional
  // 4th argument, the manifest URL, defaulting to 'assets/models/models.json'. This is
  // purely additive — every existing 2-arg call site (game3d.js) is unaffected — and lets
  // tests/browser/glb-sandbox.html point at a temporary manifest without touching the
  // real one or changing the plan's public init(scene, ctx, onProgress) signature shape.
  const DEFAULT_MANIFEST_URL = 'assets/models/models.json';
  const TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
  const TEAMS = ['w', 'b'];

  async function loadContainer(scene, url) {
    if (typeof BABYLON.LoadAssetContainerAsync === 'function') {
      return BABYLON.LoadAssetContainerAsync(url, scene);
    }
    return BABYLON.SceneLoader.LoadAssetContainerAsync('', url, scene);
  }

  // No shared toast widget exists yet (this wave doesn't include the HUD's UI3D module) —
  // fall back to a tiny inline one so "broken model -> visible warning" holds regardless.
  // Always console.warn first, since that's what automated/headless verification checks.
  function warn(msg) {
    console.warn('[Chess3D] ' + msg);
    if (window.Chess3D.UI3D && typeof window.Chess3D.UI3D.toast === 'function') {
      window.Chess3D.UI3D.toast(msg);
      return;
    }
    if (typeof document === 'undefined') return;
    try {
      const el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
        'background:#2b2b3a;color:#fff;padding:8px 14px;border-radius:6px;' +
        'font:13px sans-serif;z-index:9999;opacity:0.95;';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    } catch (e) { /* headless / no DOM: console.warn above already recorded it */ }
  }

  const CharacterFactory = {
    async init(scene, ctx, onProgress, manifestUrl) {
      this.scene = scene;
      this.ctx = ctx;
      this.entries = {};      // type -> manifest entry
      this.containers = {};   // type -> { w: AssetContainer|undefined, b: AssetContainer|undefined }
      this._containerCache = {}; // file path -> Promise<AssetContainer>, so each file loads once

      let manifest = null;
      try {
        const res = await fetch(manifestUrl || DEFAULT_MANIFEST_URL);
        if (res.ok) manifest = await res.json();
        else warn('Could not read ' + (manifestUrl || DEFAULT_MANIFEST_URL) + ' (HTTP ' + res.status + '); using built-in characters.');
      } catch (e) {
        warn('Could not read ' + (manifestUrl || DEFAULT_MANIFEST_URL) + '; using built-in characters.');
      }

      const activeTypes = manifest ? TYPES.filter((t) => manifest[t] && typeof manifest[t] === 'object') : [];
      let done = 0;
      for (const type of activeTypes) {
        const entry = manifest[type];
        this.entries[type] = entry;
        this.containers[type] = {};
        for (const team of TEAMS) {
          const file = (entry.perTeam && entry.perTeam[team] && entry.perTeam[team].file) || entry.file;
          if (!file) continue;
          const url = 'assets/models/' + file;
          try {
            if (!this._containerCache[url]) this._containerCache[url] = loadContainer(scene, url);
            this.containers[type][team] = await this._containerCache[url];
          } catch (e) {
            warn('Model "' + file + '" (' + type + '/' + team + ') failed to load, using built-in character instead.');
          }
        }
        done++;
        if (typeof onProgress === 'function') onProgress(done / activeTypes.length);
      }
      if (typeof onProgress === 'function' && !activeTypes.length) onProgress(1);
    },

    async create(type, color, id) {
      const container = this.containers[type] && this.containers[type][color];
      const entry = this.entries[type];
      const char = container
        ? new window.Chess3D.GlbCharacter({ scene: this.scene, type, color, id, ctx: this.ctx, container, entry })
        : new ({ p: window.Chess3D.PawnCharacter, n: window.Chess3D.KnightCharacter, q: window.Chess3D.QueenCharacter, k: window.Chess3D.KingCharacter }[type] || window.Chess3D.ProceduralCharacter)({ scene: this.scene, type, color, id, ctx: this.ctx });
      await char.build();
      char.applyRenderBudget((this.ctx && this.ctx.quality) || {});
      return char;
    }
  };

  window.Chess3D.CharacterFactory = CharacterFactory;
})();
