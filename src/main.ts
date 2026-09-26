import "./style.css";
import { Game } from "./game";
import { loadFrame } from "./save";
import { CPU_LEVELS } from "./ai";
import { loadSettings, saveSettings } from "./settings";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <canvas id="game"></canvas>
  <div id="hud">
    <div id="scoreboard" class="panel" aria-label="Score">
      <div class="score-line">
        <span id="row-player" class="side active">You</span>
        <span id="score-player" class="pts">0</span>
        <span class="sep">–</span>
        <span id="score-ai" class="pts">0</span>
        <span id="row-ai" class="side" title="Computer opponent">CPU</span>
      </div>
      <div id="break-score"></div>
    </div>
    <div id="lock-hint">Click the table to aim freely · or use <kbd>←</kbd> <kbd>→</kbd></div>
    <div id="power-wrap">
      <div id="power-label">Power</div>
      <div id="power-bar"><div id="power-fill"></div></div>
    </div>
    <div id="hud-buttons">
      <button id="settings-toggle" class="icon-btn" type="button" title="Settings" aria-label="Show settings">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button id="controls-toggle" class="icon-btn" type="button" title="Controls (C)" aria-label="Show controls">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/></svg>
      </button>
      <button id="rules-toggle" class="icon-btn" type="button" title="Rules (H)" aria-label="Show rules">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>
      </button>
      <button id="sound-toggle" class="icon-btn" type="button" title="Sound (M)" aria-label="Toggle sound">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><g class="on"><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></g><g class="off"><path d="m16 9 6 6"/><path d="m22 9-6 6"/></g></svg>
      </button>
    </div>
    <div id="settings-card" class="panel info-card hidden">
      <div class="card-head">
        <h2>Settings</h2>
        <button class="card-close" type="button" aria-label="Close settings">✕</button>
      </div>
      <fieldset class="level-picker">
        <legend>CPU opponent</legend>
        <div id="cpu-levels"></div>
      </fieldset>
      <p class="settings-note">Applies from the CPU's next turn and is remembered.</p>
    </div>
    <div id="controls-card" class="panel info-card hidden">
      <div class="card-head">
        <h2>Controls</h2>
        <button class="card-close" type="button" aria-label="Close controls">✕</button>
      </div>
      <dl class="controls-list">
        <dt>Mouse</dt><dd>Aim the cue (click the table to lock the pointer)</dd>
        <dt><kbd>Shift</kbd> + mouse</dt><dd>Fine aim — 5× slower, for long pots</dd>
        <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Swing the cue round the ball (<kbd>Shift</kbd> = fine)</dd>
        <dt>Hold LMB</dt><dd>Charge power — release to shoot</dd>
        <dt>Hold RMB</dt><dd>Look around (view returns on release)</dd>
        <dt>Scroll · <kbd>+</kbd> <kbd>−</kbd></dt><dd>Zoom</dd>
        <dt>Black lines</dt><dd>Cue-ball path and the object ball's path</dd>
        <dt><kbd>C</kbd> <kbd>H</kbd> <kbd>M</kbd></dt><dd>Controls · rules · sound</dd>
        <dt><kbd>Esc</kbd></dt><dd>Close this card</dd>
      </dl>
    </div>
    <div id="rules-card" class="panel info-card hidden">
      <div class="card-head">
        <h2>How to play</h2>
        <button class="card-close" type="button" aria-label="Close rules">✕</button>
      </div>
      <p class="rules-sub">Simplified WPBSA snooker vs. an opponent.</p>
      <h3>Ball values</h3>
      <ul class="rules-vals">
        <li><span class="dot red"></span>Red — 1</li>
        <li><span class="dot yellow"></span>Yellow — 2</li>
        <li><span class="dot green"></span>Green — 3</li>
        <li><span class="dot brown"></span>Brown — 4</li>
        <li><span class="dot blue"></span>Blue — 5</li>
        <li><span class="dot pink"></span>Pink — 6</li>
        <li><span class="dot black"></span>Black — 7</li>
      </ul>
      <h3>Order of play</h3>
      <ul>
        <li>Pot a <b>red</b> (1 pt), then a <b>colour</b> of your choice.</li>
        <li>Potted colours are <b>re-spotted</b> while reds remain.</li>
        <li>Keep potting to continue your break; a miss ends your turn.</li>
        <li>When all reds are gone, pot the colours in order:
          yellow → green → brown → blue → pink → black. These <b>stay down</b>.</li>
      </ul>
      <h3>Fouls (min. 4 pts to opponent)</h3>
      <ul>
        <li>Potting the <b>cue ball</b>.</li>
        <li>Hitting or potting the <b>wrong ball</b> first.</li>
        <li>Hitting <b>no ball</b> at all.</li>
      </ul>
      <h3>Winning</h3>
      <ul>
        <li>Highest score once every ball is potted wins the frame.</li>
      </ul>
    </div>
    <div id="target-banner" aria-live="polite">
      <div class="tb-label"></div>
      <div class="tb-main"><span class="tb-dots"></span><span class="tb-name"></span></div>
    </div>
    <div id="message"></div>
    <div id="frame-over" class="panel" role="dialog" aria-label="Frame over">
      <div class="fo-title"></div>
      <div class="fo-score"></div>
      <button id="new-frame-btn" type="button">New frame</button>
      <div class="fo-hint">or press <kbd>Enter</kbd></div>
    </div>
  </div>
  <div id="overlay">
    <div class="card">
      <h1>3D Snooker</h1>
      <p>
        Full-size snooker table (3.569 × 1.778 m), 22 balls, WPBSA-style rules.
        Aim the cue ball, set your power, and play against an opponent.
      </p>
      <div class="overlay-actions">
        <button id="continue-btn" type="button" hidden>Continue frame</button>
        <button id="start-btn" type="button">Start frame</button>
      </div>
      <p id="save-info" class="save-info" hidden></p>
    </div>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const overlay = document.querySelector<HTMLDivElement>("#overlay")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start-btn")!;

