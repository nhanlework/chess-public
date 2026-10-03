// Queen VFX, added onto Chess3D.Effects: the scepter's sparkles, the magic
// aura she flies in, the meteor shower and the four volcanoes of her attack,
// and the shadow dragon she turns into when she falls. Loaded after
// effects.js; every effect cleans itself up.
(function () {
  const Effects = window.Chess3D.Effects;
  const Config = window.Chess3D.Config;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const { TAU, V3: P3, lerp, clamp, smoothstep, curve, bezier, grid, sweep } = window.Chess3D.SurfaceKit;
  const V3 = BABYLON.Vector3, C3 = BABYLON.Color3, C4 = BABYLON.Color4;
  const hex = (h) => C3.FromHexString(h);
  const c4 = (h, a) => { const c = typeof h === 'string' ? hex(h) : h; return new C4(c.r, c.g, c.b, a == null ? 1 : a); };

  let S = null, glowLayer = null, factor = 1, low = false;
  let tex = {};
  const baseInit = Effects.init, baseSetQuality = Effects.setQuality;
  function quality(q, key) {
    factor = (q && typeof q.particles === 'number') ? q.particles : 1;
    low = key ? key === 'low' : factor <= 0.4;
  }
  Effects.init = function (scene, ctx) {
    baseInit(scene, ctx);
    S = scene; glowLayer = (ctx && ctx.glow) || null; tex = {};
    quality(ctx && ctx.quality, ctx && ctx.qualityKey);
  };
  Effects.setQuality = function (q, key) { baseSetQuality(q, key); quality(q, key); };
  const count = (n) => Math.max(1, Math.round(n * factor));
  const snd = () => window.ChessSound || {};

  // ------------------------------------------------------------ textures
  function canvasTex(name, size, draw) {
    const t = new BABYLON.DynamicTexture(name, { width: size, height: size }, S, true);
    draw(t.getContext(), size);
    t.update();
    t.hasAlpha = true;
    return t;
  }
  function getTex(key, fresh) {
    if (!fresh && tex[key] && tex[key].getInternalTexture()) return tex[key];
    const T = {
      dot: () => canvasTex('qDot', 64, (c, n) => {
        const g = c.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.65)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.fillRect(0, 0, n, n);
      }),
      star: () => canvasTex('qStar', 64, (c, n) => {
        c.clearRect(0, 0, n, n);
        const g = c.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n * 0.18);
        g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.fillRect(0, 0, n, n);
        c.fillStyle = '#fff';
        [0, Math.PI / 2].forEach((a) => {
          c.save(); c.translate(n / 2, n / 2); c.rotate(a);
          c.beginPath(); c.moveTo(-n / 2, 0); c.quadraticCurveTo(0, n * 0.03, n / 2, 0); c.quadraticCurveTo(0, -n * 0.03, -n / 2, 0); c.fill();
          c.restore();
        });
      }),
      smoke: () => canvasTex('qSmoke', 128, (c, n) => {
        c.clearRect(0, 0, n, n);
        for (let i = 0; i < 18; i++) {
          const x = n / 2 + (Math.random() - 0.5) * n * 0.35, y = n / 2 + (Math.random() - 0.5) * n * 0.35, r = n * (0.15 + Math.random() * 0.2);
          const g = c.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = g; c.fillRect(0, 0, n, n);
        }
      }),
      // magic circle: rings, a hexagram and runes
      rune: () => canvasTex('qRune', 512, (c, n) => {
        c.clearRect(0, 0, n, n);
        c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 6;
        const R = n / 2 - 8, cx = n / 2;
        [R, R * 0.86, R * 0.52].forEach((r, i) => { c.lineWidth = i === 1 ? 3 : 6; c.beginPath(); c.arc(cx, cx, r, 0, TAU); c.stroke(); });
        c.lineWidth = 4;
        [0, Math.PI].forEach((o) => {
          c.beginPath();
          for (let k = 0; k <= 3; k++) { const a = o + k / 3 * TAU - Math.PI / 2; c[k ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * R * 0.86, cx + Math.sin(a) * R * 0.86); }
          c.stroke();
        });
        c.font = `bold ${Math.round(n * 0.055)}px serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
        const RUNES = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒ';
        for (let k = 0; k < RUNES.length; k++) {
          const a = k / RUNES.length * TAU;
          c.save(); c.translate(cx + Math.cos(a) * R * 0.93, cx + Math.sin(a) * R * 0.93); c.rotate(a + Math.PI / 2);
          c.fillText(RUNES[k], 0, 0); c.restore();
        }
      }),
      // scorched ground with glowing cracks (alpha = scorch, rgb = glow)
      scorch: () => canvasTex('qScorch', 256, (c, n) => {
        c.clearRect(0, 0, n, n);
        const g = c.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
        g.addColorStop(0, 'rgba(20,10,5,0.95)'); g.addColorStop(0.55, 'rgba(25,12,6,0.7)'); g.addColorStop(1, 'rgba(25,12,6,0)');
        c.fillStyle = g; c.fillRect(0, 0, n, n);
        c.strokeStyle = 'rgba(255,140,40,1)'; c.lineCap = 'round';
        for (let k = 0; k < 9; k++) {
          let x = n / 2, y = n / 2, a = k / 9 * TAU + Math.random() * 0.4;
          c.lineWidth = 5;
          c.beginPath(); c.moveTo(x, y);
          for (let j = 0; j < 7; j++) {
            a += (Math.random() - 0.5) * 0.9; const st = n * 0.06;
            x += Math.cos(a) * st; y += Math.sin(a) * st; c.lineTo(x, y);
            c.lineWidth = Math.max(1, 5 - j * 0.6);
          }
          c.stroke();
        }
      }),
      // lava rivulets running down a volcano (v up = canvas top)
      lava: () => canvasTex('qLava', 256, (c, n) => {
        c.fillStyle = '#000'; c.fillRect(0, 0, n, n);
        for (let k = 0; k < 11; k++) {
          let x = (k + Math.random() * 0.5) / 11 * n, y = 0;
          const w0 = 3 + Math.random() * 4;
          c.beginPath(); c.moveTo(x, y);
          while (y < n * (0.55 + Math.random() * 0.45)) { y += n * 0.04; x += (Math.random() - 0.5) * n * 0.05; c.lineTo(x, y); }
          const g = c.createLinearGradient(0, 0, 0, n);
          g.addColorStop(0, 'rgba(255,230,120,1)'); g.addColorStop(0.4, 'rgba(255,110,20,1)'); g.addColorStop(1, 'rgba(120,20,0,0)');
          c.strokeStyle = g; c.lineWidth = w0; c.stroke();
        }
        const top = c.createLinearGradient(0, 0, 0, n * 0.15);
        top.addColorStop(0, 'rgba(255,160,40,1)'); top.addColorStop(1, 'rgba(255,80,0,0)');
        c.fillStyle = top; c.fillRect(0, 0, n, n * 0.15);
      }),
      // basalt: dark rock with lighter speckle and dark cracks
      basalt: () => canvasTex('qBasalt', 256, (c, n) => {
        c.fillStyle = '#3a302c'; c.fillRect(0, 0, n, n);
        for (let i = 0; i < 1400; i++) {
          const v = 30 + Math.random() * 60;
          c.fillStyle = `rgba(${v + 12},${v},${v - 6},${0.25 + Math.random() * 0.4})`;
          const r = 1 + Math.random() * 6;
          c.beginPath(); c.arc(Math.random() * n, Math.random() * n, r, 0, TAU); c.fill();
        }
        c.strokeStyle = 'rgba(10,6,5,0.8)';
        for (let k = 0; k < 30; k++) {
          let x = Math.random() * n, y = Math.random() * n;
          c.lineWidth = 1 + Math.random() * 2; c.beginPath(); c.moveTo(x, y);
          for (let j = 0; j < 5; j++) { x += (Math.random() - 0.5) * 30; y += Math.random() * 25; c.lineTo(x, y); }
          c.stroke();
        }
      }),
      // fading streak for comet tails (bright at v = 0)
      streak: () => canvasTex('qStreak', 64, (c, n) => {
        c.clearRect(0, 0, n, n);
        const g = c.createLinearGradient(0, n, 0, 0);
        g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.fillRect(0, 0, n, n);
      })
    };
    const t = T[key]();
    if (!fresh) tex[key] = t;
    return t;
  }

  function emissiveMat(name, color, texKey, alpha) {
    const m = new BABYLON.StandardMaterial(name, S);
    m.diffuseColor = C3.Black(); m.specularColor = C3.Black(); m.disableLighting = true;
    m.emissiveColor = typeof color === 'string' ? hex(color) : color;
    if (texKey) { m.emissiveTexture = getTex(texKey); m.opacityTexture = getTex(texKey); }
    m.alphaMode = BABYLON.Engine.ALPHA_ADD; m.backFaceCulling = false; m.disableDepthWrite = true;
    m.alpha = alpha == null ? 1 : alpha;
    return m;
  }
  function billboard(name, size, color, parent, alpha) {
    const p = BABYLON.MeshBuilder.CreatePlane(name, { size }, S);
    p.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL; p.isPickable = false;
    p.material = emissiveMat(name + 'Mat', color, 'dot', alpha);
    if (parent) p.parent = parent;
    if (glowLayer) glowLayer.addExcludedMesh(p);
    return p;
  }
  function killMesh(m) {
    if (!m) return;
    if (glowLayer) glowLayer.removeExcludedMesh(m);
    const mat = m.material;
    m.dispose(false, false);
    if (mat) mat.dispose(false, false);
  }
  // Particle system on the shared look: texture, colours, sizes, life, blend.
  function particles(name, cap, emitter, o) {
    const ps = new BABYLON.ParticleSystem(name, count(cap), S);
    ps.particleTexture = getTex(o.tex || 'dot');
    ps.emitter = emitter;
    ps.color1 = c4(o.c1, o.a1 == null ? 1 : o.a1); ps.color2 = c4(o.c2 || o.c1, o.a2 == null ? 1 : o.a2);
    ps.colorDead = c4(o.dead || o.c2 || o.c1, 0);
    ps.minSize = o.size[0]; ps.maxSize = o.size[1];
    ps.minLifeTime = o.life[0]; ps.maxLifeTime = o.life[1];
    ps.minEmitPower = (o.power || [0, 0])[0]; ps.maxEmitPower = (o.power || [0, 0])[1];
    ps.gravity = o.gravity ? new V3(...o.gravity) : V3.Zero();
    ps.blendMode = o.standard ? BABYLON.ParticleSystem.BLENDMODE_STANDARD : BABYLON.ParticleSystem.BLENDMODE_ADD;
    if (o.rate != null) ps.emitRate = count(o.rate);
    if (o.spin) { ps.minAngularSpeed = -o.spin; ps.maxAngularSpeed = o.spin; ps.minInitialRotation = 0; ps.maxInitialRotation = TAU; }
    if (o.sizeGrad) o.sizeGrad.forEach(([t, a, b]) => ps.addSizeGradient(t, a, b));
    if (o.colorGrad) o.colorGrad.forEach(([t, col, a]) => ps.addColorGradient(t, c4(col, a)));
    if (o.setup) o.setup(ps);
    return ps;
  }
  // Disposing a mesh also disposes every particle system it emits, textures
  // included (the shared cached ones here): hand those over to a fixed point
  // first so they can still fade out on their own.
  function detach(mesh, systems) {
    const p = mesh.getAbsolutePosition().clone();
    systems.forEach((ps) => { if (ps && ps.emitter === mesh) ps.emitter = p; });
  }
  // Stop a system now, dispose it once its particles are gone (keep textures).
  function retire(ps, afterS) {
    if (!ps) return;
    ps.stop();
    Tween.wait((afterS || ps.maxLifeTime + 0.2) * 1000).then(() => ps.dispose(false));
  }
  function flashLight(color, range) {
    if (low) return null;
    const l = Effects.fxLight('qFxLight');
    l.diffuse = hex(color); l.specular = hex(color); l.intensity = 0; l.range = range || 4;
    return l;
  }
  function ground(p) { return new V3(p.x, Config.BOARD_Y, p.z); }

  // ------------------------------------------------------------ sparkles
  // Twinkling four-point stars drifting off the scepter's orb.
  function sparkles(mesh, color, color2) {
    const base = 16;
    const ps = particles('qSparkles', 160, mesh, {
      tex: 'star', c1: '#ffffff', c2: color2 || color, dead: color, size: [0.02, 0.05], life: [0.3, 0.7], power: [0.02, 0.12],
      rate: base, spin: 3, sizeGrad: [[0, 0.004, 0.008], [0.35, 0.035, 0.06], [1, 0, 0]],
      setup: (p) => p.createSphereEmitter(0.035, 1)
    });
    ps.start();
    return {
      setLevel(k) { ps.emitRate = count(base * k); ps.minEmitPower = 0.02 * k; ps.maxEmitPower = 0.12 * k; },
      dispose() { retire(ps, 0.8); }
    };
  }

  // ------------------------------------------------------------ aura
  // Magic swirling round her body: motes rising, three wisps orbiting with
  // glowing trails, and a turning magic circle on the ground beneath.
  function magicAura(node, opts) {
    opts = opts || {};
    const color = opts.color || '#6fb4ff', color2 = opts.color2 || '#ffffff', H = opts.height || 1, strong = !!opts.strong;
    const em = new BABYLON.Mesh('qAuraEmitter', S);
    em.parent = node; em.position.y = 0.3 + H * 0.35;
    const motes = particles('qAuraMotes', 260, em, {
      c1: color, c2: color2, size: [0.025, 0.07], life: [0.8, 1.5], power: [0.05, 0.2], gravity: [0, 0.35, 0], rate: strong ? 150 : 80,
      sizeGrad: [[0, 0.02, 0.03], [0.4, 0.05, 0.08], [1, 0, 0]],
      setup: (p) => p.createCylinderEmitter(0.2, H * 0.8, 0.5, 0.3)
    });
    motes.start();
    const spin = new BABYLON.TransformNode('qAuraSpin', S);
    spin.parent = node;
    const wispMat = emissiveMat('qWispMat', C3.Lerp(hex(color), C3.White(), 0.4), 'dot');
    const wisps = [0, 1, 2].map((k) => {
      const w = BABYLON.MeshBuilder.CreatePlane('qWisp', { size: 0.09 }, S);
      w.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL; w.parent = spin; w.material = wispMat; w.isPickable = false;
      const trail = particles('qWispTrail', 160, w, { c1: color2, c2: color, size: [0.03, 0.06], life: [0.35, 0.6], rate: strong ? 110 : 70,
        sizeGrad: [[0, 0.05, 0.06], [1, 0, 0]] });
      trail.start();
      return { w, trail, k };
    });
    const disc = BABYLON.MeshBuilder.CreateDisc('qAuraCircle', { radius: 0.42, tessellation: 64 }, S);
    disc.parent = node; disc.rotation.x = Math.PI / 2; disc.position.y = Config.BOARD_Y + 0.075; disc.isPickable = false;
    disc.material = emissiveMat('qAuraCircleMat', color, 'rune', 0);
    if (glowLayer) glowLayer.addExcludedMesh(disc);
    let light = flashLight(color, 2.2);
    if (light) { light.parent = node; light.position.y = 0.6; }
    let fade = 0, target = 1, clock = 0;
    const obs = S.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, S.getEngine().getDeltaTime() / 1000) * Tween.speed;
      clock += dt;
      fade += (target - fade) * Math.min(1, dt * 5);
      spin.rotation.y += dt * (strong ? 4.2 : 3);
      wisps.forEach(({ w, k }) => {
        const a = k / 3 * TAU;
        w.position.set(Math.cos(a) * 0.26, 0.2 + H * (0.45 + 0.4 * Math.sin(clock * 1.7 + k * 2.1)), Math.sin(a) * 0.26);
        w.computeWorldMatrix(true);
      });
      em.computeWorldMatrix(true);
      disc.rotation.y = -clock * 0.6;
      disc.material.alpha = 0.75 * fade;
      const s = 0.85 + 0.15 * Math.sin(clock * 3);
      disc.scaling.set(s, s, s);
      wispMat.alpha = fade;
      if (light) light.intensity = (strong ? 1.6 : 0.9) * fade * (0.85 + 0.15 * Math.sin(clock * 9));
    });
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        target = 0;
        motes.stop(); wisps.forEach(({ trail }) => trail.stop());
        Tween.wait(700).then(() => {
          S.onBeforeRenderObservable.remove(obs);
          wisps.forEach(({ w, trail }) => { detach(w, [trail]); w.dispose(false, false); });
          wispMat.dispose();
          killMesh(disc);
          if (light) { Effects.releaseLight(light); light = null; }
          return Tween.wait(1000);
        }).then(() => {
          motes.dispose(false); wisps.forEach(({ trail }) => trail.dispose(false));
          em.dispose(); spin.dispose();
        });
      }
    };
  }

  // ------------------------------------------------------------ attack
  // A ray from the scepter to the target, which leaves a burning magic
  // circle on the ground there for the comets to fall into.
  function markTarget(from, to, color) {
    const a = from.clone(), b = ground(to).add(new V3(0, 0.1, 0));
    const ray = BABYLON.MeshBuilder.CreateTube('qRay', { path: [a, b], radius: 0.012, tessellation: 8 }, S);
    ray.isPickable = false;
    ray.material = emissiveMat('qRayMat', C3.Lerp(hex(color), C3.White(), 0.5));
    const circle = BABYLON.MeshBuilder.CreateDisc('qTargetCircle', { radius: 0.5, tessellation: 64 }, S);
    circle.rotation.x = Math.PI / 2; circle.position = ground(to).add(new V3(0, 0.08, 0)); circle.isPickable = false;
    circle.material = emissiveMat('qTargetCircleMat', C3.Lerp(hex('#ff5a14'), hex(color), 0.25), 'rune', 0);
    if (glowLayer) glowLayer.addExcludedMesh(circle);
    Tween.run(320, (t) => { ray.material.alpha = 1 - t; ray.scaling.x = ray.scaling.z = 1 + 2 * t; }, Ease.outCubic)
      .then(() => { ray.material.dispose(); ray.dispose(); });
    Tween.run(3400, (t, raw) => {
      circle.material.alpha = 0.9 * Math.min(1, raw * 6) * (1 - smoothstep(0.75, 1, raw));
      const s = 0.4 + 0.6 * Math.min(1, raw * 5);
      circle.scaling.set(s, s, s);
      circle.rotation.y = raw * 4;
    }, Ease.linear).then(() => { circle.material.dispose(); killMesh(circle); });
  }

  // Burnt patch with glowing cracks left by an impact.
  function scorch(p, r, ms) {
    const d = BABYLON.MeshBuilder.CreateDisc('qScorch', { radius: r, tessellation: 24 }, S);
    d.rotation.x = Math.PI / 2; d.rotation.y = Math.random() * TAU; d.isPickable = false;
    d.position = ground(p).add(new V3(0, 0.074 + Math.random() * 0.004, 0));
    const m = new BABYLON.StandardMaterial('qScorchMat', S);
    m.diffuseTexture = getTex('scorch'); m.useAlphaFromDiffuseTexture = true; m.diffuseColor = new C3(0.25, 0.2, 0.18);
    m.emissiveTexture = getTex('scorch'); m.emissiveColor = new C3(1, 0.55, 0.2); m.specularColor = C3.Black();
    m.disableDepthWrite = true; m.zOffset = -2;
    d.material = m;
    Tween.run(ms || 2600, (t) => { m.alpha = 1 - t * t; m.emissiveColor = new C3(1, 0.55, 0.2).scale(1 - t); }, Ease.linear)
      .then(() => { m.dispose(); d.dispose(); });
  }

  // Comet: a burning rock with a flare, a fading tail and a fire trail,
  // falling from `start` onto `land`. Resolves at impact.
  function comet(start, land, size, ms, light) {
    const dir = land.subtract(start).normalize();
    const node = new BABYLON.TransformNode('qComet', S);
    node.position.copyFrom(start);
    const rock = BABYLON.MeshBuilder.CreateIcoSphere('qCometRock', { radius: size, subdivisions: 1, flat: true }, S);
    rock.parent = node; rock.isPickable = false;
    const rm = new BABYLON.StandardMaterial('qCometRockMat', S);
    rm.diffuseColor = new C3(0.15, 0.08, 0.05); rm.emissiveColor = new C3(1, 0.42, 0.08); rm.specularColor = C3.Black();
    rock.material = rm;
    const halo = billboard('qCometHalo', size * 9, '#ffb347', node, 0.9);
    const TL = 0.7 + size * 6;
    const tail = BABYLON.MeshBuilder.CreateCylinder('qCometTail', { height: TL, diameterTop: 0.002, diameterBottom: size * 2.6, tessellation: 12, cap: BABYLON.Mesh.NO_CAP }, S);
    tail.isPickable = false; tail.parent = node;
    tail.material = emissiveMat('qCometTailMat', hex('#ff5a14').scale(0.75), 'streak', 0.7);
    // point the tail's +y back along the path
    const back = dir.scale(-1), axis = V3.Cross(V3.Up(), back);
    tail.rotationQuaternion = axis.lengthSquared() < 1e-8 ? BABYLON.Quaternion.Identity() : BABYLON.Quaternion.RotationAxis(axis.normalize(), Math.acos(clamp(back.y, -1, 1)));
    tail.position = back.scale(TL / 2);
    if (glowLayer) glowLayer.addExcludedMesh(tail);
    const fire = particles('qCometFire', 400, rock, {
      c1: '#fff1b0', c2: '#ff8a1e', dead: '#3a0c02', size: [size * 1.6, size * 3.2], life: [0.25, 0.55], power: [0.05, 0.3], rate: 180 + size * 1400,
      colorGrad: [[0, '#fff6c8', 1], [0.25, '#ffb43a', 1], [0.6, '#ff4a12', 0.8], [1, '#2a0a04', 0]],
      sizeGrad: [[0, size * 2.2, size * 3], [1, size * 0.6, size]], setup: (p) => p.createSphereEmitter(size * 0.8, 1)
    });
    fire.start();
    const smoke = size > 0.07 ? particles('qCometSmoke', 120, rock, { tex: 'smoke', standard: true, c1: '#2a2224', c2: '#141012', a1: 0.55, a2: 0.4,
      size: [size * 3, size * 5], life: [0.6, 1.1], power: [0.02, 0.1], rate: 70, spin: 1 }) : null;
    if (smoke) smoke.start();
    if (snd().playWhistle) snd().playWhistle(ms / 1000 / Tween.speed, size > 0.07 ? 0.3 : 0.12);
    const spinAxis = new V3(Math.random(), Math.random(), Math.random()).normalize();
    return Tween.run(ms, (t) => {
      node.position = V3.Lerp(start, land, t);
      rock.rotate(spinAxis, 0.25, BABYLON.Space.LOCAL);
      rock.computeWorldMatrix(true);
    }, (x) => Math.pow(x, 1.5)).then(() => {
      retire(fire, 0.7); if (smoke) retire(smoke, 1.2);
      detach(rock, [fire, smoke]);
      killMesh(halo); killMesh(tail);
      rm.dispose(); rock.dispose(); node.dispose();
      impact(land, size, light);
    });
  }

  function impact(p, size, light) {
    const k = size / 0.06, at = ground(p);
    Effects.burst({ pos: at.add(new V3(0, 0.1, 0)), color1: '#ffe08a', color2: '#ff5a14', count: Math.round(30 * k), speed: { min: 1.2 * k, max: 3 * k },
      life: 0.6, size: 0.1 * Math.sqrt(k), gravity: [0, -6, 0] });
    Effects.burst({ pos: at.add(new V3(0, 0.05, 0)), color1: '#3a3030', color2: '#1a1414', count: Math.round(16 * k), speed: { min: 0.4, max: 1.2 * k },
      life: 0.9, size: 0.18 * Math.sqrt(k), gravity: [0, 0.4, 0], blend: 'STANDARD' });
    Effects.burst({ pos: at.add(new V3(0, 0.08, 0)), color1: '#ffcf6a', color2: '#ffffff', count: Math.round(20 * k), speed: { min: 2.5, max: 5 * k },
      life: 0.45, size: 0.05, gravity: [0, -8, 0] });
    Effects.shockwave(at.clone(), '#ff7a2a');
    scorch(at, 0.16 * Math.sqrt(k) + 0.08, 2200 + 600 * k);
    if (light) { light.position = at.add(new V3(0, 0.4, 0)); light.intensity = Math.max(light.intensity, 2.2 * Math.sqrt(k)); }
    if (snd().playBoom) snd().playBoom(Math.min(1, 0.35 * k));
    if (k > 1.5 && window.Chess3D.Cinematic && window.Chess3D.Cinematic.impactShake) window.Chess3D.Cinematic.impactShake();
  }

  // Comets rain down round `center` from the sky beyond it (seen from the
  // caster at opts.from); the last and largest lands on the target.
  // Returns { landed, done, duration }; opts.onFirstImpact fires once.
  function meteorShower(center, opts) {
    opts = opts || {};
    const c = ground(center);
    let away = opts.from ? c.subtract(ground(opts.from)) : new V3(0, 0, 1);
    away.y = 0;
    away = away.lengthSquared() > 1e-6 ? away.normalize() : new V3(0, 0, 1);
    const side = new V3(away.z, 0, -away.x);
    const N = 9, SPAN = 1350, FALL = 620, BIG = 0.16;
    const light = flashLight('#ff7a2a', 5);
    let obs = null;
    if (light) obs = S.onBeforeRenderObservable.add(() => { light.intensity *= Math.exp(-S.getEngine().getDeltaTime() / 1000 * 7); });
    const skyFor = (land, h) => land.add(away.scale(h * 0.45)).add(side.scale((Math.random() - 0.5) * 1.2)).add(new V3(0, h, 0));
    let first = true;
    const jobs = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2.4 + Math.random(), r = 0.3 + 0.45 * Math.random();
      const land = c.add(new V3(Math.cos(a) * r, 0.08, Math.sin(a) * r));
      const size = 0.035 + 0.03 * Math.random();
      jobs.push(Tween.wait(i * SPAN / (N - 1) + Math.random() * 60).then(() => comet(skyFor(land, 5 + Math.random()), land, size, FALL, light)).then(() => {
        if (first) { first = false; if (opts.onFirstImpact) opts.onFirstImpact(); }
      }));
    }
    const bigLand = c.add(new V3(0, 0.3, 0));
    const landed = Tween.wait(SPAN + 150).then(() => {
      if (snd().playWhistle) snd().playWhistle(0.8 / Tween.speed, 0.4);
      return comet(skyFor(bigLand, 6.5), bigLand, BIG, FALL + 180, light);
    });
    const done = Promise.all([landed, ...jobs]).then(() => Tween.wait(600)).then(() => {
      if (obs) S.onBeforeRenderObservable.remove(obs);
      Effects.releaseLight(light);
    });
    return { landed, done, duration: SPAN + 150 + FALL + 180 };
  }

  // Four volcanoes burst up through the board at the corners of the target
  // square and erupt lava until subside() sinks them back.
  function volcanoes(center, opts) {
    opts = opts || {};
    const c = ground(center);
    const DEPTH = 0.42, list = [];
    const rockMat = new BABYLON.PBRMaterial('qVolcanoRock', S);
    rockMat.albedoColor = new C3(0.55, 0.5, 0.48); rockMat.metallic = 0; rockMat.roughness = 0.92;
    rockMat.albedoTexture = getTex('basalt');
    const lavaTex = getTex('lava', true);
    rockMat.emissiveTexture = lavaTex; rockMat.emissiveColor = new C3(1, 1, 1); rockMat.maxSimultaneousLights = 6;
    const poolMat = new BABYLON.StandardMaterial('qLavaPool', S);
    poolMat.emissiveColor = new C3(1, 0.62, 0.15); poolMat.diffuseColor = C3.Black(); poolMat.specularColor = C3.Black(); poolMat.disableLighting = true;
    const light = flashLight('#ff6a1a', 3.5);
    if (light) light.position = c.add(new V3(0, 0.6, 0));
    if (snd().playRumble) snd().playRumble(4.2 / Tween.speed);
    const noise = (u, v, seed) => 0.45 * Math.sin(u * TAU * 5 + seed + v * 3) + 0.3 * Math.sin(u * TAU * 9 + seed * 2 - v * 7)
      + 0.25 * Math.sin(u * TAU * 17 + v * 13 + seed) * Math.sin(v * 11 + seed * 3) + 0.15 * Math.sin(u * TAU * 31 + v * 19);
    const PROFILE = [[0, 0.21, 0], [0.35, 0.155, 0.1], [0.7, 0.09, 0.24], [0.9, 0.066, 0.305], [1, 0.06, 0.32]];
    [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sz], k) => {
      const node = new BABYLON.TransformNode('qVolcano', S);
      node.position = c.add(new V3(sx * 0.44, -DEPTH, sz * 0.44));
      node.rotation.y = Math.random() * TAU;
      const seed = k * 1.7 + Math.random();
      const cone = new BABYLON.Mesh('qVolcanoCone', S);
      const coneVD = grid(48, 18, (u, v) => {
        const [r, y] = curve(PROFILE, v), n = noise(u, v, seed);
        const a = u * TAU, rr = r * (1 + 0.2 * n * (1 - 0.4 * v));
        return [rr * Math.cos(a), y + 0.02 * n * Math.sin(Math.PI * v), rr * Math.sin(a), u * 2, 1 - v];
      }, { closed: true });
      coneVD.applyToMesh(cone);
      cone.convertToFlatShadedMesh();
      cone.material = rockMat; cone.parent = node; cone.isPickable = false;
      const crater = new BABYLON.Mesh('qVolcanoCrater', S);
      grid(24, 4, (u, v) => {
        const a = u * TAU, r = lerp(0.06, 0.03, v);
        return [r * Math.cos(a), lerp(0.32, 0.27, v), r * Math.sin(a)];
      }, { closed: true, inward: true, capEnd: true }).applyToMesh(crater);
      crater.material = rockMat; crater.parent = node; crater.isPickable = false;
      const pool = BABYLON.MeshBuilder.CreateDisc('qLavaPoolDisc', { radius: 0.048, tessellation: 20 }, S);
      pool.rotation.x = Math.PI / 2; pool.position.y = 0.285; pool.parent = node; pool.material = poolMat; pool.isPickable = false;
      const glow = billboard('qCraterGlow', 0.45, '#ff8a2a', node, 0);
      glow.position.y = 0.36;
      const top = new V3(0, 0, 0);
      const lava = particles('qLavaFountain', 300, top, {
        c1: '#fff0a0', c2: '#ff7a1a', dead: '#5a0a00', size: [0.03, 0.075], life: [0.7, 1.2], power: [1.3, 2.4], gravity: [0, -5.5, 0], rate: 110,
        colorGrad: [[0, '#fff3b0', 1], [0.3, '#ffa02a', 1], [0.75, '#e0380a', 1], [1, '#3a0800', 0.2]],
        setup: (p) => { p.direction1 = new V3(-0.28, 1, -0.28); p.direction2 = new V3(0.28, 1, 0.28); p.minEmitBox = new V3(-0.03, 0, -0.03); p.maxEmitBox = new V3(0.03, 0, 0.03); }
      });
      const smoke = particles('qVolcanoSmoke', 90, top, {
        tex: 'smoke', standard: true, c1: '#3a3336', c2: '#1d191b', a1: 0.6, a2: 0.45, size: [0.2, 0.4], life: [1.3, 2.3], power: [0.3, 0.6],
        gravity: [0, 0.25, 0], rate: 28, spin: 0.8, sizeGrad: [[0, 0.12, 0.2], [1, 0.55, 0.8]],
        setup: (p) => { p.direction1 = new V3(-0.25, 1, -0.25); p.direction2 = new V3(0.25, 1, 0.25); }
      });
      const embers = particles('qVolcanoEmbers', 80, top, {
        c1: '#ffd27a', c2: '#ff5a14', size: [0.012, 0.028], life: [0.6, 1.1], power: [0.4, 0.9], gravity: [0, 0.2, 0], rate: 25,
        setup: (p) => { p.direction1 = new V3(-0.25, 1, -0.25); p.direction2 = new V3(0.25, 1, 0.25); }
      });
      list.push({ node, glow, lava, smoke, embers, top, seed });
    });
    let clock = 0, heat = 0;
    const obs = S.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, S.getEngine().getDeltaTime() / 1000) * Tween.speed;
      clock += dt;
      lavaTex.vOffset -= dt * 0.25;
      list.forEach((v) => {
        v.node.computeWorldMatrix(true);
        v.top.copyFrom(V3.TransformCoordinates(new V3(0, 0.3, 0), v.node.getWorldMatrix()));
        v.glow.material.alpha = 0.8 * heat * (0.8 + 0.2 * Math.sin(clock * 11 + v.seed));
      });
      rockMat.emissiveColor = new C3(1, 0.9, 0.8).scale(0.3 + 1.2 * heat);
      poolMat.emissiveColor = new C3(1, 0.62, 0.15).scale(0.5 + 0.5 * heat * (0.85 + 0.15 * Math.sin(clock * 7)));
      if (light) light.intensity = 2.4 * heat * (0.75 + 0.25 * Math.sin(clock * 13) * Math.sin(clock * 7.3));
    });
    // rise, one after another, shaking as they break through the board
    const risen = Promise.all(list.map((v, i) => Tween.wait(i * 110).then(() => {
      const base = v.node.position.clone();
      Effects.burst({ pos: base.clone().set(base.x, Config.BOARD_Y + 0.05, base.z), color1: '#6a5548', color2: '#2a2220', count: 26,
        speed: { min: 0.8, max: 2.2 }, life: 0.8, size: 0.07, gravity: [0, -7, 0], blend: 'STANDARD' });
      Effects.dustPuff(ground(base));
      scorch(base, 0.3, 4200);
      if (window.Chess3D.Cinematic && window.Chess3D.Cinematic.impactShake && i === 0) window.Chess3D.Cinematic.impactShake();
      return Tween.run(620, (t, raw) => {
        v.node.position.y = base.y + DEPTH * t;
        v.node.position.x = base.x + (Math.random() - 0.5) * 0.02 * (1 - raw);
        v.node.position.z = base.z + (Math.random() - 0.5) * 0.02 * (1 - raw);
      }, Ease.outBack).then(() => {
        v.node.position.set(base.x, base.y + DEPTH, base.z);
        v.lava.start(); v.smoke.start(); v.embers.start();
        Effects.burst({ pos: v.top.clone(), color1: '#fff0a0', color2: '#ff5a14', count: 26, speed: { min: 0.8, max: 1.7 }, life: 0.8, size: 0.06, gravity: [0, -5, 0] });
        if (snd().playBoom) snd().playBoom(0.25);
      });
    })));
    Tween.run(700, (t) => { heat = t; }, Ease.linear);
    let sinking = null;
    function subside() {
      if (sinking) return sinking;
      list.forEach((v) => { v.lava.stop(); v.embers.stop(); v.smoke.stop(); });
      const y0 = list.map((v) => v.node.position.y);
      sinking = Tween.run(1000, (t) => {
        heat = 1 - t;
        list.forEach((v, i) => { v.node.position.y = y0[i] - DEPTH * t; });
      }, Ease.inCubic).then(() => {
        S.onBeforeRenderObservable.remove(obs);
        list.forEach((v) => { killMesh(v.glow); v.node.dispose(false, false); });
        rockMat.dispose(); poolMat.dispose(); lavaTex.dispose();
        Effects.releaseLight(light);
        return Tween.wait(2400).then(() => list.forEach((v) => { v.lava.dispose(false); v.smoke.dispose(false); v.embers.dispose(false); }));
      });
      return sinking;
    }
    risen.then(() => Tween.wait(7000)).then(subside);     // safety net
    return { risen, subside };
  }

  // ------------------------------------------------------------ death
  // Dark smoke boiling up round the queen as she turns to shadow.
  function shadowSmoke(pos) {
    const p = ground(pos);
    const em = p.add(new V3(0, 0.4, 0));
    const smoke = particles('qShadowSmoke', 160, em, {
      tex: 'smoke', standard: true, c1: '#0d0a12', c2: '#23102a', a1: 0.85, a2: 0.7, size: [0.2, 0.45], life: [0.9, 1.6], power: [0.2, 0.6],
      gravity: [0, 0.9, 0], rate: 140, spin: 1.5, sizeGrad: [[0, 0.15, 0.25], [1, 0.5, 0.8]],
      setup: (ps) => ps.createCylinderEmitter(0.25, 0.8, 0.6, 0.4)
    });
    smoke.start();
    const sparks = particles('qShadowSparks', 60, em, { c1: '#b04aff', c2: '#ff3a3a', size: [0.02, 0.05], life: [0.5, 0.9], power: [0.4, 1.2], rate: 60,
      setup: (ps) => ps.createSphereEmitter(0.3, 1) });
    sparks.start();
    Tween.wait(1000).then(() => { retire(smoke, 1.8); retire(sparks, 1); });
  }

  // The shadow of a black dragon — four legs, two bat wings, a long tail and
  // eyes blazing with fire — rearing out of the smoke and flying off into
  // the sky, fading as it climbs. Self-disposing; resolves when gone.
  function shadowDragon(pos, facing, opts) {
    opts = opts || {};
    const rim = C3.Lerp(hex(opts.glow || '#6fb4ff'), hex('#6a2a9a'), 0.55).scale(0.7);
    const mats = [];
    const bodyMat = new BABYLON.StandardMaterial('qDragonBody', S);
    bodyMat.diffuseColor = new C3(0.02, 0.018, 0.025); bodyMat.specularColor = new C3(0.12, 0.1, 0.15); bodyMat.specularPower = 24;
    bodyMat.emissiveColor = new C3(0.01, 0.005, 0.015);
    bodyMat.emissiveFresnelParameters = new BABYLON.FresnelParameters();
    bodyMat.emissiveFresnelParameters.bias = 0.25; bodyMat.emissiveFresnelParameters.power = 2.2;
    bodyMat.emissiveFresnelParameters.leftColor = rim; bodyMat.emissiveFresnelParameters.rightColor = C3.Black();
    const wingMat = bodyMat.clone('qDragonWing');
    wingMat.backFaceCulling = false; wingMat.twoSidedLighting = true;
    wingMat.diffuseColor = new C3(0.035, 0.02, 0.04);
    mats.push(bodyMat, wingMat);
    const eyeMat = new BABYLON.StandardMaterial('qDragonEye', S);
    eyeMat.emissiveColor = new C3(1, 0.62, 0.12); eyeMat.diffuseColor = C3.Black(); eyeMat.specularColor = C3.Black(); eyeMat.disableLighting = true;

    const root = new BABYLON.TransformNode('qDragon', S);
    root.position = ground(pos).add(new V3(0, 0.1, 0));
    root.rotation.y = facing || 0;
    const body = new BABYLON.TransformNode('qDragonPitch', S);
    body.parent = root; body.position.y = 0.4;
    const meshes = [];
    const surf = (name, vd, mat, parent) => {
      const m = new BABYLON.Mesh(name, S);
      vd.applyToMesh(m); m.material = mat; m.parent = parent; m.isPickable = false;
      meshes.push(m);
      return m;
    };
    const tube = (name, pts, rk, parent, mat, sides, flat) => {
      const keys = pts.map((p, i) => [i / (pts.length - 1), p[0], p[1], p[2]]);
      const rkk = typeof rk === 'number' ? [[0, rk], [1, rk]] : rk;
      return surf(name, sweep(sides || 10, Math.max(8, pts.length * 4), (t) => curve(keys, t), (t, a) => {
        const r = curve(rkk, t)[0];
        return [r * Math.cos(a), r * (flat || 1) * Math.sin(a)];
      }, { capStart: true, capEnd: true }), mat || bodyMat, parent);
    };
    const node = (name, parent, p) => { const n = new BABYLON.TransformNode(name, S); n.parent = parent; n.position.set(p[0], p[1], p[2]); return n; };
    const spike = (name, at, dir, len, w, parent) => surf(name, sweep(4, 3, (t) => [at[0] + dir[0] * len * t, at[1] + dir[1] * len * t, at[2] + dir[2] * len * t],
      (t, a) => { const r = w * (1 - t); return [r * Math.cos(a), r * 0.35 * Math.sin(a)]; }, { side: [1, 0, 0], capEnd: true }), bodyMat, parent);

    // torso: chest to hips, deep keel, flatter back
    tube('qDragonTorso', [[0, 0.02, 0.3], [0, 0.03, 0.15], [0, 0.0, -0.05], [0, -0.01, -0.22], [0, 0.0, -0.34]],
      [[0, 0.07], [0.25, 0.1], [0.55, 0.095], [0.85, 0.07], [1, 0.05]], body, bodyMat, 16, 1.15);
    for (let k = 0; k < 6; k++) spike(`qDragonBackSpike${k}`, [0, 0.12 - k * 0.006, 0.2 - k * 0.1], [0, 1, -0.5], 0.07 - k * 0.006, 0.02, body);
    // tail: a chain of segments that whips as it flies
    const tail = [];
    let parent = body, at = [0, 0.0, -0.32];
    for (let k = 0; k < 5; k++) {
      const seg = node(`qDragonTail${k}`, parent, at);
      const len = 0.2 - k * 0.018, r0 = 0.05 * Math.pow(0.72, k), r1 = 0.05 * Math.pow(0.72, k + 1);
      tube(`qDragonTailSeg${k}`, [[0, 0, 0.01], [0, -0.005, -len / 2], [0, -0.01, -len]], [[0, r0], [1, r1]], seg, bodyMat, 10);
      spike(`qDragonTailSpike${k}`, [0, r0 * 0.9, -len * 0.4], [0, 1, -0.6], 0.05 * Math.pow(0.8, k), 0.014, seg);
      tail.push(seg);
      parent = seg; at = [0, -0.01, -len];
    }
    // tail tip: an arrowhead blade
    surf('qDragonTailBlade', grid(6, 6, (u, v) => {
      const w = 0.05 * Math.sin(Math.PI * Math.pow(v, 0.7)) * (1 - v), x = (2 * u - 1) * w;
      return [x, 0.004 * Math.cos(Math.PI * (2 * u - 1) / 2), -v * 0.13];
    }), wingMat, tail[tail.length - 1]).position.z = -0.14;
    // neck and head
    const neck = node('qDragonNeck', body, [0, 0.03, 0.3]);
    tube('qDragonNeckTube', [[0, 0, 0], [0, 0.08, 0.08], [0, 0.18, 0.13], [0, 0.26, 0.15]], [[0, 0.065], [0.5, 0.045], [1, 0.036]], neck, bodyMat, 12);
    for (let k = 0; k < 4; k++) spike(`qDragonNeckSpike${k}`, [0, 0.05 + k * 0.06, 0.03 + k * 0.035], [0, 0.5, -1], 0.05, 0.014, neck);
    const head = node('qDragonHead', neck, [0, 0.27, 0.15]);
    tube('qDragonSkull', [[0, 0.01, -0.03], [0, 0.015, 0.04], [0, 0.0, 0.11], [0, -0.012, 0.17]], [[0, 0.04], [0.35, 0.042], [0.75, 0.028], [1, 0.018]], head, bodyMat, 14, 0.78);
    const jaw = node('qDragonJaw', head, [0, -0.018, 0.0]);
    tube('qDragonJawBone', [[0, 0, 0], [0, -0.01, 0.07], [0, -0.012, 0.15]], [[0, 0.028], [1, 0.012]], jaw, bodyMat, 10, 0.6);
    [-1, 1].forEach((s) => {
      tube(`qDragonHorn${s}`, [[s * 0.025, 0.03, 0.0], [s * 0.04, 0.06, -0.06], [s * 0.05, 0.07, -0.13], [s * 0.045, 0.1, -0.17]], [[0, 0.013], [1, 0.001]], head, bodyMat, 8);
      tube(`qDragonHornSmall${s}`, [[s * 0.035, 0.0, -0.01], [s * 0.06, 0.005, -0.06], [s * 0.07, 0.02, -0.09]], [[0, 0.008], [1, 0.001]], head, bodyMat, 6);
      spike(`qDragonBrow${s}`, [s * 0.025, 0.035, 0.07], [s * 0.3, 0.6, -1], 0.035, 0.01, head);
      for (let k = 0; k < 3; k++) spike(`qDragonTooth${s}${k}`, [s * 0.016, -0.018, 0.1 + k * 0.022], [0, -1, 0.1], 0.016, 0.004, head);
    });
    const eyes = [-1, 1].map((s) => {
      const e = BABYLON.MeshBuilder.CreateSphere('qDragonEyeBall', { diameter: 0.026, segments: 8 }, S);
      e.parent = head; e.position.set(s * 0.034, 0.024, 0.075); e.scaling.set(0.6, 0.55, 1.2); e.rotation.y = s * 0.4;
      e.material = eyeMat; e.isPickable = false; meshes.push(e);
      const f = billboard('qDragonEyeFlare', 0.22, '#ff9a2a', e, 0.9);
      f.scaling.set(1 / 0.6, 1 / 0.55, 1 / 1.2);
      const flame = particles('qDragonEyeFire', 160, e, {
        c1: '#fff0a0', c2: '#ff5a14', dead: '#400800', size: [0.03, 0.07], life: [0.2, 0.45], power: [0.05, 0.2], rate: 90,
        colorGrad: [[0, '#fff6c0', 1], [0.4, '#ffa02a', 1], [1, '#5a0a00', 0]], sizeGrad: [[0, 0.05, 0.07], [1, 0.01, 0.02]],
        setup: (p) => p.createSphereEmitter(0.01, 1)
      });
      flame.start();
      return { e, f, flame };
    });
    // legs: four, clawed; tucked under while it flies
    const legs = [[1, 0.2, true], [-1, 0.2, true], [1, -0.22, false], [-1, -0.22, false]].map(([s, z, fore]) => {
      const hip = node('qDragonHip', body, [s * 0.07, -0.02, z]);
      const L = fore ? [0.13, 0.12, 0.05] : [0.15, 0.14, 0.06];
      tube('qDragonThigh', [[0, 0, 0], [s * 0.03, -L[0] * 0.5, 0.02], [s * 0.035, -L[0], 0.0]], [[0, fore ? 0.04 : 0.055], [1, 0.022]], hip, bodyMat, 10);
      const knee = node('qDragonKnee', hip, [s * 0.035, -L[0], 0]);
      tube('qDragonShin', [[0, 0, 0], [0, -L[1] * 0.5, fore ? 0.015 : -0.03], [0, -L[1], 0.0]], [[0, 0.022], [1, 0.014]], knee, bodyMat, 8);
      const foot = node('qDragonFoot', knee, [0, -L[1], 0]);
      [-0.5, 0, 0.5].forEach((a, k) => tube(`qDragonClaw${k}`, [[0, 0, 0], [Math.sin(a) * 0.02, -0.01, 0.03], [Math.sin(a) * 0.035, -0.03, L[2]]],
        [[0, 0.01], [0.7, 0.006], [1, 0.0005]], foot, bodyMat, 6));
      return { hip, knee, fore };
    });
    // wings: bone arm, three fingers and a scalloped membrane, pivoting at the shoulder
    const wings = [-1, 1].map((s) => {
      const pivot = node('qDragonWing', body, [s * 0.06, 0.09, 0.18]);
      const X = (p) => [s * p[0], p[1], p[2]];
      const elbow = [0.24, 0.1, -0.06], wrist = [0.46, 0.16, 0.04];
      const tips = [[0.95, 0.14, -0.08], [0.88, 0.02, -0.38], [0.66, -0.04, -0.56], [0.4, -0.05, -0.58]];
      tube('qDragonWingArm', [[0, 0, 0], elbow, wrist].map(X), [[0, 0.022], [0.5, 0.014], [1, 0.011]], pivot, bodyMat, 8);
      tips.slice(0, 3).forEach((tp, k) => tube(`qDragonFinger${k}`, [wrist, [lerp(wrist[0], tp[0], 0.5), lerp(wrist[1], tp[1], 0.5) + 0.02, lerp(wrist[2], tp[2], 0.5)], tp].map(X),
        [[0, 0.009], [1, 0.002]], pivot, bodyMat, 6));
      spike('qDragonThumbClaw', X(wrist), [s * 0.2, 0.6, 0.8], 0.06, 0.01, pivot);
      // membrane panels between ribs: body side, then each finger
      const ribs = [
        (v) => lerp3([0.0, -0.02, 0.0], [0.03, -0.04, -0.5], v),
        (v) => bezier([elbow, [0.42, 0.02, -0.4], tips[3]], v),
        (v) => lerp3(wrist, tips[2], v), (v) => lerp3(wrist, tips[1], v), (v) => lerp3(wrist, tips[0], v)
      ];
      for (let k = 0; k < ribs.length - 1; k++) {
        surf(`qDragonMembrane${k}`, grid(10, 12, (u, v) => {
          const a = ribs[k](v), b = ribs[k + 1](v);
          const p = lerp3(a, b, u);
          const scallop = 0.12 * Math.sin(Math.PI * u) * Math.pow(v, 3);
          const root = lerp3(ribs[k](0), ribs[k + 1](0), u);
          const q = lerp3(p, root, scallop);
          return X([q[0], q[1] - 0.012 * Math.sin(Math.PI * u) * v, q[2]]);
        }), wingMat, pivot);
      }
      return { pivot, s };
    });
    function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

    // smoke streaming off it
    const smokeEm = new BABYLON.Mesh('qDragonSmokeEm', S);
    smokeEm.parent = body;
    const smoke = particles('qDragonSmoke', 220, smokeEm, {
      tex: 'smoke', standard: true, c1: '#0b0810', c2: '#1d0f24', a1: 0.7, a2: 0.5, size: [0.15, 0.35], life: [0.7, 1.3], power: [0.05, 0.2],
      rate: 90, spin: 1.2, sizeGrad: [[0, 0.12, 0.2], [1, 0.45, 0.7]], setup: (p) => p.createSphereEmitter(0.25, 1)
    });
    smoke.start();
    if (snd().playRoar) Tween.wait(250).then(() => snd().playRoar());

    const up = new V3(0, 1, 0), fwd = new V3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    const start = root.position.clone();
    let clock = 0, flapAmp = 0.2, flapHz = 1.2, fold = 1, alpha = 0;
    const setAlpha = (a) => { alpha = a; mats.forEach((m) => { m.alpha = a; }); eyeMat.alpha = Math.min(1, a * 1.3); eyes.forEach(({ f }) => { f.material.alpha = 0.9 * a; }); };
    setAlpha(0);
    const obs = S.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, S.getEngine().getDeltaTime() / 1000) * Tween.speed;
      clock += dt;
      const flap = Math.sin(clock * TAU * flapHz);
      wings.forEach(({ pivot, s }) => {
        pivot.rotation.z = s * (flapAmp * flap + 0.1 - 1.1 * fold);
        pivot.rotation.y = -s * 0.9 * fold;
        pivot.rotation.x = 0.1 * Math.cos(clock * TAU * flapHz);
      });
      tail.forEach((seg, k) => {
        seg.rotation.y = 0.22 * Math.sin(clock * 3.2 - k * 0.8);
        seg.rotation.x = 0.1 + 0.08 * Math.sin(clock * 2.6 - k * 0.7);
      });
      legs.forEach(({ hip, knee, fore }) => {
        hip.rotation.x = (fore ? 0.6 : 0.9) + 0.1 * Math.sin(clock * 2 + (fore ? 0 : 1));
        knee.rotation.x = fore ? -1.1 : -0.8;
      });
      body.position.y = 0.4 - 0.04 * flap * (1 - fold);
      smokeEm.computeWorldMatrix(true);
      eyes.forEach(({ e }) => e.computeWorldMatrix(true));
    });
    const dispose = () => {
      S.onBeforeRenderObservable.remove(obs);
      retire(smoke, 1.5); eyes.forEach(({ flame, f }) => { retire(flame, 0.6); killMesh(f); });
      Tween.wait(1600).then(() => {
        meshes.forEach((m) => m.dispose(false, false));
        mats.forEach((m) => m.dispose()); eyeMat.dispose();
        smokeEm.dispose(); root.dispose();
      });
    };
    // 1. rears up out of the smoke, wings unfolding, and roars
    return Tween.run(750, (t) => {
      const s = 0.35 + 0.65 * t;
      root.scaling.set(s, s, s);
      setAlpha(Math.min(1, t * 1.6));
      fold = 1 - t; flapAmp = 0.2 + 0.5 * t;
      body.rotation.x = -0.55 * t;
      neck.rotation.x = -0.4 * Math.sin(Math.PI * t);
      jaw.rotation.x = 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.3));
      root.position.y = start.y + 0.15 * t;
    }, Ease.outCubic).then(() => {
      // 2. beats its wings and climbs away into the sky, fading
      flapHz = 1.7; flapAmp = 0.85;
      const p0 = root.position.clone();
      return Tween.run(2600, (t, raw) => {
        root.position = p0.add(up.scale(6.5 * t)).add(fwd.scale(2 * t)).add(new V3(0.4 * Math.sin(raw * Math.PI), 0, 0));
        body.rotation.x = -0.55 - 0.25 * Math.sin(Math.PI * raw * 0.5);
        body.rotation.z = 0.15 * Math.sin(raw * 5);
        neck.rotation.x = 0.1;
        jaw.rotation.x = 0.1;
        setAlpha(1 - smoothstep(0.55, 1, raw));
      }, (x) => x * x);
    }).then(dispose);
  }

  Object.assign(Effects, { sparkles, magicAura, markTarget, meteorShower, volcanoes, shadowSmoke, shadowDragon });
})();
