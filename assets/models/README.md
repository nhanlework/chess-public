# Drop-in GLB characters / Nhân vật GLB thay thế

## English

Chess 3D can replace any built-in procedural character with your own animated
`.glb` model. Edit `assets/models/models.json`: any piece type left as `null`
keeps the built-in character; set it to an object to load a model instead.

### File requirements
- Format: `.glb` (glTF binary), one character per file.
- Must embed a skeleton and its animation clips (idle, walk, attack, ...).
- Keep it small: **≤ 5 MB per file**, textures **≤ 1024px**. Recommended
  compression: `npx @gltf-transform/cli optimize in.glb out.glb --texture-compress webp`.

### `models.json` entry schema
```json
{
  "p": {
    "file": "soldier.glb",
    "height": 0.75,
    "rotationY": 0,
    "yOffset": 0,
    "tint": false,
    "animations": {
      "idle": "Idle",
      "walk": "Walk",
      "attack": "Attack",
      "hit": "HitReact",
      "death": "Death",
      "victory": "Victory"
    },
    "impactAt": 0.5,
    "perTeam": { "w": { "file": "soldier_white.glb" }, "b": { "file": "soldier_black.glb" } }
  }
}
```
- `file`: path relative to `assets/models/` (e.g. `"knight/knight.glb"`).
- `height`: target world-space height in squares; the model is auto-scaled to
  match it. Omit it to use the built-in `Config.PIECE_HEIGHT` for that type.
- `rotationY`: extra rotation in degrees so the model faces +Z (the board's
  "forward" axis).
- `yOffset`: extra vertical adjustment (world units) after the model's feet
  are placed on top of the team base.
- `tint`: if `true`, every material on the model is recolored by multiplying
  its base color with the team's `cloth` color (see `js/3d/config3d.js`), so
  one shared model can still look different for White and Black.
- `animations`: maps the character's logical actions to the `AnimationGroup`
  names inside your file. Any action left out (or not found in the file)
  falls back to the built-in procedural animation for that action (e.g. no
  `walk` clip → the model just bobs while it slides across the board).
- `impactAt`: 0–1 fraction of the `attack` clip's duration at which the hit
  is considered to land (used to time damage/effects and to know when the
  clip is done "windup" and starts "recover").
- `perTeam`: optional; use a different file per team color (e.g. differently
  colored/rigged models) instead of the shared `tint` recolor.

### Where to find free characters (check each license yourself)
- **Quaternius** (quaternius.com), CC0: "Ultimate Animated Character Pack",
  "RPG Character Pack".
- **KayKit Adventurers / Skeletons** (kaylousberg.itch.io), CC0: animations
  sometimes ship in separate files — merge them in Blender first.
- **Mixamo** (needs a free Adobe account): download as FBX, import into
  Blender, then export as GLB with animations embedded.

### Finding animation names
Open your `.glb` at https://sandbox.babylonjs.com/ (drag & drop) and check the
Inspector's Animation Groups panel for the exact names to put under
`animations` above.

### Testing your setup
Open `index.html?debug=1` — the debug console logs every model's animation group
names as it loads, so you can confirm your `models.json` mapping is correct.
A model that fails to load (missing file, bad path, parse error) automatically
falls back to the built-in procedural character for that piece and shows a
warning — it never crashes the game.

There is also a dedicated sandbox for iterating on a single model without
touching the real `models.json`: `tests/browser/glb-sandbox.html`. Put your
test file under `assets/models/_test/` (git-ignored) and open the sandbox with
`?manifest=assets/models/_test/models.test.json` pointing at a temporary
manifest that only references that test file.

## Tiếng Việt (tóm tắt)

Bạn có thể thay nhân vật procedural mặc định bằng model `.glb` của riêng mình
bằng cách sửa `assets/models/models.json`: loại quân nào để `null` thì vẫn
dùng nhân vật procedural có sẵn; điền một object theo schema ở trên để dùng
model GLB.

Yêu cầu file: `.glb`, có sẵn skeleton + animation clip, dung lượng ≤ 5MB,
texture ≤ 1024px. Nguồn model miễn phí gợi ý: Quaternius (CC0), KayKit (CC0),
Mixamo (cần tài khoản Adobe, xuất FBX rồi convert sang GLB bằng Blender). Mở
file trên https://sandbox.babylonjs.com/ để xem tên các Animation Group cần
điền vào mục `animations`. Nếu model lỗi hoặc thiếu, game tự động dùng lại
nhân vật procedural và hiện cảnh báo, không bao giờ crash. Test nhanh 1 model
mà không đụng vào `models.json` thật: dùng
`tests/browser/glb-sandbox.html?manifest=<đường-dẫn-manifest-tạm>`.