const continueBtn = document.querySelector<HTMLButtonElement>("#continue-btn")!;
const saveInfo = document.querySelector<HTMLParagraphElement>("#save-info")!;

const game = new Game(canvas);

// A frame saved after an earlier shot can be resumed from the start screen.
const saved = loadFrame();
if (saved) {
  const { player, ai } = saved.rules.scores;
  const when = new Date(saved.savedAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  continueBtn.hidden = false;
  continueBtn.textContent = `Continue frame · ${player} – ${ai}`;
  startBtn.textContent = "New frame";
  startBtn.classList.add("secondary");
  saveInfo.hidden = false;
  saveInfo.textContent = `Saved ${when}. Starting a new frame discards it.`;
}

continueBtn.addEventListener("click", () => {
  overlay.classList.add("hidden");
  game.start(saved);
});
startBtn.addEventListener("click", () => {
  overlay.classList.add("hidden");
  game.start(null);
});

const soundBtn = document.querySelector<HTMLButtonElement>("#sound-toggle")!;
const refreshSoundBtn = (on: boolean) => {
  soundBtn.classList.toggle("muted", !on);
  soundBtn.setAttribute("aria-pressed", String(!on));
};
soundBtn.addEventListener("click", () => refreshSoundBtn(game.toggleSound()));

// CPU level picker (Settings card)
const settings = loadSettings();
game.cpuLevel = settings.cpuLevel;
const levelsBox = document.querySelector<HTMLDivElement>("#cpu-levels")!;
for (const l of CPU_LEVELS) {
  const label = document.createElement("label");
  label.className = "level-option";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "cpu-level";
  input.value = String(l.level);
  input.checked = l.level === settings.cpuLevel;
  input.addEventListener("change", () => {
    settings.cpuLevel = l.level;
    game.cpuLevel = l.level;
    saveSettings(settings);
  });
  const text = document.createElement("span");
  const name = document.createElement("b");
  name.textContent = l.name;
  const blurb = document.createElement("small");
  blurb.textContent = l.blurb;
  text.append(name, blurb);
  label.append(input, text);
  levelsBox.append(label);
}

/** Settings / controls / rules cards: at most one open, each toggled by its icon button. */
const cards = {
  settings: {
    btn: document.querySelector<HTMLButtonElement>("#settings-toggle")!,
    card: document.querySelector<HTMLDivElement>("#settings-card")!,
  },
  controls: {
    btn: document.querySelector<HTMLButtonElement>("#controls-toggle")!,
    card: document.querySelector<HTMLDivElement>("#controls-card")!,
  },
  rules: {
    btn: document.querySelector<HTMLButtonElement>("#rules-toggle")!,
    card: document.querySelector<HTMLDivElement>("#rules-card")!,
  },
};
type CardName = keyof typeof cards;
const toggleCard = (name: CardName | null) => {
  for (const [key, { btn, card }] of Object.entries(cards)) {
    const open = key === name && card.classList.contains("hidden");
    card.classList.toggle("hidden", !open);
    btn.classList.toggle("active", open);
  }
};
for (const [key, { btn, card }] of Object.entries(cards) as [CardName, (typeof cards)[CardName]][]) {
  btn.addEventListener("click", () => toggleCard(key));
  card.querySelector(".card-close")!.addEventListener("click", () => toggleCard(null));
}

const newFrameBtn = document.querySelector<HTMLButtonElement>("#new-frame-btn")!;
newFrameBtn.addEventListener("click", () => game.newFrame());

window.addEventListener("keydown", (e) => {
  if ((e.code === "Enter" || e.code === "NumpadEnter") && game.isFrameOver) game.newFrame();
  else if (e.code === "KeyM") refreshSoundBtn(game.toggleSound());
  else if (e.code === "KeyH") toggleCard("rules");
  else if (e.code === "KeyC") toggleCard("controls");
  else if (e.code === "Escape") toggleCard(null);
});
