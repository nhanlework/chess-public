(function () {
  const Config = {
    SQUARE: 1,                                   // world units per square
    BOARD_Y: 0,                                  // top surface of squares
    PIECE_HEIGHT: { p: 0.75, n: 1.05, b: 1.15, r: 1.0, q: 1.1, k: 1.2 },
    CHARACTER_NAMES: { p: 'Soldier', n: 'Knight', b: 'Bishop', r: 'Golem', q: 'Queen', k: 'King' },
    TEAM: {
      w: { armor: '#d9dde6', cloth: '#2f5fb3', accent: '#d4a640', glow: '#6fb4ff', skin: '#e8c4a8', stone: '#c9c3b8' },
      b: { armor: '#2b2b33', cloth: '#8a1c2b', accent: '#b87333', glow: '#ff4a3d', skin: '#c99b7b', stone: '#3d3a3f' }
    },
    BOARD_COLORS: { light: '#e8dcc4', dark: '#4a3b33', frame: '#3a2718', trim: '#c9a24a' },
    HIGHLIGHT: { selected: '#ffd54a', move: '#5dff7a', moveRim: '#0b3d17', capture: '#ff4d4d', last: '#ffaa33', hover: '#ffffff', check: '#ff2020' },
    TIMING: {                                    // ms at animSpeed = 1
      walkPerSquare: 260, walkMin: 350, walkMax: 1100,
      leap: 650, turn: 180,
      cameraIn: 700, cameraOut: 800,
      attackWindup: 320, attackStrike: 200, attackRecover: 260,
      projectile: 450, death: 550, dissolve: 500,
      promotion: 1100, reconcileFade: 250,
      tornadoGather: 350, tornadoForm: 450,       // bishop's tornado: storm cloud gathers, then the funnel drops to the ground
      tornadoTravel: 800,                        // ms per unit travelled
      swept: 850, tornadoFade: 700                // victim whirled up inside it, then the funnel ropes out
    },
    CAMERA: {
      target: [0, 0.3, 0], alpha: -Math.PI / 2, beta: 0.82, radius: 13,
      lowerRadius: 6, upperRadius: 22, lowerBeta: 0.15, upperBeta: 1.45
    },
    // maxDpr: cap for scaling 'dpr'. ssaoSamples: SSAO2 sample count;
    // ssaoExpensiveBlur: SSAO2's bilateral blur (noticeably more GPU time).
    // smallMeshRadius: character meshes with a world bounding radius below this
    // skip the shadow map and the glow pass (0 = keep every mesh).
    // torchLitPieces: false scopes the 4 torch PointLights to the board only.
    QUALITY: {
      low:    { scaling: 1.5, shadows: 0,    ssao: false, bloom: false, dof: false, glowRatio: 0.25, particles: 0.4, fxaa: true,
                smallMeshRadius: 0.1, torchLitPieces: false },
      medium: { scaling: 1.0, shadows: 1024, ssao: false, bloom: true,  dof: false, glowRatio: 0.5,  particles: 0.7, fxaa: true,
                smallMeshRadius: 0.1, torchLitPieces: false },
      high:   { scaling: 'dpr', maxDpr: 1.75, shadows: 2048, ssao: true, ssaoSamples: 12, ssaoExpensiveBlur: false, bloom: true, dof: true, glowRatio: 0.5,
                particles: 1.0, fxaa: true, smallMeshRadius: 0.1, torchLitPieces: false },
      ultra:  { scaling: 'dpr', maxDpr: 2, shadows: 2048, ssao: true, ssaoSamples: 16, ssaoExpensiveBlur: true, bloom: true, dof: true, glowRatio: 0.5,
                particles: 1.0, fxaa: true, smallMeshRadius: 0, torchLitPieces: true }
    },
    DEFAULT_PREFS: { quality: null, cinematic: true, autoRotate: false, showCoords: true, animSpeed: 1, fps: 60, glossBoard: false, showFps: true, powerSaveIdle: false }
  };
  window.Chess3D = window.Chess3D || {};
  window.Chess3D.Config = Config;
})();
