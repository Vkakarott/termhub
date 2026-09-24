# Office: pixel-art stations, walls, plaques, lamps and wall furniture

How the office's building floor is dressed. Builds on the city by project
(`2026-09-24-city-by-project-design.md`): one building per project, one floor per building.

## Art sheets (`apps/web/src/office/pack/art/`, `pack/art.ts`)

- Every sheet is a **512×512 PNG** on a transparent canvas, all drawn at the same scale:
  `DESK_ART_SIZE` on-screen pixels for the whole canvas (`ART_CANVAS = 512`).
- `ART_URLS` maps a sprite key to its file; `OfficeScene.loadArt()` decodes them into
  nearest-neighbour textures after the generated pack. A sheet that fails to decode is left out
  and whatever needs it falls back (a desk to the generated pack, a piece of furniture to nothing).
- **Layers of one desk share one canvas.** Desk, display and agent are cut from the same
  composition, so stacking them with one anchor (`STATION_ANCHOR`) lines them up. Draw order:
  desk → display → agent (agent last, or the desk covers the person).
- File names: `h` / `v` is the side a piece faces (see *Walls* below); `on` / `off` is the screen.

## Desks (`scene/PersonView.ts`)

`DeskView` uses the art when the desk sheets are loaded, otherwise the generated pack:

| seat | layers |
| --- | --- |
| a person at the desk | `desk/side-v-2` + `display/v-2` + `agent/side-v` |
| free (or a phone tab) | `desk/side-h` + `chair/h` |

The keys point to `desk-v-off-2`, `display-v-on-2`, `agent-v`, `desk-notebook-h-off` and
`chair-empty-h` for now. The agent variants (`agent-h*`, `agent-v-2/3`) and the other desks
(`desk-h-on`, `desk-notebook-v`, `notebook-on-h`) ship but are not wired yet.

## Floor and walls (`scene/RoomView.ts`, `layout/iso.ts`)

- `layoutRoom` sizes the floor, then grows one tile on its shorter side and re-centres the desks,
  so a building always has a clear strip along its walls (desks may sit on half tiles).
- `drawFloor` paints thick back walls (outer face, end cap, top, inner face, base trim) and a soft
  tile field (`tileTone`: low-frequency tonal drift, no checkerboard). Unlit keeps the same shapes
  at a lower exposure; the lamp carries the on/off cue. `drawBlock` paints the pavement the same way.

## Wall plaque and lamp (`scene/wallPlaque.ts`, `scene/RoomLamp.ts`)

- `RoomWallPlaque`: the building's name, framed and skewed onto the right part of the back wall
  (`WALL_SKEW` = the iso shear of that wall).
- `RoomLamp`: a lantern on the back wall near the corner. Lit, it paints a warm wash on the back
  wall, wraps it onto the left wall at the corner, and fans it onto the floor.

## Wall furniture (`scene/RoomRacks.ts`)

**Walls.** The *back* wall runs along gx (`gy = origin.gy`) and holds the lamp and the plaque; the
*side* wall runs along gy (`gx = origin.gx`). `h` sheets face +gy and stand on the back wall; `v`
sheets face +gx and stand on the side wall.

**Which pieces** (`pickRacks`, by the building's terminal count):

| terminals | pieces |
| --- | --- |
| 1 | none |
| 2 | `rack/h` (low cabinet) |
| 3 | `rack/v-2` (glass cabinet) or `rack/h-2` (bookshelf) |
| 4 | `rack/v` (server rack) + `rack/h` or `rack/h-2` |
| 5+ | all four, in random order |

"Random" is seeded by the building id (FNV-1a + LCG), so a building keeps its furniture across
rebuilds.

**Where** (`placeRacks`). Each sheet's footprint is measured once in `RACK_ART`: `foot` is the
footprint's bottom corner on the sheet, `alongGx` / `alongGy` the sheet pixels from it to the left
and right extremes; `sheetToTiles` turns them into tiles. The sprite is anchored at `foot` and
placed at the footprint's bottom corner on the grid, so its back edge touches the wall.

- Back pieces fill the free runs of the back wall: corner → lamp, then lamp → plaque.
- Side pieces run down the side wall, starting past the deepest back piece, so the two walls never
  meet in the corner.
- A piece with no room left is dropped rather than drawn over the lamp, the plaque or a neighbour.

**Depth.** Pieces sort with the desks by `depthOf` their footprint centre, but never below the
lamp's `zIndex` (+0.01): the lamp's wash is painted on the wall *behind* the furniture, not over it.
A test pins that the nearest desk still sorts above that floor.

## Adding a sheet

1. Export at 512×512, same scale as the others, transparent background.
2. Add it to `ART_URLS`.
3. Furniture only: measure `foot`, `alongGx` and `alongGy` on the sheet (bottom-most opaque pixels
   for `foot`, left/right extremes for the others) and add it to `RACK_ART` with its wall.
