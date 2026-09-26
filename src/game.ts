import * as THREE from "three";
import { AudioEngine } from "./audio";
import { createInitialBalls, initialLayout, markRestored, syncBallMesh } from "./balls";
import { CPU_LEVELS, applyShot, computeAiShot, planAiShot, type AiShot, type CpuLevel } from "./ai";
import { PlayerControls } from "./controls";
import { PhysicsWorld } from "./physics";
import { SnookerRules } from "./rules";
import { loadTableModel } from "./table";
import { createEnvironment, createPostFX, setupLights, type PostFX } from "./render";
import { BALL_HEX, BALL_VALUES, COLOR_ORDER, ballCentreY, type BallColor } from "./constants";
import { applyFrame, clearFrame, saveFrame, type FrameSave } from "./save";
import { recordFrame } from "./stats";

type Phase = "idle" | "simulating" | "resolving" | "ai_thinking";

export class Game {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: PlayerControls;
  world: PhysicsWorld;
  rules: SnookerRules;
  audio = new AudioEngine();
  phase: Phase = "idle";

  private timer = new THREE.Timer();
  private fx: PostFX;
  private pocketedBuffer: ReturnType<typeof createInitialBalls> = [];
  private firstContact: (typeof this.world.balls)[0] | null = null;
  private cuePocketed = false;
  private messageTimer = 0;
  private targetTimer = 0;
  private pendingAiShot: AiShot | null = null;
  /** CPU shot being planned (Pro spreads its look-ahead over frames). */
  private aiPlanner: Generator<void, AiShot, void> | null = null;
  /** CPU strength, from the settings card. */
  cpuLevel: CpuLevel = 1;
  private aiDelay = 0;
  /** Touch hint shows until the player's first touch shot. */
  private touchHintSeen = false;

