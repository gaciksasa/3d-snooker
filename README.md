# 3D Snooker

Browser snooker game built with [Three.js](https://threejs.org/) and TypeScript.

## Features

- Full-size table to WPBSA proportions (playing area **3569 × 1778 mm**)
- **22 balls**: 15 reds + yellow, green, brown, blue, pink, black + cue ball (Ø 52.5 mm)
- Aim the cue, charge power, and shoot (aim line shows the cue-ball and object-ball paths)
- Custom physics engine (no physics library): substeps at 480 Hz or more,
  ball–ball contacts rewound to the exact moment of impact, cushion jaws and
  pocket wells measured from the table model — open 45° jaws at every pocket
- Simplified WPBSA-style rules (red/colour alternating, then colours in order)
- Software opponent with three levels (chosen on the start screen or in Settings ⚙, remembered):
  **Amateur** (aims by eye), **Club** (checks the pot line, aims for the middle
  of the pocket, plays safe when stuck), **Pro** (simulates its best shots with
  the real physics and plays for position)
- Scoreboard shows the score, current break, CPU level and an **On** row with
  the ball(s) to play, so the target is always visible after the turn banner fades
- Best frame per CPU level: the most points you've scored in a finished frame
  against Amateur, Club and Pro is kept separately; all three show on the start
  screen and in the **Best frames** card (🏆 / `B`, with dates), and the
  end-of-frame card compares with the level's record; a frame counts for the
  easiest level used during it
- Frame auto-save: after every shot the position and score are stored in
  `localStorage`; the start screen offers **Continue frame** or **New frame**
- PBR graphics: procedural baize / mahogany / ash textures, lacquered balls with
  environment reflections, canopy area light, soft shadows, bloom + vignette,
  visible ball roll (dotted cue ball) and pot drop animation
- Mobile: touch controls, a lighter render profile (smaller shadow map, 2× MSAA,
  no bloom) and resolution that steps down automatically if the frame rate stays low;
  physics runs on real time, so slow devices drop frames instead of slowing down
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
| `B` | Show / hide best frames |
| `M` | Sound on / off |
| `F` | Full screen on / off |

### Touch (phones / tablets)

| Gesture | Action |
|---------|--------|
| Drag one finger | Swing the cue round the ball (up / down raises the butt) |
| **Fine** button | Slower aim for long pots |
| Power slider (right edge) | Pull down for power, release to shoot — push back up to cancel |
| Two fingers | Pinch to zoom · drag to look around |

Touch controls switch on automatically on touch devices; landscape gives the widest view.

**Full screen on mobile:** on Android and iPad the game goes full screen (and
locks landscape where allowed) when you tap **Start frame**; the ⛶ button
toggles it. iPhone Safari has no full-screen mode for web pages, so there use
**Share → Add to Home Screen** and open the game from the home screen — the web
manifest makes it launch without browser bars.

## Run

```bash
npm install
npm run dev       # dev server
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build
```

## Deploy

The build is a plain static site — no backend, no database. Upload the
**contents** of `dist/` to the web root of a domain or subdomain (it expects to
be served from `/`). `dist/.htaccess` (from `public/`) forces HTTPS and sets
compression and caching on Apache hosts. `index.html` carries Open Graph /
Twitter tags pointing at `og-image.jpg` for link previews.

## Rules (implemented)

- Pot a **red** (1 pt), then any **colour** (colour is respotted)
- Repeat until all reds are gone
- Then pot colours in order: yellow (2) → green (3) → brown (4) → blue (5) → pink (6) → black (7)
- Fouls award points to the opponent (cue ball pot, wrong first contact, wrong pot, miss)
- Foul value is the highest value of the balls involved (ball on, ball hit first,
  any ball potted), with a minimum of **4** — also on in-offs and wrong first contacts
- On a colour there is no nomination: the colour hit first is the ball on, so
  potting a different colour is a foul
- Respotting: a colour goes on its own spot if free; otherwise on the highest
  available spot, highest-value colour first
- Cue ball fouls return the cue ball in the **D**

### Simplifications

- A foul on the final black respots it instead of ending the frame
- A tied score after the final black is a draw (no re-spotted black)
