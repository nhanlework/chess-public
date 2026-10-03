// Chess3D.Effects — shared particle / VFX helpers (Plan §11.1).
// Every one-shot effect self-disposes (targetStopDuration + disposeOnStop, or an explicit
// Tween-driven cleanup) so callers never need to track handles for cleanup.
(function () {
  const Config = window.Chess3D.Config;
  const Tween = window.Chess3D.Tween;

  let _scene = null;
  let _glow = null;
  let _particleTex = null;
  let _quality = { particles: 1 };
  let _qualityKey = null;

  // --- shared particle texture (radial gradient dot), built from code (Plan §11.1) --------
  function makeParticleTexture(scene) {
    const tex = new BABYLON.DynamicTexture('particleTex', 64, scene, false);
    const ctx = tex.getContext();
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    tex.update();
    tex.hasAlpha = true;
    return tex;
  }

  function hexToColor4(hex, alpha) {
    const c3 = BABYLON.Color3.FromHexString(hex);
    return c3.toColor4(alpha == null ? 1 : alpha);
  }

  function toVector3(pos) {
    if (pos instanceof BABYLON.Vector3) return pos;
    return new BABYLON.Vector3(pos.x, pos.y, pos.z);
  }

  // speed can be a plain number (interpreted as a 0.6x..1x range) or an explicit {min,max}.
  function speedRange(speed, defMin, defMax) {
    if (speed == null) return { min: defMin, max: defMax };
    if (typeof speed === 'number') return { min: speed * 0.6, max: speed };
    return { min: speed.min, max: speed.max };
  }

  function particleCount(count) {
    const factor = (_quality && typeof _quality.particles === 'number') ? _quality.particles : 1;
    return Math.max(1, Math.round(count * factor));
  }

  function isLowQuality() {
    return _qualityKey === 'low';
  }

  // Babylon's ParticleSystem.dispose() defaults to ALSO disposing its assigned particleTexture
  // (disposeTexture=true). Every effect here shares one `_particleTex`, so relying on the built-in
  // disposeOnStop auto-dispose (which calls dispose() with no args) would tear down the shared
  // texture the moment the first one-shot system finishes, freezing every other particle system
  // that still references it (their isReady() permanently returns false). To keep the texture
  // shared safely, one-shot systems below leave disposeOnStop off and are disposed here instead,
  // explicitly passing disposeTexture=false, once their particles have had time to fully die out.
  function scheduleDispose(ps, life) {
    Tween.wait((life + 0.2) * 1000).then(() => {
      ps.dispose(false);
    });
  }

  // --- pooled FX lights ---------------------------------------------------------------------
  // Adding (or disposing) a light changes how many lights every lit material is
  // compiled for, so each flash light an effect created used to force a shader
  // rebuild of all ~500 character materials: the hitch on the first queen
  // attack (aura, orb, comets and volcanoes each added one). The pool's lights
  // exist from boot, before the characters compile, and stay enabled at
  // intensity 0 between uses, so borrowing one only changes uniforms.
  // Lights beyond the pool fall back to real ones (the old, hitchy path).
  const _lightPool = [];
  function initLightPool(opts) {
    opts = opts || {};
    const size = opts.size != null ? opts.size : (isLowQuality() ? 2 : 4);
    for (let i = _lightPool.length; i < size; i++) {
      const l = new BABYLON.PointLight('fxLight' + i, new BABYLON.Vector3(0, -50, 0), _scene);
      l.intensity = 0;
      if (opts.exclude) l.excludedMeshes = opts.exclude.slice();
      _lightPool.push(l);
    }
  }

  // A PointLight for an effect, at intensity 0; give it back with releaseLight().
  function fxLight(name, pos) {
    const p = pos ? toVector3(pos) : BABYLON.Vector3.Zero();
    const l = _lightPool.find((x) => !x.__fxInUse);
    if (!l) return new BABYLON.PointLight(name, p.clone(), _scene);
    l.__fxInUse = true;
    l.parent = null;
    l.position.copyFrom(p);
    l.diffuse = BABYLON.Color3.White();
    l.specular = BABYLON.Color3.White();
    l.intensity = 0;
    l.range = Number.MAX_VALUE;
    return l;
  }

  function releaseLight(l) {
    if (!l) return;
    if (_lightPool.indexOf(l) === -1) { l.dispose(); return; }
    l.__fxInUse = false;
    l.intensity = 0;
    l.parent = null;
    l.position.set(0, -50, 0);
  }

  function init(scene, ctx) {
    _scene = scene;
    ctx = ctx || {};
    _glow = ctx.glow || null;
    setQuality(ctx.quality, ctx.qualityKey);
    _particleTex = makeParticleTexture(scene);
  }

  // quality: the resolved Config.QUALITY[...] object (has .particles). qualityKey ('low'/'medium'/'high')
  // is optional and only used to gate quality-specific behavior (e.g. torch has no PointLight at 'low').
  function setQuality(quality, qualityKey) {
    _quality = quality || { particles: 1 };
    if (qualityKey) {
      _qualityKey = qualityKey;
    } else if (typeof _quality.particles === 'number') {
      _qualityKey = _quality.particles <= 0.4 ? 'low' : (_quality.particles >= 1 ? 'high' : 'medium');
    }
  }

  // Generic burst helper shared by most one-shot effects (Plan §11.1).
  function burst(opts) {
    opts = opts || {};
    const pos = toVector3(opts.pos);
    const color1 = opts.color1 || '#ffffff';
    const color2 = opts.color2 || color1;
    const count = particleCount(opts.count || 20);
    const life = opts.life != null ? opts.life : 0.5;
    const size = opts.size != null ? opts.size : 0.1;
    const gravity = opts.gravity || [0, 0, 0];
    const blend = opts.blend || 'ADD';
    const range = speedRange(opts.speed, 1, 3);

    const ps = new BABYLON.ParticleSystem('burst', count, _scene);
    ps.particleTexture = _particleTex;
    ps.emitter = pos;
    ps.createSphereEmitter(0.1);
    ps.color1 = hexToColor4(color1, 1);
    ps.color2 = hexToColor4(color2, 1);
    ps.colorDead = hexToColor4(color2, 0);
    ps.minSize = size * 0.5;
    ps.maxSize = size;
    ps.minLifeTime = life * 0.7;
    ps.maxLifeTime = life;
    ps.minEmitPower = range.min;
    ps.maxEmitPower = range.max;
    ps.gravity = Array.isArray(gravity) ? new BABYLON.Vector3(gravity[0], gravity[1], gravity[2]) : gravity;
    ps.blendMode = (blend === 'STANDARD') ? BABYLON.ParticleSystem.BLENDMODE_STANDARD : BABYLON.ParticleSystem.BLENDMODE_ADD;
    ps.manualEmitCount = count;
    ps.targetStopDuration = life;
    ps.start();
    scheduleDispose(ps, life);
    return ps;
  }

  function dustPuff(pos) {
    return burst({
      pos, color1: '#8a7b6a', color2: '#8a7b6a', count: 18,
      speed: { min: 0.5, max: 1.4 }, life: 0.5, size: 0.12,
      gravity: [0, -0.8, 0], blend: 'STANDARD'
    });
  }

  function sparks(pos, color) {
    return burst({
      pos, color1: color || '#ffffff', color2: '#ffffff', count: 55,
      speed: { min: 3.5, max: 8 }, life: 0.5, size: 0.11,
      gravity: [0, -6, 0], blend: 'ADD'
    });
  }

  function explosion(pos, color) {
    burst({
      pos, color1: color || '#ff7a1a', color2: '#ffffff', count: 80,
      speed: { min: 2, max: 4 }, life: 0.6, size: 0.18,
      gravity: [0, -1, 0], blend: 'ADD'
    });
    shockwave(pos, color);
  }

  function shockwave(pos, color) {
    const p = toVector3(pos);
    const mat = new BABYLON.StandardMaterial('shockwaveMat', _scene);
    mat.disableLighting = true;
    mat.emissiveColor = BABYLON.Color3.FromHexString(color || '#ff7a1a');
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.backFaceCulling = false;
    mat.alpha = 1;

    const torus = BABYLON.MeshBuilder.CreateTorus('shockwave', { diameter: 0.3, thickness: 0.04, tessellation: 32 }, _scene);
    torus.rotation.x = Math.PI / 2;
    torus.position.set(p.x, Config.BOARD_Y + 0.03, p.z);
    torus.material = mat;
    torus.isPickable = false;

    return Tween.run(450, (t) => {
      const s = 1 + t * 7;
      torus.scaling.set(s, s, s);
      mat.alpha = 1 - t;
    }, Tween.Ease.outCubic).then(() => {
      torus.dispose();
      mat.dispose();
    });
  }

  function dissolve(pos, color, height) {
    const p = toVector3(pos);
    height = height != null ? height : 1;
    const life = 0.9;
    const count = particleCount(60);
    const ps = new BABYLON.ParticleSystem('dissolve', count, _scene);
    ps.particleTexture = _particleTex;
    ps.emitter = p;
    ps.createBoxEmitter(
      new BABYLON.Vector3(0, 1, 0), new BABYLON.Vector3(0, 1, 0),
      new BABYLON.Vector3(-0.3, 0, -0.3), new BABYLON.Vector3(0.3, height, 0.3)
    );
    const c = color || '#ffd54a';
    ps.color1 = hexToColor4(c, 1);
    ps.color2 = hexToColor4(c, 1);
    ps.colorDead = hexToColor4(c, 0);
    ps.minSize = 0.05;
    ps.maxSize = 0.12;
    ps.minLifeTime = 0.6;
    ps.maxLifeTime = life;
    ps.minEmitPower = 0.3;
    ps.maxEmitPower = 0.9;
    ps.gravity = new BABYLON.Vector3(0, 1.5, 0);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    ps.manualEmitCount = count;
    ps.targetStopDuration = life;
    ps.start();
    scheduleDispose(ps, life);
    return ps;
  }

  function projectile(from, to, kind, team) {
    const a = toVector3(from);
    const b = toVector3(to);
    const color = (kind === 'fire') ? '#ff7a1a' : ((team && team.glow) || '#7cc9ff');

    const mat = new BABYLON.StandardMaterial('projectileMat', _scene);
    mat.disableLighting = true;
    mat.emissiveColor = BABYLON.Color3.FromHexString(color);
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();

    const sphere = BABYLON.MeshBuilder.CreateSphere('projectile', { diameter: 0.14 }, _scene);
    sphere.material = mat;
    sphere.isPickable = false;
    sphere.position.copyFrom(a);

    const trail = new BABYLON.ParticleSystem('projectileTrail', 60, _scene);
    trail.particleTexture = _particleTex;
    trail.emitter = sphere;
    trail.createSphereEmitter(0.05);
    trail.color1 = hexToColor4(color, 1);
    trail.color2 = hexToColor4(color, 1);
    trail.colorDead = hexToColor4(color, 0);
    trail.minSize = 0.05;
    trail.maxSize = 0.12;
    trail.minLifeTime = 0.15;
    trail.maxLifeTime = 0.3;
    trail.minEmitPower = 0.05;
    trail.maxEmitPower = 0.15;
    trail.emitRate = particleCount(40);
    trail.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    trail.start();

    const dur = Config.TIMING.projectile;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    return Tween.run(dur, (t) => {
      sphere.position.set(a.x + dx * t, a.y + dy * t + Math.sin(Math.PI * t) * 0.4, a.z + dz * t);
    }, Tween.Ease.linear).then(() => {
      trail.stop();
      explosion(b, color);
      // Disposing a mesh also disposes (texture included) every particle system
      // it emits: detach the trail first so the shared _particleTex survives.
      trail.emitter = sphere.position.clone();
      sphere.dispose();
      mat.dispose();
      scheduleDispose(trail, 0.3); // let in-flight trail particles (maxLifeTime 0.3s) die out first
    });
  }

  function lightning(from, to, color) {
    const a = toVector3(from);
    const b = toVector3(to);
    color = color || '#7ecbff';

    const mat = new BABYLON.StandardMaterial('lightningMat', _scene);
    mat.disableLighting = true;
    mat.emissiveColor = BABYLON.Color3.FromHexString(color);
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.backFaceCulling = false;

    function buildZigzagPath() {
      const steps = 10;
      const path = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = BABYLON.Vector3.Lerp(a, b, t);
        if (i > 0 && i < steps) {
          p.x += (Math.random() - 0.5) * 0.24;
          p.y += (Math.random() - 0.5) * 0.24;
          p.z += (Math.random() - 0.5) * 0.24;
        }
        path.push(p);
      }
      return path;
    }

    let tube = BABYLON.MeshBuilder.CreateTube('lightning', { path: buildZigzagPath(), radius: 0.02, tessellation: 8 }, _scene);
    tube.material = mat;
    tube.isPickable = false;

    const light = fxLight('lightningLight', b);
    light.diffuse = BABYLON.Color3.FromHexString(color);
    light.intensity = 2;
    light.range = 6;

    return new Promise((resolve) => {
      let flashes = 0;
      let resolved = false;
      function flash() {
        flashes++;
        tube.dispose();
        tube = BABYLON.MeshBuilder.CreateTube('lightning', { path: buildZigzagPath(), radius: 0.02, tessellation: 8 }, _scene);
        tube.material = mat;
        tube.isPickable = false;
        if (!resolved) { resolved = true; resolve(); }
        if (flashes < 3) {
          Tween.wait(250 / 3).then(flash);
        } else {
          Tween.wait(250 / 3).then(() => {
            tube.dispose();
            mat.dispose();
            releaseLight(light);
          });
        }
      }
      flash();
    });
  }

  // --- tornado (the bishop's attack) --------------------------------------------------------
  // A storm: a rotating wall cloud sits HC above the board, a dark rope funnel hangs from it down to
  // the ground and leans with the cloud, and white forked bolts strike the ground on either side.
  // All motion runs off one internal clock (dt * Tween.speed) so Tween.speed = 0 freezes everything,
  // bolt flicker included. Tween.run/wait only drive the big phases (gather / form / travel / fade).
  const TORNADO_HC = 2.6;                         // cloud base height above BOARD_Y
  const TORNADO_REST_LEAN = [-0.4, 0.3];          // world-space xz lean while standing still
  const FUNNEL_S = [0, 0.10, 0.25, 0.40, 0.55, 0.70, 0.80, 0.88, 0.94, 1];
  const FUNNEL_R = [0.055, 0.09, 0.13, 0.17, 0.22, 0.29, 0.38, 0.52, 0.72, 1.0];   // ~2x the first-spec table: the body read too thin in play
  const STORM_FOG_HEX = '#14142a';

  function tornadoTier() {
    switch (_qualityKey) {
      case 'low': return { low: true, rings: 40, radial: 24, octaves: 2, boltDepth: 5, maxBranches: 8, halo: false, light: false, pair: 0 };
      case 'medium': return { rings: 80, radial: 48, octaves: 3, boltDepth: 6, maxBranches: 16, halo: true, light: true, pair: 0.2 };
      case 'ultra': return { rings: 80, radial: 48, octaves: 3, boltDepth: 7, maxBranches: 28, halo: true, light: true, pair: 0.35 };
      default: return { rings: 80, radial: 48, octaves: 3, boltDepth: 7, maxBranches: 28, halo: true, light: true, pair: 0.2 };
    }
  }

  // Monotone cubic (Fritsch-Butland) through the funnel radius table, so r(s) never overshoots.
  const FUNNEL_M = (() => {
    const n = FUNNEL_S.length, d = [], m = [];
    for (let k = 0; k < n - 1; k++) d[k] = (FUNNEL_R[k + 1] - FUNNEL_R[k]) / (FUNNEL_S[k + 1] - FUNNEL_S[k]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : 2 * d[k - 1] * d[k] / (d[k - 1] + d[k]);
    return m;
  })();
  function funnelRadius(s) {
    s = Math.min(1, Math.max(0, s));
    let k = 0;
    while (k < FUNNEL_S.length - 2 && s > FUNNEL_S[k + 1]) k++;
    const h = FUNNEL_S[k + 1] - FUNNEL_S[k], t = (s - FUNNEL_S[k]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * FUNNEL_R[k] + (t3 - 2 * t2 + t) * h * FUNNEL_M[k]
      + (-2 * t3 + 3 * t2) * FUNNEL_R[k + 1] + (t3 - t2) * h * FUNNEL_M[k + 1];
  }

  // --- storm atmosphere: ref-counted so overlapping tornadoes never save an already-darkened "original"
  const _storm = { users: new Set(), env: 1, fog: null };
  function stormApply() {
    if (!_storm.users.size) {
      if (_storm.fog) { _scene.environmentIntensity = _storm.env; _scene.fogColor.copyFrom(_storm.fog); _storm.fog = null; }
      return;
    }
    let dark = 0, flash = 0;
    _storm.users.forEach((u) => { dark = Math.max(dark, u.dark); flash += u.envFlash; });
    _scene.environmentIntensity = _storm.env * (1 - 0.4 * dark) + flash;
    BABYLON.Color3.LerpToRef(_storm.fog, BABYLON.Color3.FromHexString(STORM_FOG_HEX), dark, _scene.fogColor);
  }
  function stormJoin(u) {
    if (!_storm.users.size) { _storm.env = _scene.environmentIntensity; _storm.fog = _scene.fogColor.clone(); }
    _storm.users.add(u);
  }
  function stormLeave(u) { _storm.users.delete(u); stormApply(); }

  // --- shaders --------------------------------------------------------------------------------
  const GLSL_NOISE = `
    uniform float uOctaves;
    float hash31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
    float vnoise(vec3 x) {
      vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
                     mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                 mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
                     mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }
    float fbm3(vec3 p) {
      float a = 0.5; float s = 0.0; float n = 0.0;
      for (int i = 0; i < 3; i++) {
        if (float(i) >= uOctaves) break;
        s += a * vnoise(p); n += a; p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5;
      }
      return s / n;
    }`;

  const FUNNEL_VS = `precision highp float;
    attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
    uniform mat4 world; uniform mat4 viewProjection;
    uniform float uTime; uniform vec2 uLean; uniform float uWobbleAmp; uniform float uThin;
    varying vec3 vWorld; varying vec3 vN; varying vec2 vUV;
    ${GLSL_NOISE}
    vec2 spine(float s) {
      float k = 1.0 - (1.0 - s) * (1.0 - s);
      vec2 w = (1.0 - s) * uWobbleAmp * vec2(0.07 * sin(2.1 * uTime + 5.0 * s), 0.05 * cos(1.7 * uTime + 4.0 * s));
      return uLean * k + w;
    }
    void main() {
      float s = uv.y; float th = uv.x * 6.2831853;
      vec3 p = position;
      float r = length(position.xz);
      p.xz *= mix(1.0, 0.45, uThin * (1.0 - smoothstep(0.85, 0.95, s)));
      float n = fbm3(vec3(cos(th), sin(th), s * 6.0) * 1.8 + vec3(0.0, -uTime * 0.8, uTime * 0.3));
      p += normalize(normal) * (0.5 * r * (n - 0.5));
      p.xz += spine(s);
      vec4 wp = world * vec4(p, 1.0);
      vWorld = wp.xyz;
      vN = normalize((world * vec4(normal, 0.0)).xyz);
      vUV = uv;
      gl_Position = viewProjection * wp;
    }`;

  const FUNNEL_FS = `precision highp float;
    varying vec3 vWorld; varying vec3 vN; varying vec2 vUV;
    uniform vec3 cameraPosition;
    uniform float uTime; uniform float uRevealLow; uniform float uRevealHigh; uniform float uFlash; uniform float uFogDensity;
    uniform vec3 uFlashPos; uniform vec3 uRimColor; uniform vec3 uFogColor;
    ${GLSL_NOISE}
    void main() {
      float s = vUV.y; float th = vUV.x * 6.2831853;
      vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vWorld);
      float ndv = abs(dot(N, V));
      float ang = th - uTime * 4.0 + s * 3.0;
      float n = fbm3(vec3(cos(ang), sin(ang), s * 10.0 - uTime * 0.8) * 1.4);
      float ang2 = th - uTime * 2.2 + s * 5.0;
      float n2 = fbm3(vec3(cos(ang2), sin(ang2), s * 5.0 - uTime * 0.5) * 0.9 + vec3(3.7, 1.3, 8.1));
      vec3 base = mix(vec3(0.141, 0.145, 0.184), vec3(0.239, 0.239, 0.298), smoothstep(0.5, 1.0, s)) * (0.6 + 0.9 * n);
      base = mix(base, vec3(0.34, 0.34, 0.43), smoothstep(0.38, 0.75, n2) * 0.6);
      float fall = clamp(1.0 - distance(vWorld, uFlashPos) / 3.0, 0.0, 1.0);
      float rim = pow(1.0 - ndv, 2.5);
      vec3 col = base + rim * uRimColor * (0.28 + 1.6 * uFlash * fall);
      col += vec3(0.42, 0.39, 0.70) * uFlash * fall * 0.25 * max(dot(N, normalize(uFlashPos - vWorld)), 0.0);
      float a = 0.95 * smoothstep(0.05, 0.4, ndv);
      a *= smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.93, 1.0, s));
      a *= smoothstep(0.0, 0.25, ndv + 0.25 * (n - 0.5));
      a *= mix(0.72, 1.0, n2);
      a *= smoothstep(uRevealLow, uRevealLow + 0.04, s) * (1.0 - smoothstep(uRevealHigh - 0.04, uRevealHigh + 0.0001, s));
      if (a < 0.004) discard;
      float dist = distance(cameraPosition, vWorld);
      col = pow(max(col, 0.0), vec3(2.2));
      col = mix(uFogColor, col, exp(-pow(dist * uFogDensity, 2.0)));
      gl_FragColor = vec4(col, a);
    }`;

  const CLOUD_VS = `precision highp float;
    attribute vec3 position; attribute vec3 normal;
    uniform mat4 world; uniform mat4 viewProjection; uniform float uTime;
    varying vec3 vWorld; varying vec3 vLocal; varying vec3 vN;
    ${GLSL_NOISE}
    void main() {
      vec3 q = position + vec3(uTime * 0.15, 0.0, uTime * 0.1);
      vec3 p = position + normalize(normal) * (0.75 * (fbm3(q * 1.1) - 0.5) + 0.3 * (fbm3(q * 3.1 + 7.0) - 0.5));
      vec4 wp = world * vec4(p, 1.0);
      vWorld = wp.xyz; vLocal = position; vN = normalize((world * vec4(normal, 0.0)).xyz);
      gl_Position = viewProjection * wp;
    }`;

  const CLOUD_FS = `precision highp float;
    varying vec3 vWorld; varying vec3 vLocal; varying vec3 vN;
    uniform vec3 cameraPosition;
    uniform float uTime; uniform float uFlash; uniform float uAlpha; uniform float uRadius; uniform float uFogDensity;
    uniform vec3 uFlashPos; uniform vec3 uFogColor;
    ${GLSL_NOISE}
    void main() {
      float rad = clamp(length(vLocal.xz) / uRadius, 0.0, 1.0);
      float n = fbm3(vLocal * 1.6 + vec3(0.0, uTime * 0.12, uTime * 0.08));
      float n3 = fbm3(vLocal * 3.4 + vec3(0.0, uTime * 0.2, uTime * 0.1) + 4.0);
      vec3 col = mix(vec3(0.102, 0.106, 0.165), vec3(0.243, 0.239, 0.353), pow(rad, 1.5)) * (0.3 + 1.5 * n) * (0.7 + 0.6 * n3);
      float d = distance(vWorld, uFlashPos);
      float lit = 0.85 * uFlash * exp(-pow(d / 1.0, 2.0));
      col += vec3(0.725, 0.698, 1.0) * lit;
      float toCam = length(cameraPosition - vWorld);
      float beta = acos(clamp((cameraPosition.y - vWorld.y) / toCam, -1.0, 1.0));
      float edge = 1.0 - smoothstep(0.7, 1.0, rad);
      float ndv = abs(dot(normalize(vN), (cameraPosition - vWorld) / toCam));
      float a = 0.92 * uAlpha * edge * (0.65 + 0.35 * n3) * (0.35 + 0.65 * smoothstep(0.0, 0.45, ndv));
      a *= mix(0.3, 1.0, smoothstep(0.7, 1.25, beta));
      a = max(a, min(1.0, lit) * uAlpha * edge);
      if (a < 0.004) discard;
      col = pow(max(col, 0.0), vec3(2.2));
      col = mix(uFogColor, col, exp(-pow(toCam * uFogDensity, 2.0)));
      gl_FragColor = vec4(col, a);
    }`;

  // Camera-facing ribbon: the centre-line is the vertex position, `normal` carries the tangent,
  // uv = (side 0/1, full width in world units). Wider than a hairline minimum so far-away
  // branches stay visible instead of vanishing below a pixel (they get dimmer instead).
  const BOLT_VS = `precision highp float;
    attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
    uniform mat4 viewProjection; uniform vec3 cameraPosition; uniform float uMinW;
    varying float vSide; varying float vFade;
    void main() {
      vec3 V = cameraPosition - position;
      float dist = length(V);
      vec3 side = cross(normalize(normal), V / dist);
      float sl = length(side);
      side = sl > 0.0001 ? side / sl : vec3(1.0, 0.0, 0.0);
      float minW = uMinW * dist;
      float w = max(uv.y, minW);
      vSide = uv.x * 2.0 - 1.0;
      vFade = min(1.0, uv.y / minW + 0.25);
      gl_Position = viewProjection * vec4(position + side * vSide * w * 0.5, 1.0);
    }`;

  const BOLT_FS = `precision highp float;
    varying float vSide; varying float vFade;
    uniform vec3 uColor; uniform float uI; uniform float uGain; uniform float uCore; uniform float uBright;
    void main() {
      float d = abs(vSide);
      float prof = mix(exp(-d * d * 3.0), 1.0 - smoothstep(0.2, 1.0, d), uCore);
      float a = clamp(prof * uI * vFade * uGain, 0.0, 1.0);
      gl_FragColor = vec4(uColor * uBright, a);
    }`;

  let _shadersRegistered = false;
  function registerTornadoShaders() {
    if (_shadersRegistered) return;
    const S = BABYLON.Effect.ShadersStore;
    S.bishopFunnelVertexShader = FUNNEL_VS; S.bishopFunnelFragmentShader = FUNNEL_FS;
    S.bishopCloudVertexShader = CLOUD_VS; S.bishopCloudFragmentShader = CLOUD_FS;
    S.bishopBoltVertexShader = BOLT_VS; S.bishopBoltFragmentShader = BOLT_FS;
    _shadersRegistered = true;
  }

  const NOISE_UNIFORMS = ['uOctaves'];
  function shaderMat(name, shader, attributes, uniforms) {
    const mat = new BABYLON.ShaderMaterial(name, _scene, { vertex: shader, fragment: shader }, {
      attributes, uniforms: ['world', 'viewProjection', 'cameraPosition'].concat(NOISE_UNIFORMS, uniforms), needAlphaBlending: true
    });
    mat.isPickable = false;
    return mat;
  }

  // --- storm cloud: a flat lens (dark centre, lighter rim, bumpy underside) plus a bowl-shaped
  // wall cloud hanging under it, where the funnel attaches. Local y = 0 is the cloud base.
  function buildStormCloud(tier, parent) {
    const V3 = BABYLON.Vector3;
    const profile = (pts) => pts.map((p) => new V3(p[0], p[1], 0));
    const mk = (name, pts, radius, alphaIndex) => {
      const mesh = BABYLON.MeshBuilder.CreateLathe(name, { shape: profile(pts), tessellation: tier.low ? 40 : 96, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, _scene);
      const mat = shaderMat(name + 'Mat', 'bishopCloud', ['position', 'normal'], ['uTime', 'uFlash', 'uAlpha', 'uRadius', 'uFogDensity', 'uFlashPos', 'uFogColor']);
      mat.backFaceCulling = false;
      mat.setFloat('uRadius', radius);
      mesh.material = mat; mesh.parent = parent; mesh.isPickable = false;
      mesh.alphaIndex = alphaIndex; mesh.alwaysSelectAsActiveMesh = true;
      return { mesh, mat };
    };
    const disc = mk('tornadoCloud', [[0, -0.14], [0.6, -0.11], [1.2, -0.05], [1.6, 0.01], [1.9, 0.07], [2.0, 0.11], [1.85, 0.2], [1.3, 0.29], [0.7, 0.33], [0, 0.33]], 2.0, 11);
    const bowl = mk('tornadoWallCloud', [[0, -0.4], [0.35, -0.38], [0.6, -0.31], [0.85, -0.18], [1.05, -0.06], [1.2, 0.0], [1.2, 0.06], [0, 0.06]], 1.2, 9);   // under the funnel (10) so its flare reads on top of the bowl
    return { disc, bowl };
  }

  // --- funnel: one straight tube built once (radius baked from the table); everything that moves
  // (spine, lean, wobble, rope-out, roughness) happens in the vertex shader.
  function buildFunnel(tier, parent) {
    const rings = tier.rings, radial = tier.radial;
    const pos = [], nor = [], uvs = [], idx = [];
    for (let j = 0; j <= rings; j++) {
      const s = j / rings, r = funnelRadius(s);
      const dr = (funnelRadius(Math.min(1, s + 0.01)) - funnelRadius(Math.max(0, s - 0.01))) / (0.02 * TORNADO_HC);
      const nl = 1 / Math.sqrt(1 + dr * dr);
      for (let i = 0; i <= radial; i++) {
        const th = (i / radial) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
        pos.push(r * c, s * TORNADO_HC, r * sn);
        nor.push(c * nl, -dr * nl, sn * nl);
        uvs.push(i / radial, s);
      }
    }
    const row = radial + 1;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < radial; i++) {
        const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const mesh = new BABYLON.Mesh('tornadoFunnel', _scene);
    const vd = new BABYLON.VertexData();
    vd.positions = pos; vd.normals = nor; vd.uvs = uvs; vd.indices = idx;
    vd.applyToMesh(mesh);
    const mat = shaderMat('tornadoFunnelMat', 'bishopFunnel', ['position', 'normal', 'uv'],
      ['uTime', 'uLean', 'uWobbleAmp', 'uThin', 'uRevealLow', 'uRevealHigh', 'uFlash', 'uFlashPos', 'uRimColor', 'uFogColor', 'uFogDensity']);
    mat.backFaceCulling = true;
    mesh.material = mat; mesh.parent = parent; mesh.isPickable = false;
    mesh.alphaIndex = 10; mesh.alwaysSelectAsActiveMesh = true;
    return { mesh, mat };
  }

  // --- lightning ------------------------------------------------------------------------------
  const rnd = (a, b) => a + Math.random() * (b - a);

  // Midpoint displacement from a to b: the midpoint of every segment is pushed sideways by
  // len0 * ampBase * 0.55^level, mostly horizontally (|dy| <= 30% of the push).
  function displaceBolt(a, b, depth, ampBase) {
    const V3 = BABYLON.Vector3;
    const len0 = V3.Distance(a, b);
    let pts = [a.clone(), b.clone()];
    for (let k = 0; k < depth; k++) {
      const amp = len0 * ampBase * Math.pow(0.55, k);
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const u = q.subtract(p); const ul = u.length() || 1; u.scaleInPlace(1 / ul);
        const d = new V3(rnd(-1, 1), rnd(-0.3, 0.3), rnd(-1, 1));
        d.subtractInPlace(u.scale(V3.Dot(d, u)));
        const dl = d.length() || 1; d.scaleInPlace(1 / dl);
        d.y = Math.max(-0.3, Math.min(0.3, d.y));
        out.push(p.add(q).scaleInPlace(0.5).addInPlace(d.scaleInPlace(amp * rnd(0.5, 1))), q);
      }
      pts = out;
    }
    return pts;
  }

  // Bolt geometry: a main channel start -> end plus branches that grow mostly in the upper half
  // (inverted-root look), each branch able to fork again (3 levels, thinner each time). Pure CPU;
  // returns [{ pts, w, lvl }] polylines. Only the main channel reaches the ground.
  function generateBolt(start, end, o) {
    const V3 = BABYLON.Vector3, tier = o.tier;
    const groundCut = Config.BOARD_Y + 0.15;
    const mainLen = V3.Distance(start, end);
    const span = Math.max(0.01, start.y - end.y);
    const main = displaceBolt(start, end, tier.boltDepth, 0.16);
    const polys = [{ pts: main, w: main.map(() => o.width), lvl: 0 }];
    let count = 0;
    const branchWidth = [0, 0.015, 0.008, 0.004];
    const grow = (parent, i, lvl, lenMin, lenMax) => {
      const P = parent.pts, p = P[i];
      const t = P[i + 1].subtract(P[i - 1]); t.normalize();
      const rv = new V3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1));
      rv.subtractInPlace(t.scale(V3.Dot(rv, t))); rv.normalize();
      const ang = rnd(35, 70) * Math.PI / 180;
      const dir = t.scale(Math.cos(ang)).addInPlace(rv.scale(Math.sin(ang)));
      if (dir.y > -0.05) { dir.subtractInPlace(rv.scale(2 * Math.sin(ang))); }
      if (dir.y > -0.05) dir.y = -0.05 - Math.abs(dir.y);
      dir.normalize();
      const len = lenMin + Math.random() * (lenMax - lenMin);
      const raw = displaceBolt(p, p.add(dir.scale(len)), Math.max(2, tier.boltDepth - 2 - (lvl - 1)), 0.16);
      const pts = [];
      for (let k = 0; k < raw.length; k++) { if (raw[k].y < groundCut) break; pts.push(raw[k]); }
      if (pts.length < 2) return null;
      const bw = branchWidth[lvl];
      const poly = { pts, w: pts.map((_, k) => bw * (1 - 0.85 * k / (pts.length - 1))), lvl };
      polys.push(poly); count++;
      return poly;
    };
    const lvl1Cap = Math.ceil(tier.maxBranches * 0.7);
    for (let i = 1; i < main.length - 1 && count < lvl1Cap; i++) {
      const h = Math.min(1, Math.max(0, (main[i].y - end.y) / span));
      if (Math.random() < 0.35 * Math.pow(h, 1.5)) grow(polys[0], i, 1, mainLen * 0.12, mainLen * 0.4);
    }
    for (let q = 1; q < polys.length; q++) {
      const par = polys[q];
      if (par.lvl >= 3) continue;
      for (let i = 2; i < par.pts.length - 1 && count < tier.maxBranches; i += 4) {
        if (Math.random() < 0.25) {
          const plen = V3.Distance(par.pts[0], par.pts[par.pts.length - 1]);
          grow(par, i, par.lvl + 1, plen * 0.2, plen * 0.5);
        }
      }
    }
    return polys;
  }

  // Glow envelope of one stroke, in ms: strike, dip, return stroke, exponential fade.
  function boltEnvelope(ms) {
    if (ms < 50) return 1;
    if (ms < 90) return 1 - 0.75 * (ms - 50) / 40;
    if (ms < 140) return 0.85;
    if (ms < 260) return 0.85 * Math.exp(-(ms - 140) / 35);
    return 0;
  }

  function buildBoltMesh(name, polys, widthMul, mat) {
    const pos = [], nor = [], uvs = [], idx = [];
    polys.forEach((poly) => {
      const P = poly.pts, n = P.length, base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
        let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        for (let side = 0; side < 2; side++) {
          pos.push(P[i].x, P[i].y, P[i].z); nor.push(tx, ty, tz); uvs.push(side, poly.w[i] * widthMul);
        }
      }
      for (let i = 0; i < n - 1; i++) { const a = base + 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const mesh = new BABYLON.Mesh(name, _scene);
    const vd = new BABYLON.VertexData();
    vd.positions = pos; vd.normals = nor; vd.uvs = uvs; vd.indices = idx;
    vd.applyToMesh(mesh, true);
    mesh.material = mat; mesh.isPickable = false;
    mesh.alphaIndex = 12; mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  }

  function boltMaterial(name, hex, core, gain, minW) {
    const mat = shaderMat(name, 'bishopBolt', ['position', 'normal', 'uv'], ['uMinW', 'uColor', 'uI', 'uGain', 'uCore', 'uBright']);
    mat.backFaceCulling = false;
    mat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    mat.setColor3('uColor', BABYLON.Color3.FromHexString(hex));
    mat.setFloat('uCore', core ? 1 : 0);
    mat.setFloat('uBright', core ? 3.2 : 1);   // HDR core: clears the bloom threshold
    mat.setFloat('uGain', gain);
    mat.setFloat('uMinW', minW);
    mat.setFloat('uI', 1);
    return mat;
  }

  // One stroke on screen: a white core mesh and (not at 'low') a wider lavender halo mesh, both
  // built from the same polylines, plus a short flare at the ground contact. Returns an object the
  // tornado's frame loop ages with update(ms); it disposes itself via dispose().
  function spawnBolt(polys, ctx, o) {
    const tier = ctx.tier;
    const bolt = { age: 0, major: !!o.major, meshes: [], mats: [], flare: null, jittered: false, env: 0, start: o.start, end: o.end, mid: o.mid };
    const coreMat = boltMaterial('tornadoBoltCore', '#ffffff', true, 1, 0.0016);
    bolt.mats.push(coreMat);
    bolt.meshes.push(buildBoltMesh('tornadoBolt', polys, 1, coreMat));
    if (tier.halo) {
      const haloMat = boltMaterial('tornadoBoltHalo', ctx.haloHex, false, 0.25, 0.0064);
      bolt.mats.push(haloMat);
      bolt.meshes.push(buildBoltMesh('tornadoBoltHalo', polys, 4, haloMat));
    }
    if (o.ground) {
      const flare = BABYLON.MeshBuilder.CreatePlane('tornadoFlare', { size: 1 }, _scene);
      flare.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      flare.position.copyFrom(o.end); flare.position.y += 0.03;
      flare.scaling.setAll(0.3);
      flare.material = ctx.flareMat; flare.isPickable = false; flare.alphaIndex = 12;
      bolt.flare = flare;
      burst({ pos: o.end, count: 12, color1: '#ffffff', color2: '#a99cff', speed: { min: 1, max: 3 }, life: 0.3, size: 0.05, gravity: [0, -3, 0] });
    }
    bolt.polys = polys;
    bolt.update = (ms) => {
      bolt.age = ms;
      bolt.env = boltEnvelope(ms);
      bolt.mats.forEach((m) => m.setFloat('uI', bolt.env));
      if (!bolt.jittered && ms >= 90) { // return stroke: the channel shivers slightly
        bolt.jittered = true;
        bolt.meshes.forEach((m) => {
          const p = m.getVerticesData(BABYLON.VertexBuffer.PositionKind);
          for (let i = 0; i < p.length; i += 6) { // vertex pairs share one point; jitter them together
            const jx = rnd(-0.01, 0.01), jy = rnd(-0.01, 0.01), jz = rnd(-0.01, 0.01);
            for (let k = 0; k < 2; k++) { p[i + k * 3] += jx; p[i + k * 3 + 1] += jy; p[i + k * 3 + 2] += jz; }
          }
          m.updateVerticesData(BABYLON.VertexBuffer.PositionKind, p);
        });
      }
      if (bolt.flare) {
        if (ms > 120) { bolt.flare.dispose(); bolt.flare = null; } else { bolt.flare.visibility = 1 - ms / 120; bolt.flare.scaling.setAll(0.3 * (1 + 0.5 * ms / 120)); }
      }
    };
    bolt.dispose = () => {
      bolt.meshes.forEach((m) => m.dispose());
      bolt.mats.forEach((m) => m.dispose());
      if (bolt.flare) bolt.flare.dispose();
      bolt.meshes.length = 0; bolt.mats.length = 0; bolt.flare = null;
    };
    bolt.update(0);
    return bolt;
  }

  // A storm that forms at `from`, sways across the board to `to` and engulfs whatever stands
  // there. Returns { formed, arrived, dissipate, debug }: `arrived` resolves on the first impact
  // bolt (the capture's impact moment); the funnel keeps churning over the victim until
  // dissipate() is called (or a safety timeout fires). debug = { strike(), impact(), hold(bool) }.
  function tornado(from, to, team) {
    const T = Config.TIMING;
    const V3 = BABYLON.Vector3, C3 = BABYLON.Color3;
    const tier = tornadoTier();
    registerTornadoShaders();
    const a = toVector3(from).clone(), b = toVector3(to).clone();
    a.y = b.y = Config.BOARD_Y;
    const glow = (team && team.glow) || '#7cc9ff';
    const sound = window.ChessSound;
    const dist = V3.Distance(a, b);
    const dirX = dist > 1e-4 ? (b.x - a.x) / dist : 0, dirZ = dist > 1e-4 ? (b.z - a.z) / dist : 0;

    const core = new BABYLON.Mesh('tornadoCore', _scene);   // ground contact; parent of the funnel
    core.position.copyFrom(a);
    const pivot = new BABYLON.Mesh('tornadoCloudPivot', _scene); // cloud centre, spins
    const puffNode = new BABYLON.Mesh('tornadoPuffNode', _scene);
    puffNode.parent = pivot; puffNode.position.y = -0.1;
    const debrisSpin = new BABYLON.Mesh('tornadoDebrisSpin', _scene);

    const funnel = buildFunnel(tier, core);
    const cloud = buildStormCloud(tier, pivot);
    const stormMeshes = [funnel.mesh, cloud.disc.mesh, cloud.bowl.mesh];
    if (_glow) stormMeshes.forEach((m) => _glow.addExcludedMesh(m));
    const flareMat = new BABYLON.StandardMaterial('tornadoFlareMat', _scene);
    flareMat.disableLighting = true;
    flareMat.diffuseColor = C3.Black(); flareMat.specularColor = C3.Black();
    flareMat.emissiveColor = C3.FromHexString('#e6e0ff');
    flareMat.opacityTexture = _particleTex;
    flareMat.emissiveTexture = _particleTex;
    flareMat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    flareMat.backFaceCulling = false;
    const boltCtx = { tier, flareMat, haloHex: C3.Lerp(C3.FromHexString('#a99cff'), C3.FromHexString(glow), 0.25).toHexString() };

    // --- particles -------------------------------------------------------------------------
    const systems = [];
    const addPs = (name, cap, emitter, local, setup) => {
      const ps = new BABYLON.ParticleSystem(name, cap, _scene);
      ps.particleTexture = _particleTex;
      ps.emitter = emitter;
      ps.isLocal = local;
      setup(ps);
      ps.start();
      systems.push(ps);
      return ps;
    };
    const puffBase1 = hexToColor4('#2a2b3a', 0.6), puffBase2 = hexToColor4('#4b4a63', 0.6), puffLit = hexToColor4('#7a74b8', 0.6);
    const puffs = addPs('tornadoCloudPuffs', particleCount(40), puffNode, true, (ps) => {
      ps.createCylinderEmitter(1.9, 0.05, 0.58, 0);
      ps.color1 = puffBase1.clone(); ps.color2 = puffBase2.clone();
      ps.colorDead = hexToColor4('#2a2b3a', 0);
      ps.minSize = 0.7; ps.maxSize = 1.4;
      ps.minLifeTime = 1.5; ps.maxLifeTime = 2.5;
      ps.minEmitPower = 0.02; ps.maxEmitPower = 0.08;
      ps.emitRate = particleCount(18);
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    });
    const groundPos = new V3(a.x, a.y + 0.02, a.z);
    const dust = addPs('tornadoDebrisCloud', particleCount(70), groundPos, false, (ps) => {
      ps.createDirectedCylinderEmitter(0.25, 0.05, 1, new V3(-0.5, 1, -0.5), new V3(0.5, 1.4, 0.5));
      ps.color1 = hexToColor4('#4a4550', 0.5); ps.color2 = hexToColor4('#6b6470', 0.5);
      ps.colorDead = hexToColor4('#6b6470', 0);
      ps.minSize = 0.2; ps.maxSize = 0.45;
      ps.minLifeTime = 0.6; ps.maxLifeTime = 1.0;
      ps.minEmitPower = 0.3; ps.maxEmitPower = 0.6;
      ps.gravity = new V3(0, 0.2, 0);
      ps.emitRate = particleCount(45);
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    });
    // Cloud wisps hugging the funnel body: spawned on the (curved, leaning) surface from the same
    // spine formula as the vertex shader, then whirled around the axis while drifting up.
    const spineXZ = (sv, out) => {
      const kk = 1 - (1 - sv) * (1 - sv);
      out.x = core.position.x + S.leanX * kk + (1 - sv) * 0.07 * Math.sin(2.1 * S.clock + 5 * sv);
      out.z = core.position.z + S.leanZ * kk + (1 - sv) * 0.05 * Math.cos(1.7 * S.clock + 4 * sv);
    };
    const spineTmp = { x: 0, z: 0 };
    addPs('tornadoBodyCloud', particleCount(120), core, false, (ps) => {
      ps.startPositionFunction = (wm, pos) => {
        const lo = Math.min(0.9, Math.max(0.05, S.revealLow));
        const sv = lo + Math.pow(Math.random(), 1.2) * (0.92 - lo);
        const th = Math.random() * Math.PI * 2;
        const r = funnelRadius(sv) * (1 - 0.55 * S.thin) * 1.05;
        spineXZ(sv, spineTmp);
        pos.copyFromFloats(spineTmp.x + Math.cos(th) * r, Config.BOARD_Y + sv * TORNADO_HC, spineTmp.z + Math.sin(th) * r);
      };
      ps.startDirectionFunction = (wm, dir, particle) => {
        const sv = Math.min(1, Math.max(0, (particle.position.y - Config.BOARD_Y) / TORNADO_HC));
        spineXZ(sv, spineTmp);
        const th = Math.atan2(particle.position.z - spineTmp.z, particle.position.x - spineTmp.x);
        const swirl = 1.4 + 2.2 * (1 - sv);
        dir.copyFromFloats(-Math.sin(th) * swirl, 0.5 + Math.random() * 0.5, Math.cos(th) * swirl);
      };
      ps.color1 = hexToColor4('#4a4a62', 0.6); ps.color2 = hexToColor4('#6a6a88', 0.5);
      ps.colorDead = hexToColor4('#3c3c4e', 0);
      ps.minSize = 0.16; ps.maxSize = 0.42;
      ps.minLifeTime = 0.5; ps.maxLifeTime = 0.9;
      ps.minEmitPower = 1; ps.maxEmitPower = 1;
      ps.emitRate = particleCount(120);
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    });
    addPs('tornadoDebris', particleCount(90), debrisSpin, true, (ps) => {
      ps.createDirectedCylinderEmitter(0.35, 0.05, 0.66, new V3(-0.15, 1, -0.15), new V3(0.15, 1.6, 0.15));
      ps.color1 = hexToColor4('#15151a', 1); ps.color2 = hexToColor4('#15151a', 1);
      ps.colorDead = hexToColor4('#15151a', 0);
      ps.minSize = 0.02; ps.maxSize = 0.05;
      ps.minLifeTime = 0.7; ps.maxLifeTime = 1.0;
      ps.minEmitPower = 0.8; ps.maxEmitPower = 1.2;
      ps.emitRate = particleCount(50);
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    });

    // --- state -----------------------------------------------------------------------------
    const atmos = { dark: 0, envFlash: 0 };
    stormJoin(atmos);
    const S = {
      clock: 0, leanX: TORNADO_REST_LEAN[0], leanZ: TORNADO_REST_LEAN[1], leanMul: 1, moving: false,
      thin: 0, revealLow: 1, cloudAlpha: 0, cloudScale: 0.3, ambient: 0, nextAmbient: 0.4, held: false, dying: false
    };
    const bolts = [], timers = [];
    let light = null;
    if (tier.light) {
      light = fxLight('tornadoLight', a.add(new V3(0, 1, 0)));
      light.diffuse = C3.FromHexString('#c9c2ff'); light.specular = light.diffuse.clone();
      light.intensity = 0; light.range = 7;
    }
    const fogDensityOf = () => _scene.fogDensity || 0.018;
    const tmpFlashFunnel = new V3(), tmpFlashCloud = new V3();
    const camPos = () => (_scene.activeCamera ? _scene.activeCamera.globalPosition || _scene.activeCamera.position : new V3(0, 8, -8));

    // Where a wide bolt goes: ground point 0.7-1.8 from the funnel foot, mostly at an azimuth
    // 50-130 degrees either side of the camera so the funnel is flanked, not hidden.
    const pickWide = (sign) => {
      const cam = camPos();
      const toCam = Math.atan2(cam.z - core.position.z, cam.x - core.position.x);
      const az = Math.random() < 0.85 ? toCam + sign * rnd(50, 130) * Math.PI / 180 : rnd(0, Math.PI * 2);
      const d = rnd(0.7, 1.8);
      const end = new V3(core.position.x + Math.cos(az) * d, Config.BOARD_Y + 0.02, core.position.z + Math.sin(az) * d);
      const ang = rnd(0, Math.PI * 2), off = rnd(0, 0.35);
      const start = new V3(end.x + Math.cos(ang) * off, pivot.position.y - 0.05, end.z + Math.sin(ang) * off);
      const vx = start.x - pivot.position.x, vz = start.z - pivot.position.z, vl = Math.hypot(vx, vz) || 1;
      const k = Math.min(1.6, Math.max(0.6, vl)) / vl;
      start.x = pivot.position.x + vx * k; start.z = pivot.position.z + vz * k;
      return { start, end };
    };

    const addBolt = (start, end, o) => {
      if (S.dying) return null; // a late timer / chain step must not outlive the storm
      const polys = generateBolt(start, end, { tier, width: o.width });
      const mid = V3.Lerp(end, start, 0.6);
      const bolt = spawnBolt(polys, boltCtx, { major: o.major, ground: o.ground, start, end, mid });
      bolts.push(bolt);
      return bolt;
    };
    const wideBolt = (sign) => {
      const e = pickWide(sign);
      addBolt(e.start, e.end, { width: 0.03, major: true, ground: true });
      if (sound && sound.playThunder && Math.random() < 0.4) sound.playThunder(0.25 + 0.2 * Math.random());
    };
    const ambientWide = () => {
      const sign = Math.random() < 0.5 ? 1 : -1;
      wideBolt(sign);
      if (Math.random() < tier.pair) timers.push({ at: S.clock * 1000 + rnd(10, 60), fn: () => wideBolt(-sign) });
    };
    // A short bolt down into the dust tube around the victim.
    const innerBolt = () => {
      const start = new V3(pivot.position.x + rnd(-0.2, 0.2), pivot.position.y - 0.3, pivot.position.z + rnd(-0.2, 0.2));
      const end = new V3(core.position.x + rnd(-0.12, 0.12), Config.BOARD_Y + rnd(0.25, 0.9), core.position.z + rnd(-0.12, 0.12));
      addBolt(start, end, { width: 0.02, major: false, ground: false });
      if (sound && sound.playThunder && Math.random() < 0.3) sound.playThunder(0.2);
    };
    const impactBolt = () => {
      const start = new V3(pivot.position.x + rnd(-0.15, 0.15), pivot.position.y - 0.3, pivot.position.z + rnd(-0.15, 0.15));
      const end = new V3(b.x, b.y + 0.9, b.z);
      addBolt(start, end, { width: 0.05, major: true, ground: true });
    };
    const impact = () => {
      impactBolt();
      timers.push({ at: S.clock * 1000 + 70, fn: impactBolt }, { at: S.clock * 1000 + 140, fn: impactBolt });
      if (sound && sound.playThunder) sound.playThunder(1);
    };

    // --- frame loop: everything moves off S.clock ------------------------------------------------
    const fm = funnel.mat, dm = cloud.disc.mat, bm = cloud.bowl.mat;
    const rimColor = C3.FromHexString('#9a93d6');
    const observer = _scene.onBeforeRenderObservable.add(() => {
      const real = Math.min(0.05, _scene.getEngine().getDeltaTime() / 1000);
      const dt = real * Tween.speed;
      S.clock += dt;
      const nowMs = S.clock * 1000;
      const k = 1 - Math.exp(-3 * dt);
      const tx = (S.moving ? dirX * 0.55 : TORNADO_REST_LEAN[0]) * S.leanMul;
      const tz = (S.moving ? dirZ * 0.55 : TORNADO_REST_LEAN[1]) * S.leanMul;
      S.leanX += (tx - S.leanX) * k; S.leanZ += (tz - S.leanZ) * k;

      const w0x = 0.07 * Math.sin(2.1 * S.clock), w0z = 0.05 * Math.cos(1.7 * S.clock);
      pivot.position.set(core.position.x + S.leanX, Config.BOARD_Y + TORNADO_HC, core.position.z + S.leanZ);
      pivot.rotation.y += dt * 0.4;
      pivot.scaling.setAll(S.cloudScale);
      groundPos.set(core.position.x + w0x, Config.BOARD_Y + 0.02, core.position.z + w0z);
      debrisSpin.position.set(groundPos.x, Config.BOARD_Y, groundPos.z);
      debrisSpin.rotation.y += dt * 6;
      pivot.computeWorldMatrix(true); puffNode.computeWorldMatrix(true); debrisSpin.computeWorldMatrix(true);

      // timed bolts (return strokes of an impact, the second of a pair)
      for (let i = timers.length - 1; i >= 0; i--) if (nowMs >= timers[i].at) { const t = timers.splice(i, 1)[0]; t.fn(); }
      // ambient strikes
      if (S.ambient && !S.dying) {
        S.nextAmbient -= dt;
        if (S.nextAmbient <= 0) {
          if (S.ambient === 1) { S.nextAmbient = rnd(0.35, 0.8); ambientWide(); }
          else { S.nextAmbient = rnd(0.25, 0.5); innerBolt(); }
        }
      }
      // age bolts, gather the flash
      let flash = 0, major = 0, best = null;
      for (let i = bolts.length - 1; i >= 0; i--) {
        const bt = bolts[i];
        const age = bt.age + dt * 1000;
        if (age >= 260) { bt.dispose(); bolts.splice(i, 1); continue; }
        bt.update(age);
        const f = bt.env * (bt.major ? 1 : 0.45);
        if (f > flash) { flash = f; best = bt; }
        if (bt.major) major = Math.max(major, bt.env);
      }
      if (best) {
        tmpFlashFunnel.copyFrom(best.mid || V3.Lerp(best.end, best.start, 0.6));
        tmpFlashCloud.copyFrom(best.start);
      }
      if (light) {
        light.intensity = best ? 8 * flash : 0;
        if (best) light.position.copyFrom(tmpFlashFunnel);
      }
      atmos.envFlash = 0.5 * major;
      stormApply();

      // uniforms
      const fogC = _scene.fogColor, fd = fogDensityOf();
      fm.setFloat('uTime', S.clock); fm.setVector2('uLean', new BABYLON.Vector2(S.leanX, S.leanZ));
      fm.setFloat('uWobbleAmp', 1); fm.setFloat('uThin', S.thin);
      fm.setFloat('uRevealLow', S.revealLow); fm.setFloat('uRevealHigh', 1);
      fm.setFloat('uFlash', flash); fm.setVector3('uFlashPos', tmpFlashFunnel);
      fm.setColor3('uRimColor', rimColor); fm.setColor3('uFogColor', fogC); fm.setFloat('uFogDensity', fd);
      fm.setFloat('uOctaves', tier.octaves);
      [dm, bm].forEach((m) => {
        m.setFloat('uTime', S.clock); m.setFloat('uFlash', flash); m.setVector3('uFlashPos', tmpFlashCloud);
        m.setFloat('uAlpha', S.cloudAlpha); m.setColor3('uFogColor', fogC); m.setFloat('uFogDensity', fd);
        m.setFloat('uOctaves', tier.octaves);
      });
      BABYLON.Color4.LerpToRef(puffBase1, puffLit, 0.6 * Math.min(1, flash), puffs.color1);
      BABYLON.Color4.LerpToRef(puffBase2, puffLit, 0.6 * Math.min(1, flash), puffs.color2);
    });

    // --- timeline --------------------------------------------------------------------------------
    const travelMs = Math.min(4200, Math.max(1560, dist * T.tornadoTravel));
    const side = dist > 1e-4 ? new V3(-(b.z - a.z), 0, b.x - a.x).normalize() : new V3(1, 0, 0);
    if (sound && sound.playWind) sound.playWind((T.tornadoGather + T.tornadoForm + travelMs + T.swept + T.tornadoFade) / 1000 / Tween.speed);
    const gate = () => (S.held ? Tween.wait(50).then(gate) : null);

    const formed = Tween.run(T.tornadoGather, (t) => {
      S.cloudScale = 0.3 + 0.7 * t; S.cloudAlpha = t; atmos.dark = t;
    }).then(() => {
      S.ambient = 1;
      return Tween.run(T.tornadoForm, (t) => { S.revealLow = 1 - t; }, Tween.Ease.inCubic);
    }).then(() => {
      // touchdown: a ring of dust and the first bolt
      burst({ pos: groundPos, count: 40, color1: '#4a4550', color2: '#6b6470', speed: { min: 0.8, max: 1.4 }, life: 0.7, size: 0.3, gravity: [0, 0.1, 0], blend: 'STANDARD' });
      wideBolt(Math.random() < 0.5 ? 1 : -1);
    });
    const arrived = formed.then(gate).then(() => {
      S.moving = dist > 1e-4;
      return Tween.run(travelMs, (t) => {
        const p = V3.Lerp(a, b, t);
        p.addInPlace(side.scale(Math.sin(t * Math.PI * 2) * Math.sin(t * Math.PI) * 0.18)); // snakes side to side
        core.position.copyFrom(p);
      }, Tween.Ease.inOutCubic);
    }).then(() => {
      core.position.copyFrom(b);
      S.moving = false; S.ambient = 2; S.nextAmbient = 0.5;
      impact();
      // the dust cloud swells into a tube around the victim
      Tween.run(250, (t) => {
        dust.particleEmitterType.radius = 0.25 + 0.13 * t;
        dust.emitRate = particleCount(45) * (1 + 2 * t);
        dust.maxEmitPower = 0.6 + 0.8 * t; dust.minEmitPower = 0.3 + 0.7 * t;
      }, Tween.Ease.outCubic);
    });

    let dissipating = null;
    function dissipate() {
      if (dissipating) return dissipating;
      S.dying = true; S.ambient = 0; timers.length = 0;
      bolts.forEach((bt) => bt.dispose()); bolts.length = 0;
      systems.forEach((ps) => ps.stop());
      dissipating = Tween.run(T.tornadoFade, (t) => {
        const rope = Math.min(1, t / 0.6), cl = Math.max(0, (t - 0.4) / 0.6);
        S.thin = rope; S.revealLow = rope; S.leanMul = 1 + 0.5 * rope;
        S.cloudAlpha = 1 - cl; S.cloudScale = 1 + 0.15 * cl;
        atmos.dark = 1 - Math.min(1, t * T.tornadoFade / 500);
      }, Tween.Ease.linear).then(() => {
        _scene.onBeforeRenderObservable.remove(observer);
        bolts.forEach((bt) => bt.dispose()); bolts.length = 0;
        atmos.envFlash = 0; atmos.dark = 0;
        stormLeave(atmos);
        if (_glow) stormMeshes.forEach((m) => _glow.removeExcludedMesh(m));
        [funnel, cloud.disc, cloud.bowl].forEach((o) => { o.mesh.dispose(); o.mat.dispose(); });
        flareMat.dispose();
        releaseLight(light);
        // Let in-flight particles die out before tearing down their emitters.
        return Tween.wait(1200).then(() => {
          systems.forEach((ps) => ps.dispose(false)); // keep the shared particle texture
          puffNode.dispose(); pivot.dispose(); debrisSpin.dispose(); core.dispose();
        });
      });
      return dissipating;
    }
    // Safety net: never leave a storm hanging if nobody dissipates it.
    const untilReleased = () => (S.held ? Tween.wait(100).then(untilReleased) : null);
    arrived.then(untilReleased).then(() => Tween.wait(4000)).then(dissipate);

    const debug = {
      strike() { ambientWide(); },
      impact,
      hold(on) { S.held = !!on; }
    };
    return { formed, arrived, dissipate, debug };
  }

  function promotionPillar(pos, color) {
    const p = toVector3(pos);
    const c = color || '#ffd54a';
    const mat = new BABYLON.StandardMaterial('promoPillarMat', _scene);
    mat.disableLighting = true;
    mat.emissiveColor = BABYLON.Color3.FromHexString(c);
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.backFaceCulling = false;
    mat.alpha = 0;

    const cyl = BABYLON.MeshBuilder.CreateCylinder('promoPillar', { diameter: 0.8, height: 4 }, _scene);
    cyl.position.set(p.x, Config.BOARD_Y + 2, p.z);
    cyl.material = mat;
    cyl.isPickable = false;
    cyl.scaling.x = 0.2;
    cyl.scaling.z = 0.2;

    dissolve(p, c, 1.5); // fire-and-forget: gold particles rising alongside the pillar

    const dur = Config.TIMING.promotion;
    return Tween.run(dur, (t) => {
      mat.alpha = (t < 0.5) ? (t / 0.5) * 0.8 : 0.8 * (1 - (t - 0.5) / 0.5);
      const s = 0.2 + t * 0.8;
      cyl.scaling.x = s;
      cyl.scaling.z = s;
    }, Tween.Ease.inOutCubic).then(() => {
      cyl.dispose();
      mat.dispose();
    });
  }

  // Continuous effect (Phase 8): returns a handle with dispose() so callers can remove it.
  // opts.litMeshes (optional): restrict the flicker PointLight to these meshes, so
  // the (many) character PBR materials don't pay for 4 extra lights per pixel.
  function torch(pos, opts) {
    // A glowing diamond (stretched octahedron) hovering above the pillar: slow spin,
    // gentle bob, pulsing emissive, soft sparkles and a cool light.
    const p = toVector3(pos);
    const hoverY = 0.35;
    const diamond = BABYLON.MeshBuilder.CreatePolyhedron('torchDiamond',
      { type: 1, size: 1 }, _scene);
    diamond.scaling.set(0.2, 0.32, 0.2);
    diamond.position.set(p.x, p.y + hoverY, p.z);
    diamond.isPickable = false;
    const mat = new BABYLON.StandardMaterial('torchDiamondMat', _scene);
    mat.diffuseColor = BABYLON.Color3.FromHexString('#8fe8ff');
    mat.emissiveColor = BABYLON.Color3.FromHexString('#6fdcff');
    mat.specularColor = BABYLON.Color3.White();
    mat.specularPower = 96;
    mat.alpha = 0.92;
    diamond.material = mat;

    const emitRate = particleCount(14);
    const ps = new BABYLON.ParticleSystem('torch', Math.max(emitRate * 4, 20), _scene);
    ps.particleTexture = _particleTex;
    ps.emitter = diamond.position.clone();
    ps.createSphereEmitter(0.18);
    ps.color1 = hexToColor4('#ffffff', 1);
    ps.color2 = hexToColor4('#8fe8ff', 1);
    ps.colorDead = hexToColor4('#6fdcff', 0);
    ps.minSize = 0.03;
    ps.maxSize = 0.08;
    ps.minLifeTime = 0.6;
    ps.maxLifeTime = 1.2;
    ps.minEmitPower = 0.02;
    ps.maxEmitPower = 0.1;
    ps.gravity = new BABYLON.Vector3(0, 0.1, 0);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    ps.emitRate = emitRate;
    ps.start();

    let light = null;
    if (!isLowQuality()) {
      light = new BABYLON.PointLight('torchLight', diamond.position.clone(), _scene);
      light.diffuse = BABYLON.Color3.FromHexString('#8fe8ff');
      light.intensity = 0.8;
      light.range = 7;
      if (opts && opts.litMeshes) light.includedOnlyMeshes = opts.litMeshes.slice();
    }
    const startT = performance.now();
    const phase = p.x * 1.7 + p.z * 0.9; // de-sync the 4 diamonds
    const observer = _scene.onBeforeRenderObservable.add(() => {
      const t = (performance.now() - startT) / 1000;
      diamond.rotation.y = t * 1.2 + phase;
      diamond.position.y = p.y + hoverY + Math.sin(t * 2 + phase) * 0.05;
      const pulse = 0.8 + Math.sin(t * 3 + phase) * 0.2;
      mat.emissiveColor.set(0.43 * pulse, 0.86 * pulse, 1 * pulse);
      if (light) light.intensity = 0.8 + Math.sin(t * 3 + phase) * 0.2;
    });

    return {
      dispose() {
        ps.stop();
        ps.dispose(false); // keep the shared particle texture alive for other effects
        if (light) light.dispose();
        _scene.onBeforeRenderObservable.remove(observer);
        diamond.dispose();
        mat.dispose();
      }
    };
  }

  // Continuous effect (Phase 8): returns a handle with dispose(). Disabled at 'low' quality.
  function ambientMotes() {
    if (isLowQuality()) return { dispose() {} };
    const count = particleCount(150);
    const ps = new BABYLON.ParticleSystem('ambientMotes', count, _scene);
    ps.particleTexture = _particleTex;
    ps.emitter = new BABYLON.Vector3(0, 1, 0);
    ps.createBoxEmitter(
      new BABYLON.Vector3(0, 0.05, 0), new BABYLON.Vector3(0, 0.05, 0),
      new BABYLON.Vector3(-6, -2, -6), new BABYLON.Vector3(6, 2, 6)
    );
    const col = hexToColor4('#cfd8ff', 0.25);
    ps.color1 = col;
    ps.color2 = col;
    ps.colorDead = hexToColor4('#cfd8ff', 0);
    ps.minSize = 0.02;
    ps.maxSize = 0.05;
    ps.minLifeTime = 4;
    ps.maxLifeTime = 8;
    ps.minEmitPower = 0.02;
    ps.maxEmitPower = 0.08;
    ps.gravity = new BABYLON.Vector3(0, 0.02, 0);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    ps.emitRate = count / 6;
    ps.start();
    return {
      dispose() {
        ps.stop();
        ps.dispose(false); // keep the shared particle texture alive for other effects
      }
    };
  }

  // Light trail behind a swung blade: a ribbon between the world positions of
  // `base` and `tip` over the last `life` ms (smoothed with Catmull-Rom), hot
  // white along the newest edge and fading into `color` as it ages. It keeps
  // sampling until stop(); the tail then drains away and it self-disposes.
  function bladeTrail(base, tip, color, opts) {
    opts = opts || {};
    const life = opts.life || 190, SUB = 4, MAXS = 40, MAXP = (MAXS - 1) * SUB + 1;
    const mesh = new BABYLON.Mesh('bladeTrail', _scene);
    const positions = new Float32Array(MAXP * 6), uvs = new Float32Array(MAXP * 4), indices = [];
    for (let i = 0; i < MAXP - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const vd = new BABYLON.VertexData();
    vd.positions = positions; vd.uvs = uvs; vd.indices = indices;
    vd.applyToMesh(mesh, true);
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;

    const tex = new BABYLON.DynamicTexture('bladeTrailTex', { width: 128, height: 32 }, _scene, false);
    const c2d = tex.getContext(), glow = BABYLON.Color3.FromHexString(color || '#ffffff');
    const img = c2d.createImageData(128, 32);
    for (let y = 0; y < 32; y++) {
      const across = 1 - y / 31;                        // canvas top = tip edge
      for (let x = 0; x < 128; x++) {
        const age = x / 127, fade = Math.pow(1 - age, 1.6) * (0.2 + 0.8 * Math.pow(across, 1.3));
        const hot = Math.pow(1 - age, 6) * Math.pow(across, 3);
        const k = (y * 128 + x) * 4;
        img.data[k] = 255 * Math.min(1, (glow.r * fade + hot));
        img.data[k + 1] = 255 * Math.min(1, (glow.g * fade + hot));
        img.data[k + 2] = 255 * Math.min(1, (glow.b * fade + hot));
        img.data[k + 3] = 255;
      }
    }
    c2d.putImageData(img, 0, 0);
    tex.update();
    tex.wrapU = tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    const mat = new BABYLON.StandardMaterial('bladeTrailMat', _scene);
    mat.diffuseColor = BABYLON.Color3.Black(); mat.specularColor = BABYLON.Color3.Black();
    mat.emissiveTexture = tex; mat.disableLighting = true; mat.backFaceCulling = false;
    mat.alpha = 0.999; mat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    mesh.material = mat;

    const samples = [];
    let active = true, disposed = false;
    const lifeMs = () => life / Math.max(0.1, Tween.speed || 1);
    const catmull = (p0, p1, p2, p3, t) => BABYLON.Vector3.CatmullRom(p0, p1, p2, p3, t);
    const observer = _scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      if (active) {
        base.computeWorldMatrix(true); tip.computeWorldMatrix(true);
        samples.unshift({ b: base.getAbsolutePosition().clone(), t: tip.getAbsolutePosition().clone(), time: now });
      }
      while (samples.length > MAXS || (samples.length && now - samples[samples.length - 1].time > lifeMs())) samples.pop();
      if (!active && samples.length < 2) { dispose(); return; }
      // Newest first; each span between samples subdivided into SUB points.
      const pts = [];
      for (let i = 0; i < samples.length - 1; i++) {
        const s0 = samples[Math.max(0, i - 1)], s1 = samples[i], s2 = samples[i + 1], s3 = samples[Math.min(samples.length - 1, i + 2)];
        for (let k = 0; k < SUB; k++) {
          const f = k / SUB;
          pts.push({ b: catmull(s0.b, s1.b, s2.b, s3.b, f), t: catmull(s0.t, s1.t, s2.t, s3.t, f), time: s1.time + (s2.time - s1.time) * f });
        }
      }
      if (samples.length) pts.push(samples[samples.length - 1]);
      for (let i = 0; i < MAXP; i++) {
        const p = pts[Math.min(i, pts.length - 1)];
        if (!p) continue;
        const age = Math.min(1, (now - p.time) / lifeMs());
        positions.set([p.b.x, p.b.y, p.b.z, p.t.x, p.t.y, p.t.z], i * 6);
        uvs.set([age, 0, age, 1], i * 4);
      }
      mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions);
      mesh.updateVerticesData(BABYLON.VertexBuffer.UVKind, uvs);
    });
    function dispose() {
      if (disposed) return;
      disposed = true;
      _scene.onBeforeRenderObservable.remove(observer);
      mesh.dispose(); mat.dispose(); tex.dispose();
    }
    return { stop() { active = false; }, dispose };
  }

  // A shaft of light falling from the sky onto `pos` with motes drifting up
  // through it (the king's soul rising). Fades in, holds and fades out over
  // `ms`, then disposes itself.
  function heavenlyLight(pos, color, ms) {
    const p = toVector3(pos);
    ms = ms || 2800;
    const H = 7;
    const shaft = BABYLON.MeshBuilder.CreateCylinder('heavenShaft', {
      height: H, diameterTop: 1.5, diameterBottom: 0.75, tessellation: 32, cap: BABYLON.Mesh.NO_CAP
    }, _scene);
    shaft.position.set(p.x, p.y + H / 2, p.z);
    shaft.isPickable = false;
    const tex = new BABYLON.DynamicTexture('heavenShaftTex', { width: 4, height: 128 }, _scene, false);
    const ctx = tex.getContext(), c = BABYLON.Color3.FromHexString(color || '#fff4d6');
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    const rgb = (k) => `rgb(${Math.round(255 * Math.min(1, c.r * k))},${Math.round(255 * Math.min(1, c.g * k))},${Math.round(255 * Math.min(1, c.b * k))})`;
    g.addColorStop(0, rgb(0)); g.addColorStop(0.45, rgb(0.35)); g.addColorStop(0.9, rgb(0.6)); g.addColorStop(1, rgb(0.15));
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 128);
    tex.update();
    const mat = new BABYLON.StandardMaterial('heavenShaftMat', _scene);
    mat.diffuseColor = BABYLON.Color3.Black(); mat.specularColor = BABYLON.Color3.Black();
    mat.emissiveTexture = tex; mat.disableLighting = true; mat.backFaceCulling = false;
    mat.alphaMode = BABYLON.Engine.ALPHA_ADD; mat.alpha = 0;
    shaft.material = mat;
    if (_glow) _glow.addExcludedMesh(shaft);

    const count = particleCount(90);
    const ps = new BABYLON.ParticleSystem('heavenMotes', count, _scene);
    ps.particleTexture = _particleTex;
    ps.emitter = p.add(new BABYLON.Vector3(0, 0.3, 0));
    ps.createCylinderEmitter(0.3, 0.8, 0.2, 0);
    ps.color1 = hexToColor4(color || '#fff4d6', 1);
    ps.color2 = hexToColor4('#ffffff', 1);
    ps.colorDead = hexToColor4(color || '#fff4d6', 0);
    ps.minSize = 0.03; ps.maxSize = 0.08;
    ps.minLifeTime = 1.2; ps.maxLifeTime = 2.2;
    ps.minEmitPower = 0.2; ps.maxEmitPower = 0.5;
    ps.direction1 = new BABYLON.Vector3(-0.1, 1, -0.1); ps.direction2 = new BABYLON.Vector3(0.1, 1, 0.1);
    ps.gravity = new BABYLON.Vector3(0, 0.6, 0);
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    ps.emitRate = count / 1.6;
    ps.start();

    const fadeIn = 450, fadeOut = 900, peak = 0.9;
    Tween.run(fadeIn, (t) => { mat.alpha = peak * t; }, Tween.Ease.outCubic)
      .then(() => Tween.wait(Math.max(0, ms - fadeIn - fadeOut)))
      .then(() => { ps.stop(); return Tween.run(fadeOut, (t) => { mat.alpha = peak * (1 - t); }, Tween.Ease.inCubic); })
      .then(() => {
        if (_glow) _glow.removeExcludedMesh(shaft);
        shaft.dispose(); mat.dispose(); tex.dispose();
        Tween.wait(2400).then(() => ps.dispose(false));
      });
  }

  function victoryBurst(pos, color) {
    const p = toVector3(pos);
    explosion(p, color);
    Tween.wait(300).then(() => explosion(p.add(new BABYLON.Vector3(0.4, 0.6, 0.2)), color));
    Tween.wait(600).then(() => explosion(p.add(new BABYLON.Vector3(-0.4, 0.9, -0.3)), color));
  }

  // --- shader / texture warm-up ----------------------------------------------------------------
  // The first time an effect ran, its materials and particle shaders had to
  // compile and its canvas textures to be painted mid-animation, so first
  // plays stuttered (the queen's attack, the king's death) and later ones
  // didn't. Run a fast, silent rehearsal of them while the loading overlay
  // still hides the canvas: everything gets compiled and cached up front.
  // opts.king / opts.queen: live characters to rehearse their own effects on.
  async function prewarm(opts) {
    opts = opts || {};
    const E = window.Chess3D.Effects;
    const scene = _scene, cam = scene.activeCamera;
    const camState = cam ? { a: cam.alpha, b: cam.beta, r: cam.radius, t: cam.target.clone() } : null;
    const sound = window.ChessSound;
    const mute = new Proxy({}, { get: () => () => {} });
    const speed = Tween.speed;
    // Waits for n rendered frames. A hidden tab renders nothing, so each wait
    // also times out: boot must never hang on the rehearsal.
    const frames = (n) => new Promise((resolve) => {
      let left = n;
      const done = () => { scene.onAfterRenderObservable.remove(obs); clearTimeout(timer); resolve(); };
      const obs = scene.onAfterRenderObservable.add(() => { if (--left <= 0) done(); });
      const timer = setTimeout(done, 300 + n * 50);
    });
    const attempt = (fn) => { try { fn(); } catch (err) { console.warn('[Chess3D] prewarm step failed', err); } };
    const V = (x, y, z) => new BABYLON.Vector3(x, y, z);
    const team = Config.TEAM.w, foe = Config.TEAM.b;
    const q = opts.queen, king = opts.king;
    window.ChessSound = mute;
    Tween.speed = 6;
    try {
      // Everything at once, so the shaders compile in parallel.
      const a = V(-1.5, 0, -0.5), b = V(0.5, 0, 0.5);
      let aura = null, strong = null, volc = null, host = null;
      attempt(() => {
        burst({ pos: b, count: 10 }); burst({ pos: b, count: 10, blend: 'STANDARD' });
        sparks(b, team.accent); explosion(b, team.glow); dissolve(b, team.glow, 1);
        projectile(a.add(V(0, 0.6, 0)), b.add(V(0, 0.4, 0)), 'fire', team);
        lightning(a.add(V(0, 1, 0)), b.add(V(0, 0.3, 0)), team.glow);
        promotionPillar(a, team.glow);
        heavenlyLight(b, '#fff4d6', 600);
      });
      attempt(() => { const t = tornado(a, b, team); t.debug.strike(); t.arrived.then(() => t.dissipate()); });
      if (E.magicAura) {
        host = q ? q.root : new BABYLON.TransformNode('prewarmHost', scene);
        attempt(() => {
          aura = E.magicAura(host, { color: team.glow, height: 1 });
          strong = E.magicAura(host, { color: foe.glow, height: 1.2, strong: true });
          if (q && q._setBlaze) q._setBlaze(1);
          E.markTarget(host.position.add(V(0, 1, 0)), b, team.glow);
          E.meteorShower(b, { from: host.position, glow: team.glow });
          volc = E.volcanoes(b, { glow: team.glow });
          E.shadowSmoke(a);
          E.shadowDragon(a, 0, { glow: foe.glow });
        });
      }
      if (king && king._releaseSoul) attempt(() => king._releaseSoul());
      // Let the comets fall and the volcanoes erupt on screen (~0.4 s at 6x).
      await Promise.all([frames(4), new Promise((r) => setTimeout(r, 700))]);
      await Promise.race([scene.whenReadyAsync(), new Promise((r) => setTimeout(r, 3000))]);
      // Wind down and fast-forward whatever is still running so it cleans itself up.
      attempt(() => {
        if (aura) aura.stop();
        if (strong) strong.stop();
        if (volc) volc.subside();
        if (q && q._setBlaze) q._setBlaze(0);
      });
      await Tween.drain();
      if (host && !q) host.dispose();
      if (king) { king._soulReleased = false; king.soulDone = null; }
    } finally {
      Tween.endSkip();
      Tween.speed = speed;
      window.ChessSound = sound;
      if (camState) { cam.alpha = camState.a; cam.beta = camState.b; cam.radius = camState.r; cam.setTarget(camState.t); }
    }
  }

  window.Chess3D.Effects = {
    init, setQuality, initLightPool, fxLight, releaseLight, prewarm, burst, dustPuff, sparks, projectile, lightning, tornado,
    explosion, shockwave, dissolve, promotionPillar, torch, ambientMotes, victoryBurst, bladeTrail, heavenlyLight
  };
})();