  private el = {
    playerScore: document.querySelector("#score-player") as HTMLElement,
    aiScore: document.querySelector("#score-ai") as HTMLElement,
    playerRow: document.querySelector("#row-player") as HTMLElement,
    aiRow: document.querySelector("#row-ai") as HTMLElement,
    powerWrap: document.querySelector("#power-wrap") as HTMLElement,
    powerFill: document.querySelector("#power-fill") as HTMLElement,
    message: document.querySelector("#message") as HTMLElement,
    breakScore: document.querySelector("#break-score") as HTMLElement,
    lockHint: document.querySelector("#lock-hint") as HTMLElement,
    touchShot: document.querySelector("#touch-shot") as HTMLElement,
    fineToggle: document.querySelector("#fine-toggle") as HTMLElement,
    touchFill: document.querySelector("#touch-shot .ts-fill") as HTMLElement,
    touchKnob: document.querySelector("#touch-shot .ts-knob") as HTMLElement,
    frameOver: document.querySelector("#frame-over") as HTMLElement,
    frameOverTitle: document.querySelector("#frame-over .fo-title") as HTMLElement,
    frameOverScore: document.querySelector("#frame-over .fo-score") as HTMLElement,
    frameOverBest: document.querySelector("#frame-over .fo-best") as HTMLElement,
    targetBanner: document.querySelector("#target-banner") as HTMLElement,
    onBall: document.querySelector("#on-ball") as HTMLElement,
    onBallDots: document.querySelector("#on-ball .ob-dots") as HTMLElement,
    onBallName: document.querySelector("#on-ball .ob-name") as HTMLElement,
    targetLabel: document.querySelector("#target-banner .tb-label") as HTMLElement,
    targetDots: document.querySelector("#target-banner .tb-dots") as HTMLElement,
    targetName: document.querySelector("#target-banner .tb-name") as HTMLElement,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    // Phones: cap the render resolution — full DPR costs a lot of fill rate.
    const coarse = matchMedia("(pointer: coarse)").matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Soft filtered shadows from the near-vertical key light (bias tuned in render.ts).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0908);
    this.scene.environment = createEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.6;

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.05,
      50,
    );

    setupLights(this.scene);
    this.fx = createPostFX(this.renderer, this.scene, this.camera);
    loadTableModel((table) => this.scene.add(table));

    const balls = createInitialBalls();
    for (const b of balls) {
      this.scene.add(b.mesh);
      this.scene.add(b.shadow);
    }

    this.world = new PhysicsWorld(balls);
    this.rules = new SnookerRules();
    this.controls = new PlayerControls(this.camera, canvas);
    this.scene.add(this.controls.cueGroup);
    this.scene.add(this.controls.aimTargetMarker);
    this.scene.add(this.controls.aimGuideLine);

    this.controls.setShotHandler((dir, power) => this.playerShoot(dir, power));

    window.addEventListener("resize", () => this.onResize());
    this.refreshScores();
  }

  /** Start a new frame, or resume `save` (a frame stored after an earlier shot). */
  start(save?: FrameSave | null): void {
    if (save && applyFrame(save, this.world, this.rules)) {
      this.showMessage("Frame resumed");
    } else {
      clearFrame();
    }
    this.audio.resume();
    this.controls.applyDefaultView();
    this.timer.reset();
    this.renderer.setAnimationLoop(() => this.frame());
    this.setIdleForCurrentPlayer();
  }

  get isFrameOver(): boolean {
    return this.rules.frameOver;
  }

  /** Result card with a "New frame" button (pointer unlocked so it can be clicked). */
  private showFrameOver(winner: "player" | "ai" | null): void {
    this.el.frameOverTitle.textContent =
      winner === "player" ? "You win the frame!" : winner === "ai" ? "CPU wins the frame" : "Frame drawn";
    this.el.frameOverScore.textContent = `YOU ${this.rules.scores.player} – ${this.rules.scores.ai} CPU`;
    this.el.frameOver.classList.toggle("won", winner === "player");
    const { best, isNew } = recordFrame(this.rules.scores.player, this.cpuLevel);
    this.el.frameOverBest.classList.toggle("new", isNew);
    this.el.frameOverBest.textContent = isNew
      ? `New best frame: ${best!.points} pts!`
      : best
        ? `Best frame: ${best.points} pts · vs ${CPU_LEVELS.find((l) => l.level === best.level)!.name}`
        : "";
    this.el.message.classList.remove("show");
    this.messageTimer = 0;
    this.el.onBall.hidden = true;
    // Let the crowd reaction / last message land before the card appears.
    window.setTimeout(() => {
      if (!this.rules.frameOver) return;
      this.el.frameOver.classList.add("show");
      if (document.pointerLockElement) document.exitPointerLock();
    }, 1200);
  }

  /** Re-rack and start a fresh frame in place (no page reload). */
  newFrame(): void {
    clearFrame();
    const layout = new Map(initialLayout().map((l) => [l.id, l]));
    const y = ballCentreY();
    for (const b of this.world.balls) {
      const l = layout.get(b.id);
      if (!l) continue;
      b.position.set(l.x, y, l.z);
      b.velocity.set(0, 0, 0);
      b.angularVelocity.set(0, 0, 0);
      b.pocketed = false;
      b.needsRespot = false;
      markRestored(b);
    }
    this.rules = new SnookerRules();
    this.pendingAiShot = null;
    this.aiPlanner = null;
    this.el.frameOver.classList.remove("show");
    this.el.message.classList.remove("show");
    this.messageTimer = 0;
    this.controls.applyDefaultView();
    this.setIdleForCurrentPlayer();
    this.showMessage("New frame");
  }

  /** Mute / unmute all sound. Returns the new enabled state. */
  toggleSound(): boolean {
    return this.audio.toggle();
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.fx.setSize(window.innerWidth, window.innerHeight);
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);

    if (this.phase === "simulating") {
      const result = this.world.step(dt);
      if (result.firstContact && !this.firstContact) {
        this.firstContact = result.firstContact;
      }
      for (const b of result.pocketed) {
        if (!this.pocketedBuffer.includes(b)) this.pocketedBuffer.push(b);
      }
      if (result.cuePocketed) this.cuePocketed = true;

      this.playCollisionSounds(result);

      if (this.world.isSettled()) {
        this.phase = "resolving";
        this.resolve();
      }
    } else if (this.phase === "ai_thinking") {
      this.aiDelay -= dt;
      this.advanceAiPlan();
      // Shoot once the "thinking" pause is over and the plan is ready.
      if (this.aiDelay <= 0 && this.pendingAiShot) this.executeAiShot();
    }

    const cue = this.world.balls.find((b) => b.color === "cue");
    this.controls.update(
      dt,
      cue,
      this.phase === "simulating",
      this.world.balls,
      this.phase === "ai_thinking",
    );
    for (const b of this.world.balls) syncBallMesh(b, dt);
    this.audio.setListener(this.camera);

    const aiming = this.controls.mode === "aim" && this.controls.canShoot;
    this.el.lockHint.classList.toggle(
      "show",
      this.controls.needsPointerLock || (this.controls.touchMode && aiming && !this.touchHintSeen),
    );

    // Power UI
    if (aiming) {
      this.el.powerWrap.classList.add("visible");
      this.el.powerFill.style.width = `${this.controls.power * 100}%`;
    } else {
      this.el.powerWrap.classList.remove("visible");
    }
    this.el.touchShot.classList.toggle("visible", aiming);
    this.el.fineToggle.classList.toggle("visible", aiming);
    this.el.touchFill.style.height = `${this.controls.power * 100}%`;
    this.el.touchKnob.style.top = `${this.controls.power * 100}%`;

    if (this.targetTimer > 0) {
      this.targetTimer -= dt;
      if (this.targetTimer <= 0) this.el.targetBanner.classList.remove("show");
    }

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.el.message.classList.remove("show");
    }

    this.fx.render(dt);
  }

  /**
   * Turn physics collision events into sound. Only the loudest couple of each
   * kind per frame are played so a big scatter can't stack into clipping/buzz.
   */
  private playCollisionSounds(result: ReturnType<PhysicsWorld["step"]>): void {
    if (!this.audio.enabled) return;

    if (result.ballImpacts.length) {
      result.ballImpacts.sort((a, b) => b.speed - a.speed);
      for (const hit of result.ballImpacts.slice(0, 3)) {
        this.audio.ballClick(hit.speed, hit.x, hit.z);
      }
    }
    if (result.cushionImpacts.length) {
      result.cushionImpacts.sort((a, b) => b.speed - a.speed);
      for (const hit of result.cushionImpacts.slice(0, 2)) {
        this.audio.cushion(hit.speed, hit.x, hit.z);
      }
    }
    for (const hit of result.pocketImpacts) this.audio.pocket(hit.speed, hit.x, hit.z);
  }

  private playerShoot(dir: THREE.Vector3, power: number): void {
    if (this.phase !== "idle" || this.rules.current !== "player") return;
    const cue = this.world.balls.find((b) => b.color === "cue" && !b.pocketed);
    if (!cue) return;
    if (this.controls.touchMode) this.touchHintSeen = true;
    this.audio.cueStrike(power, cue.position.x, cue.position.z);
    applyShot(cue, dir, power);
    this.beginSimulation(false);
  }

  private executeAiShot(): void {
    const shot = this.pendingAiShot ?? computeAiShot(this.world, this.rules, this.cpuLevel);
    this.pendingAiShot = null;
    this.aiPlanner = null;
    const cue = this.world.balls.find((b) => b.color === "cue" && !b.pocketed);
    if (!cue) {
      this.setIdleForCurrentPlayer();
      return;
    }
    this.controls.setAiAim(shot.direction, shot.power);
    this.audio.cueStrike(shot.power, cue.position.x, cue.position.z);
    applyShot(cue, shot.direction, shot.power);
    this.showMessage("Opponent shoots…");
    this.beginSimulation(true);
  }

  private beginSimulation(followAction: boolean): void {
    this.phase = "simulating";
    this.controls.enabled = true;
    this.controls.onShotStarted({ follow: followAction });
    this.pocketedBuffer = [];
    this.firstContact = null;
    this.cuePocketed = false;
  }

  private resolve(): void {
    this.world.stopAll();
    const breakBefore = this.rules.breakScore;
    const resolution = this.rules.resolveShot(
      this.world,
      this.pocketedBuffer,
      this.firstContact,
      this.cuePocketed,
    );

    this.showMessage(resolution.message);
    this.refreshScores();
    this.crowdReaction(resolution, breakBefore);
    // Balls are at rest and the shot is resolved: a clean point to resume from.
    if (resolution.frameOver) clearFrame();
    else saveFrame(this.world, this.rules);

    if (resolution.frameOver) {
      this.phase = "idle";
      this.controls.setCanShoot(false);
      this.showFrameOver(resolution.winner);
      return;
    }

    this.setIdleForCurrentPlayer();
  }

  /** One planning step per frame; when the plan is done, show the CPU's aim. */
  private advanceAiPlan(): void {
    if (!this.aiPlanner || this.pendingAiShot) return;
    const r = this.aiPlanner.next();
    if (!r.done) return;
    this.aiPlanner = null;
    this.pendingAiShot = r.value;
    this.controls.setAiAim(r.value.direction, r.value.power);
  }

  /** Applause for high-value pots, break milestones and the frame result. */
  private crowdReaction(r: ReturnType<SnookerRules["resolveShot"]>, breakBefore: number): void {
    if (r.frameOver) {
      this.audio.applause(1);
      return;
    }
    if (r.foul || r.scored <= 0) return;
    const now = this.rules.breakScore;
    const milestone = [100, 50, 30].find((m) => breakBefore < m && now >= m);
    if (milestone) this.audio.applause(milestone >= 100 ? 0.95 : milestone >= 50 ? 0.7 : 0.45);
    // Every legal pot earns a ripple; higher-value balls a little more.
    else this.audio.applause(0.1 + 0.04 * Math.min(7, r.scored));
  }

  /**
   * Show the next legal ball(s) big in the middle of the screen for a few
   * seconds, and keep them in the scoreboard's "On" row until the next turn.
   */
  private showTargetBanner(): void {
    const target = this.rules.expectedTarget(this.world.balls);
    this.el.onBall.hidden = target === "—";
    if (target === "—") return;
    const colours: BallColor[] =
      target === "any colour" ? COLOR_ORDER.slice() : [target as BallColor];
    const dots = (cls: string) =>
      colours.map((c) => {
        const dot = document.createElement("span");
        dot.className = cls;
        dot.style.background = `#${BALL_HEX[c].toString(16).padStart(6, "0")}`;
        return dot;
      });
    this.el.targetLabel.textContent =
      this.rules.current === "player" ? "Your turn" : "Opponent's turn";
    this.el.targetDots.replaceChildren(...dots("tb-ball"));
    this.el.targetDots.classList.toggle("many", colours.length > 1);
    const value = colours.length === 1 ? BALL_VALUES[colours[0] as Exclude<BallColor, "cue">] : 0;
    const name = value ? `${target} · ${value} pt${value > 1 ? "s" : ""}` : target;
    this.el.targetName.textContent = name;
    this.el.targetBanner.classList.add("show");
    this.targetTimer = 2.8;

    this.el.onBallDots.replaceChildren(...dots("ob-ball"));
    this.el.onBallName.textContent = name;
  }

  private setIdleForCurrentPlayer(): void {
    this.phase = "idle";
    this.showTargetBanner();
    if (this.rules.current === "player") {
      this.controls.setCanShoot(true);
      this.controls.enabled = true;
    } else {
      this.controls.setCanShoot(false);
      this.phase = "ai_thinking";
      this.pendingAiShot = null;
      this.aiPlanner = planAiShot(this.world, this.rules, this.cpuLevel);
      this.advanceAiPlan();
      this.aiDelay = 1.1 + Math.random() * 0.8;
    }
    this.refreshScores();
  }

  private refreshScores(): void {
    this.el.playerScore.textContent = String(this.rules.scores.player);
    this.el.aiScore.textContent = String(this.rules.scores.ai);
    this.el.playerRow.classList.toggle("active", this.rules.current === "player");
    this.el.aiRow.classList.toggle("active", this.rules.current === "ai");
    this.el.breakScore.textContent =
      this.rules.breakScore > 0 ? `Break: ${this.rules.breakScore}` : "";
  }

  private showMessage(text: string, seconds = 2.4): void {
    this.el.message.textContent = text;
    this.el.message.classList.add("show");
    this.messageTimer = seconds;
  }
}
