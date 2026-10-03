// Glossy board (3D settings checkbox): a transparent "glass" sheet over the
// squares that shows only a mirror reflection of the pieces plus the sun's
// specular glint, so the board reads as polished glass / a wet surface while
// the squares keep their own PBR look underneath.
//
// Cost control: the mirror pass draws idle pieces as vertex-coloured, unlit
// meshes (one thin-instanced mesh per InstancePool pose key, see
// CharacterBase._bakeReflection), not their PBR parts. Animating pieces draw
// their live meshes with unlit stand-in materials.
(function () {
  const Config = window.Chess3D.Config;
  const BOARD_Y = Config.BOARD_Y;

  let scene = null, pieces = null, glow = null;
  let mirror = null, sheet = null, observer = null, lastEpoch = -1;
  let enabled = false;

  function build() {
    mirror = new BABYLON.MirrorTexture('boardMirror', { ratio: 0.5 }, scene, true);
    // Plane equation -y + BOARD_Y = 0, i.e. the board top, facing up.
    mirror.mirrorPlane = new BABYLON.Plane(0, -1, 0, BOARD_Y);
    mirror.adaptiveBlurKernel = 16;   // a soft, slightly blurred reflection
    mirror.level = 1.8;               // the RTT isn't tone mapped; lift it to match
    mirror.renderList = [];

    const mat = new BABYLON.StandardMaterial('glossSheet', scene);
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = new BABYLON.Color3(0.9, 0.9, 0.9);
    mat.specularPower = 256;
    mat.reflectionTexture = mirror;
    // Mostly see-through: only the reflection and the glint stay opaque.
    mat.alpha = 0.12;
    mat.useReflectionOverAlpha = true;
    mat.useSpecularOverAlpha = true;
    const fresnel = new BABYLON.FresnelParameters();
    fresnel.bias = 0.6;
    fresnel.power = 1.5;
    fresnel.leftColor = BABYLON.Color3.White();
    fresnel.rightColor = new BABYLON.Color3(0.5, 0.5, 0.5);
    mat.reflectionFresnelParameters = fresnel;

    const size = 8 * Config.SQUARE;
    sheet = BABYLON.MeshBuilder.CreateGround('glossSheet', { width: size, height: size }, scene);
    sheet.position.y = BOARD_Y + 0.0015;   // under the move markers (+0.003 and up)
    sheet.material = mat;
    sheet.isPickable = false;
    sheet.alphaIndex = 0;                  // drawn before the transparent markers
    if (glow) glow.addExcludedMesh(sheet);

    // Rebuild the mirror's list only when a piece's proxy/reflection changed
    // (CharacterBase.proxyEpoch) or the set of pieces changed. A live piece
    // contributes all its meshes, enabled or not (the mirror skips disabled
    // ones by itself), so its parts toggling on and off mid-animation needs
    // no rebuild.
    let lastCount = -1;
    observer = scene.onBeforeRenderObservable.add(() => {
      const CB = window.Chess3D.CharacterBase;
      if (CB.proxyEpoch === lastEpoch && pieces.byId.size === lastCount) return;
      lastEpoch = CB.proxyEpoch;
      lastCount = pieces.byId.size;
      const list = mirror.renderList;
      list.length = 0;
      const pool = window.Chess3D.InstancePool;
      if (pool) pool.reflectionMeshes().forEach((m) => list.push(m));
      for (const ch of pieces.byId.values()) {
        if (!ch.alive || !ch.getReflectionMeshes) continue;
        const live = !ch._pooled && !ch._proxy;
        const meshes = live ? ch.root.getChildMeshes(false).filter((m) => m.material) : ch.getReflectionMeshes();
        meshes.forEach((m) => {
          // A live (animating) piece's PBR parts would recompute their shader
          // defines on every pass switch: draw them unlit in the mirror. Set
          // once per mesh; re-setting it every frame forces the same recompute.
          if (live && m.material !== CB._reflMat) {
            const standIn = cheapMaterial(m.material);
            if (m.__mirrorStandIn !== standIn) {
              mirror.setMaterialForRendering(m, standIn);
              m.__mirrorStandIn = standIn;
            }
          }
          list.push(m);
        });
      }
    });
  }

  // Unlit stand-ins for the mirror pass, one per base colour.
  const cheapCache = new Map();
  function cheapMaterial(src) {
    const base = src.albedoColor || src.diffuseColor || BABYLON.Color3.Gray();
    const em = src.emissiveColor || BABYLON.Color3.Black();
    const col = new BABYLON.Color3(Math.min(1, base.r + em.r), Math.min(1, base.g + em.g), Math.min(1, base.b + em.b));
    const key = col.toHexString();
    let mat = cheapCache.get(key);
    if (!mat || mat.isDisposed) {
      mat = new BABYLON.StandardMaterial('mirrorStandIn_' + key, scene);
      mat.disableLighting = true;
      mat.diffuseColor = BABYLON.Color3.Black();
      mat.specularColor = BABYLON.Color3.Black();
      mat.emissiveColor = col;
      mat.backFaceCulling = false;
      cheapCache.set(key, mat);
    }
    return mat;
  }

  function dispose() {
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    observer = null;
    if (sheet) { sheet.material.dispose(); sheet.dispose(); }
    if (mirror) mirror.dispose();
    cheapCache.forEach((m) => m.dispose());
    cheapCache.clear();
    scene.meshes.forEach((m) => { if (m.__mirrorStandIn) m.__mirrorStandIn = null; });
    sheet = null; mirror = null; lastEpoch = -1;
  }

  const BoardGloss = {
    init(sceneArg, opts) {
      scene = sceneArg;
      pieces = opts.pieces;
      glow = opts.glow || null;
    },
    setEnabled(on) {
      on = !!on;
      if (on === enabled || !scene) return;
      enabled = on;
      window.Chess3D.CharacterBase.reflections = on;  // idle pieces build/drop their reflection mesh
      if (window.Chess3D.InstancePool) window.Chess3D.InstancePool.setReflections(on);
      if (on) build(); else dispose();
    },
    isEnabled() { return enabled; }
  };

  window.Chess3D.BoardGloss = BoardGloss;
})();
