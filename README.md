# 3D Snooker

Browser snooker game built with [Three.js](https://threejs.org/) and TypeScript.

## Features

- Full-size table to WPBSA proportions (playing area **3569 × 1778 mm**)
- **22 balls**: 15 reds + yellow, green, brown, blue, pink, black + cue ball (Ø 52.5 mm)
- Aim the cue, charge power, and shoot (aim line shows the cue-ball and object-ball paths)
- Ball–ball and cushion physics, pockets
- Simplified WPBSA-style rules (red/colour alternating, then colours in order)
- Software opponent with three levels (chosen on the start screen or in Settings ⚙, remembered):
  **Amateur** (aims by eye), **Club** (checks the pot line, aims for the middle
  of the pocket, plays safe when stuck), **Pro** (simulates its best shots with
  the real physics and plays for position)
- Frame auto-save: after every shot the position and score are stored in
  `localStorage`; the start screen offers **Continue frame** or **New frame**
- PBR graphics: procedural baize / mahogany / ash textures, lacquered balls with
  environment reflections, canopy area light, soft shadows, bloom + vignette,
  visible ball roll (dotted cue ball) and pot drop animation
- Audio: recorded ball–ball clacks and crowd applause (CC0, see
  `public/sounds/CREDITS.md`), synthesised cue / cushion / pocket sounds, room
  reverb and stereo positioning relative to the camera

## Controls

| Input | Action |
|-------|--------|
| Mouse | Aim the cue (click the table to lock the pointer — that click never shoots) |
| `Shift` + mouse | Fine aim (5× slower) for long pots |
| `←` `→` | Swing the cue round the ball (`Shift` = fine) |
| Hold LMB | Charge power |
| Release LMB | Shoot |
| Hold RMB + mouse | Look around (view returns to the aim on release) |
| Mouse wheel / `+` `−` | Zoom |
| `C` | Show / hide controls (`Esc` closes) |
| `H` | Show / hide rules (`Esc` closes) |
| `M` | Sound on / off |

### Touch (phones / tablets)

| Gesture | Action |
|---------|--------|
| Drag one finger | Swing the cue round the ball (up / down raises the butt) |
| **Fine** button | Slower aim for long pots |
| Power slider (right edge) | Pull down for power, release to shoot — push back up to cancel |
| Two fingers | Pinch to zoom · drag to look around |

Touch controls switch on automatically on touch devices; landscape gives the widest view.

## Run

```bash
npm install
npm run dev       # dev server
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build
```

## Rules (implemented)

- Pot a **red** (1 pt), then any **colour** (colour is respotted)
- Repeat until all reds are gone
- Then pot colours in order: yellow (2) → green (3) → brown (4) → blue (5) → pink (6) → black (7)
- Fouls award points to the opponent (cue ball pot, wrong first contact, wrong pot, miss)
- Foul value is the highest value of the balls involved (ball on, ball hit first,
  balls wrongly potted), with a minimum of **4**
- Cue ball fouls return the cue ball in the **D**

### Simplifications

- A foul on the final black respots it instead of ending the frame
- A tied score after the final black is a draw (no re-spotted black)
