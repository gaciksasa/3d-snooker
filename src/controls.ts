import * as THREE from "three";
import { createAshTexture } from "./textures";
import { BALL, CONTROLS, TABLE, clampToRoom } from "./constants";
import type { BallState } from "./balls";
import { predictAimGuide } from "./aimPredict";

export type ControlMode = "walk" | "aim";

function defaultEyePosition(): THREE.Vector3 {
  return new THREE.Vector3(0, CONTROLS.eyeHeight, -TABLE.length / 2 - TABLE.cushionWidth - TABLE.railWidth - 0.55);
}

function defaultLookTarget(): THREE.Vector3 {
  return new THREE.Vector3(0, TABLE.clothY + 0.05, TABLE.length * 0.12);
}

/** Default aim faces the reds (toward +Z / top cushion). */
const DEFAULT_AIM_YAW = Math.PI;

export class PlayerControls {
  mode: ControlMode = "walk";
  enabled = true;
  canShoot = false;

  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;

  position = defaultEyePosition();
  yaw = 0;
  pitch = -0.45;

  aimYaw = DEFAULT_AIM_YAW;
  aimPitch = -0.06;
  aimDistance: number = CONTROLS.aimDistanceDefault;
  power = 0;
  charging = false;
  walkFov: number = CONTROLS.walkFovDefault;

  /**
   * Unit vector from cue-ball centre to the tip contact (always on cue axis).
   */
  private hitNormal = new THREE.Vector3(0, 0, -1);

  private keys = new Set<string>();
  private pointerLocked = false;
  /** Freeze camera while balls are in motion after a player shot. */
  private watchingShot = false;
  /** Smooth follow of table action (AI shots). */
  private spectateFollow = false;
  /** RMB: free-look without changing aim. */
  private lookingAround = false;
  private onShot: ((dir: THREE.Vector3, power: number) => void) | null = null;
  private spectateFocus = new THREE.Vector3();
  private spectateCam = new THREE.Vector3();

  cueGroup = new THREE.Group();
  /** Black: predicted first contact on an object ball or cushion. */
  aimTargetMarker: THREE.Mesh;
  /**
   * Two straight segments:
   * 1) cue centre → contact (white path)
   * 2) struck ball centre → finish (object path) / cue after cushion
   */
  aimGuideLine: THREE.LineSegments;
  private aimGuidePositions: Float32Array;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;

    this.buildCueMesh();
    this.cueGroup.visible = false;

    this.aimTargetMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.0035, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0x0a0a0a,
        transparent: true,
        opacity: 0.35,
        depthTest: true,
        depthWrite: false,
      }),
    );
    this.aimTargetMarker.visible = false;
    this.aimTargetMarker.renderOrder = 21;

    // 2 segments × 2 endpoints × 3 floats
    this.aimGuidePositions = new Float32Array(12);
    const guideGeo = new THREE.BufferGeometry();
    guideGeo.setAttribute("position", new THREE.BufferAttribute(this.aimGuidePositions, 3));
    guideGeo.setDrawRange(0, 4);
    this.aimGuideLine = new THREE.LineSegments(
      guideGeo,
      new THREE.LineBasicMaterial({
        color: 0x0a0a0a,
        transparent: true,
        opacity: 0.32,
        depthTest: true,
        depthWrite: false,
      }),
    );
    this.aimGuideLine.visible = false;
    this.aimGuideLine.renderOrder = 22;
    this.aimGuideLine.frustumCulled = false;

    this.bind();
    this.applyDefaultView();
  }

  /** Full-length tapered snooker cue (~1.45 m). Tip at local z≈0, butt at -cueLength. */
  private buildCueMesh(): void {
    const L = CONTROLS.cueLength;
    const rTip = CONTROLS.cueTipRadius;
    const rButt = CONTROLS.cueButtRadius;

    const ash = createAshTexture();
    const shaftMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: ash,
      roughness: 0.4,
      clearcoat: 0.5,
      clearcoatRoughness: 0.2,
    });
    const buttMat = new THREE.MeshPhysicalMaterial({
      color: 0x2a140a,
      roughness: 0.3,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
    const wrapMat = new THREE.MeshStandardMaterial({
      color: 0x151515,
      roughness: 0.85,
    });
    const ferruleMat = new THREE.MeshStandardMaterial({
      color: 0xc9b98a,
      roughness: 0.35,
      metalness: 0.8,
    });
    const chalkMat = new THREE.MeshStandardMaterial({
      color: 0x2f6fd8,
      roughness: 1,
    });

    const addSeg = (
      len: number,
      rTop: number,
      rBot: number,
      zCentre: number,
      mat: THREE.Material,
    ) => {
      const geo = new THREE.CylinderGeometry(rTop, rBot, len, 24);
      geo.rotateX(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      // Cylinder along Z after rotate; centre at zCentre (negative = toward butt)
      mesh.position.set(0, 0, zCentre);
      this.cueGroup.add(mesh);
    };

    // Tip chalk (at contact end, z ≈ 0)
    const chalk = new THREE.Mesh(new THREE.SphereGeometry(rTip * 0.95, 12, 10), chalkMat);
    chalk.position.set(0, 0, 0.001);
    this.cueGroup.add(chalk);

    // Ferrule
    const ferruleLen = 0.02;
    addSeg(ferruleLen, rTip, rTip * 1.15, -ferruleLen / 2, ferruleMat);

    // Maple shaft (~70% of length)
    const shaftLen = L * 0.62;
    const shaftStart = -ferruleLen;
    const shaftEnd = shaftStart - shaftLen;
    const rShaftEnd = rTip + (rButt - rTip) * 0.55;
    addSeg(shaftLen, rTip * 1.15, rShaftEnd, (shaftStart + shaftEnd) / 2, shaftMat);

    // Joint ring
    const jointLen = 0.018;
    addSeg(jointLen, rShaftEnd * 1.05, rShaftEnd * 1.08, shaftEnd - jointLen / 2, ferruleMat);

    // Butt + wrap
    const wrapLen = 0.28;
    const buttStart = shaftEnd - jointLen;
    const wrapEnd = buttStart - wrapLen;
    const rWrapEnd = rTip + (rButt - rTip) * 0.85;
    addSeg(wrapLen, rShaftEnd, rWrapEnd, (buttStart + wrapEnd) / 2, wrapMat);

    const buttEnd = -L;
    addSeg(Math.abs(wrapEnd - buttEnd), rWrapEnd, rButt, (wrapEnd + buttEnd) / 2, buttMat);

    // Butt cap
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(rButt * 0.92, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      buttMat,
    );
    cap.rotation.x = Math.PI / 2;
    cap.position.set(0, 0, -L);
    cap.castShadow = true;
    this.cueGroup.add(cap);
  }

  applyDefaultView(): void {
    this.mode = "walk";
    this.charging = false;
    this.power = 0;
    this.lookingAround = false;
    this.cueGroup.visible = false;
    this.aimTargetMarker.visible = false;
    this.aimGuideLine.visible = false;
    this.aimDistance = CONTROLS.aimDistanceDefault;
    this.aimYaw = DEFAULT_AIM_YAW;
    this.aimPitch = -0.06;
    this.resetHitToCentre();
    this.walkFov = CONTROLS.walkFovDefault;
    this.camera.fov = this.walkFov;
    this.camera.updateProjectionMatrix();

    this.position.copy(defaultEyePosition());
    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(defaultLookTarget());
    this.camera.rotation.order = "YXZ";
    this.yaw = this.camera.rotation.y;
    this.pitch = this.camera.rotation.x;
  }

  private resetHitToCentre(): void {
    this.syncHitToCueAxis();
  }

  /** Tip contact on the ball along the stick line through the centre. */
  private syncHitToCueAxis(): void {
    this.hitNormal.copy(this.getCueApproachDirection()).multiplyScalar(-1).normalize();
  }

  private syncWalkCamera(): void {
    this.camera.position.copy(this.position);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  setShotHandler(fn: (dir: THREE.Vector3, power: number) => void): void {
    this.onShot = fn;
  }

  private minTipClearanceY(): number {
    return TABLE.clothY + 0.012;
  }

  /** Top of cushion rail + clearance — shaft must stay above when over the outer wood. */
  private rimClearanceY(): number {
    return TABLE.height + 0.015;
  }

  /** True over the outer wooden rail (not the playing cloth / cushion nose). */
  private isOverWoodenRail(x: number, z: number): boolean {
    const halfW = TABLE.width / 2;
    const halfL = TABLE.length / 2;
    // Past the cushion body — only then force the cue above the rail top
    const past = TABLE.cushionWidth * 0.35;
    return Math.abs(x) > halfW + past || Math.abs(z) > halfL + past;
  }

  /**
   * Place full-length cue aiming at the hit point without clipping cloth or outer rails.
   * Near cushions the stick may overhang the nose — that is allowed so you can aim
   * from every side of the cue ball.
   */
  private placeCueTip(_cue: BallState, hitPoint: THREE.Vector3, shotDir: THREE.Vector3): void {
    const pullback = 0.02 + this.power * 0.45;
    const tipGap = 0.016 + pullback;
    const minY = this.minTipClearanceY();
    const rimY = this.rimClearanceY();
    const cueLen = CONTROLS.cueLength;

    // Keep tip on the horizontal shot axis (same as ball velocity / guide line)
    const flat = new THREE.Vector3(shotDir.x, 0, shotDir.z);
    if (flat.lengthSq() < 1e-12) flat.set(0, 0, 1);
    else flat.normalize();

    const tipPos = hitPoint.clone().addScaledVector(flat, -tipGap);
    tipPos.y = Math.max(hitPoint.y + 0.012 - this.aimPitch * 0.1, minY);

    for (let iter = 0; iter < 10; iter++) {
      this.cueGroup.position.copy(tipPos);
      this.cueGroup.lookAt(hitPoint);
      this.cueGroup.updateMatrixWorld(true);

      let lift = 0;
      for (let i = 0; i <= 24; i++) {
        const p = new THREE.Vector3(0, 0, (-cueLen * i) / 24).applyMatrix4(
          this.cueGroup.matrixWorld,
        );

        if (p.y < minY) {
          lift = Math.max(lift, minY - p.y);
        }
        if (this.isOverWoodenRail(p.x, p.z) && p.y < rimY) {
          lift = Math.max(lift, rimY - p.y);
        }
      }

      if (lift < 0.001) break;
      tipPos.y += lift + 0.004;
    }

    this.cueGroup.position.copy(tipPos);
    // Look along the aim axis through the hit point (no sideways skew)
    const look = hitPoint.clone().addScaledVector(flat, 0.05);
    look.y = hitPoint.y;
    this.cueGroup.lookAt(look);

    if (this.cueGroup.position.y < minY) {
      this.cueGroup.position.y = minY;
    }
  }

  /** Keep aim camera outside the table bed so every side of the cue ball is reachable. */
  private aimCameraPosition(
    cue: BallState,
    shotDir: THREE.Vector3,
    cueDir: THREE.Vector3,
  ): THREE.Vector3 {
    const halfW = TABLE.width / 2;
    const halfL = TABLE.length / 2;
    const rail = TABLE.railWidth + 0.08;

    // Pull in when the cue ball is near a cushion so the camera isn't jammed in the rail
    const clearX = halfW - Math.abs(cue.position.x);
    const clearZ = halfL - Math.abs(cue.position.z);
    const edgeClear = Math.min(clearX, clearZ);
    const cap = 0.45 + edgeClear * 1.35;

    // How far past the default the player has zoomed out (0 = default/in, 1 = max).
    const zoomOut = THREE.MathUtils.clamp(
      (this.aimDistance - CONTROLS.aimDistanceDefault) /
        (CONTROLS.aimDistanceMax - CONTROLS.aimDistanceDefault),
      0,
      1,
    );
    // Near a cushion we normally pull the camera in to avoid jamming into the
    // rail, but once the player zooms out we let it pull fully back and lift it
    // high instead — the rail clamp below keeps it clear of the cloth.
    const dist = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(Math.min(this.aimDistance, cap), this.aimDistance, zoomOut),
      CONTROLS.aimDistanceMin,
      CONTROLS.aimDistanceMax,
    );

    // Rise up as we zoom out for a top-down overview of the ball layout.
    const heightOffset = 0.14 + CONTROLS.aimCameraLift + dist * 0.2 + zoomOut * zoomOut * 1.35;
    const camPos = cue.position
      .clone()
      .addScaledVector(shotDir, -Math.max(CONTROLS.aimDistanceMin, dist - CONTROLS.aimCameraPullIn))
      .add(new THREE.Vector3(0, heightOffset - cueDir.y * dist * 0.15, 0));

    // If camera would sit over the cloth, lift it above the rails
    if (Math.abs(camPos.x) < halfW + rail && Math.abs(camPos.z) < halfL + rail) {
      camPos.y = Math.max(camPos.y, TABLE.height + 0.35);
    }

    return clampToRoom(camPos);
  }

  /** True while aiming without pointer lock (HUD shows a "click to lock" hint). */
  get needsPointerLock(): boolean {
    return this.canShoot && this.mode === "aim" && !this.pointerLocked;
  }

  private ensureAimPointerLock(): void {
    if (
      this.canShoot &&
      this.mode === "aim" &&
      !this.pointerLocked &&
      document.pointerLockElement !== this.dom
    ) {
      this.dom.requestPointerLock();
    }
  }

  private bind(): void {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "ArrowLeft" || e.code === "ArrowRight") e.preventDefault();
      if (this.watchingShot) return;
      if (
        this.enabled &&
        (e.code === "Equal" ||
          e.code === "NumpadAdd" ||
          e.code === "Minus" ||
          e.code === "NumpadSubtract")
      ) {
        const zoomIn = e.code === "Equal" || e.code === "NumpadAdd";
        this.applyZoom(zoomIn ? -120 : 120);
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    this.dom.addEventListener("click", () => {
      if (this.watchingShot) return;
      if (this.canShoot && this.mode === "aim") {
        this.ensureAimPointerLock();
        return;
      }
      if (!this.pointerLocked && this.mode === "walk") {
        this.dom.requestPointerLock();
      }
    });

    this.dom.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.enabled || this.watchingShot) return;

      if (this.mode === "walk" && this.pointerLocked) {
        this.yaw -= e.movementX * CONTROLS.lookSensitivity;
        this.pitch -= e.movementY * CONTROLS.lookSensitivity;
        this.pitch = THREE.MathUtils.clamp(this.pitch, -1.4, 1.4);
        return;
      }

      if (this.mode !== "aim" || !this.canShoot) return;

      // RMB: look around (camera only)
      if (this.lookingAround || (e.buttons & 2) !== 0) {
        this.lookingAround = true;
        this.yaw -= e.movementX * CONTROLS.lookSensitivity;
        this.pitch -= e.movementY * CONTROLS.lookSensitivity;
        this.pitch = THREE.MathUtils.clamp(this.pitch, -1.4, 1.4);
        return;
      }

      // LMB charging — keep aim frozen
      if (this.charging || (e.buttons & 1) !== 0) return;

      // Free mouse: swing / orbit the cue (Shift = fine aim)
      const fine = e.shiftKey ? CONTROLS.aimFineFactor : 1;
      this.aimYaw += e.movementX * CONTROLS.aimSensitivity * fine;
      this.aimPitch -= e.movementY * CONTROLS.aimPitchSensitivity * fine;
      this.aimPitch = THREE.MathUtils.clamp(
        this.aimPitch,
        CONTROLS.minAimPitch,
        CONTROLS.maxAimPitch,
      );
      this.syncHitToCueAxis();
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.enabled || !this.canShoot || this.mode !== "aim") return;
      // Only presses on the table start a shot / look — not clicks on HUD
      // buttons or cards (with pointer lock, the target is always the canvas).
      if (e.target !== this.dom) return;
      // Unlocked: this click only (re)locks the pointer; it must not shoot.
      if (e.button === 0 && !this.pointerLocked) {
        this.ensureAimPointerLock();
        return;
      }

      if (e.button === 0) {
        // LMB: charge power
        this.charging = true;
        this.power = 0;
        this.lookingAround = false;
      } else if (e.button === 2) {
        // RMB: look around from current view
        this.lookingAround = true;
        this.camera.rotation.order = "YXZ";
        this.yaw = this.camera.rotation.y;
        this.pitch = this.camera.rotation.x;
      }
    });

    document.addEventListener("mouseup", (e) => {
      if (!this.enabled || !this.canShoot) return;

      if (e.button === 0 && this.mode === "aim" && this.charging) {
        this.charging = false;
        const dir = this.getAimDirection();
        const p = Math.max(0.05, this.power);
        this.power = 0;
        this.onShot?.(dir, p);
      } else if (e.button === 2) {
        this.lookingAround = false;
        this.ensureAimPointerLock();
      }
    });

    document.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled || this.watchingShot) return;
        e.preventDefault();
        this.applyZoom(e.deltaY);
      },
      { passive: false },
    );
  }

  private applyZoom(deltaY: number): void {
    if (this.mode === "aim" || this.canShoot) {
      this.aimDistance = THREE.MathUtils.clamp(
        this.aimDistance + deltaY * CONTROLS.zoomSensitivity,
        CONTROLS.aimDistanceMin,
        CONTROLS.aimDistanceMax,
      );
    } else {
      this.walkFov = THREE.MathUtils.clamp(
        this.walkFov + deltaY * CONTROLS.zoomSensitivity * 18,
        CONTROLS.walkFovMin,
        CONTROLS.walkFovMax,
      );
      this.camera.fov = this.walkFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Enable / disable shot input. Cue stays visible separately. */
  setCanShoot(value: boolean): void {
    if (value && !this.canShoot) {
      this.mode = "aim";
      this.aimYaw = DEFAULT_AIM_YAW;
      this.aimPitch = -0.06;
      this.resetHitToCentre();
      this.lookingAround = false;
      this.camera.fov = THREE.MathUtils.clamp(this.walkFov - 8, 32, 70);
      this.camera.updateProjectionMatrix();
      this.dom.requestPointerLock();
    }
    this.canShoot = value;
    if (!value) {
      this.charging = false;
      this.lookingAround = false;
      this.power = 0;
    } else {
      this.spectateFollow = false;
      this.watchingShot = false;
      this.spectatorSideLocked = false;
    }
  }

  /** After a shot starts — freeze (player) or follow the action (AI). */
  onShotStarted(opts?: { follow?: boolean }): void {
    this.setCanShoot(false);
    this.lookingAround = false;
    this.spectateFollow = !!opts?.follow;
    this.watchingShot = !this.spectateFollow;
    if (!this.spectateFollow) this.spectatorSideLocked = false;
    // Keep pointer lock through the shot: re-locking on the next turn needs a
    // user gesture, and without lock the cursor stops at the screen edge,
    // which capped how far the player could swing round the cue ball.
  }

  /** Aim the visible cue for an AI shot (yaw from horizontal direction). */
  setAiAim(direction: THREE.Vector3, power01 = 0): void {
    const d = direction.clone().setY(0);
    if (d.lengthSq() < 1e-10) d.set(0, 0, 1);
    d.normalize();
    // getCueApproachDirection uses (0,0,-1) with yaw → (-sin y, 0, -cos y)
    this.aimYaw = Math.atan2(-d.x, -d.z);
    this.aimPitch = -0.06;
    this.power = THREE.MathUtils.clamp(power01, 0, 1) * 0.55;
    this.syncHitToCueAxis();
  }

  private hideAimGuide(): void {
    this.aimTargetMarker.visible = false;
    this.aimGuideLine.visible = false;
  }

  private updateAimGuide(
    cue: BallState,
    shotDir: THREE.Vector3,
    balls: BallState[],
  ): void {
    const guide = predictAimGuide(cue, shotDir, balls);
    if (!guide) {
      this.hideAimGuide();
      return;
    }

    const y = guide.cueCenter.y + 0.0025;
    const p = this.aimGuidePositions;

    // White path MUST follow the cue / aim axis (ghost lies on that ray).
    // Do NOT draw to the off-axis surface contact — that bends away from the stick.
    const end = guide.ghost;
    const endY = guide.kind === "cushion" ? TABLE.clothY + TABLE.cushionHeight * 0.55 : y;

    p[0] = guide.cueCenter.x;
    p[1] = y;
    p[2] = guide.cueCenter.z;
    p[3] = end.x;
    p[4] = endY;
    p[5] = end.z;

    // Object ball path: centre → finish along leave direction
    if (guide.kind === "ball" && guide.objectCenter) {
      p[6] = guide.objectCenter.x;
      p[7] = y;
      p[8] = guide.objectCenter.z;
      p[9] = guide.finish.x;
      p[10] = y;
      p[11] = guide.finish.z;
    } else {
      // After cushion: continue along bounce from the same aim-axis end point
      p[6] = end.x;
      p[7] = endY;
      p[8] = end.z;
      p[9] = guide.finish.x;
      p[10] = y;
      p[11] = guide.finish.z;
    }

    this.aimGuideLine.geometry.setDrawRange(0, 4);
    const attr = this.aimGuideLine.geometry.getAttribute("position");
    attr.needsUpdate = true;
    this.aimGuideLine.geometry.computeBoundingSphere();
    this.aimGuideLine.visible = true;

    // Dot on the stick line (where the cue centre is at contact)
    this.aimTargetMarker.visible = true;
    this.aimTargetMarker.position.set(end.x, endY, end.z);
  }

  /** Elevated view while the AI prepares — ease into the soft side overview. */
  spectateAiThinking(dt: number, cue: BallState | undefined): void {
    if (!cue || cue.pocketed) {
      this.cueGroup.visible = false;
      this.hideAimGuide();
      return;
    }

    this.syncHitToCueAxis();
    const cueDir = this.getCueApproachDirection();
    const hitPoint = this.getHitPoint(cue);
    hitPoint.y = Math.max(hitPoint.y, TABLE.clothY + 0.006);
    this.placeCueTip(cue, hitPoint, cueDir);
    this.cueGroup.visible = true;
    this.hideAimGuide();

    this.ensureSpectatorSide(cue.position);
    this.applySoftSpectatorCamera(dt, cue.position);
  }

  /** Soft side overview while the AI shot plays out. */
  private updateSpectatorFollow(dt: number, balls: BallState[]): void {
    this.hideAimGuide();
    this.cueGroup.visible = false;

    const tableCentre = new THREE.Vector3(0, TABLE.clothY + 0.06, 0);
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const b of balls) {
      if (b.pocketed) continue;
      // Weight moving balls a bit more, but keep everything in the average
      const w = 1 + Math.min(2, b.velocity.length());
      sx += b.position.x * w;
      sz += b.position.z * w;
      n += w;
    }
    const action =
      n > 0
        ? new THREE.Vector3(sx / n, TABLE.clothY + 0.06, sz / n)
        : tableCentre.clone();
    // Prefer the middle of the table so the camera barely drifts
    const focus = tableCentre.clone().lerp(action, 0.35);
    this.applySoftSpectatorCamera(dt, focus);
  }

  private spectatorSide = 1;
  private spectatorSideLocked = false;

  private ensureSpectatorSide(hint: THREE.Vector3): void {
    if (this.spectatorSideLocked) return;
    this.spectatorSide = hint.x >= 0 ? -1 : 1;
    this.spectatorSideLocked = true;
  }

  /** Pulled-back side view with very gentle follow. */
  private applySoftSpectatorCamera(dt: number, focusWorld: THREE.Vector3): void {
    this.spectateFocus.lerp(
      new THREE.Vector3(focusWorld.x * 0.25, TABLE.clothY + 0.06, focusWorld.z * 0.35),
      1 - Math.pow(0.012, dt),
    );

    // Fixed distance off the long side — simple TV-style angle
    const targetCam = new THREE.Vector3(
      this.spectatorSide * CONTROLS.spectatorDistance,
      TABLE.height + CONTROLS.spectatorHeight,
      this.spectateFocus.z * 0.4,
    );

    this.spectateCam.lerp(targetCam, 1 - Math.pow(0.01, dt));
    this.camera.position.lerp(clampToRoom(this.spectateCam), 1 - Math.pow(0.01, dt));
    this.camera.up.set(0, 1, 0);

    const look = new THREE.Vector3(
      this.spectateFocus.x * 0.15,
      TABLE.clothY + 0.08,
      this.spectateFocus.z,
    );
    this.camera.lookAt(look);
  }

  getAimDirection(): THREE.Vector3 {
    return this.getCueApproachDirection().clone().setY(0).normalize();
  }

  /** Full 3D approach of the cue (includes elevating the butt). */
  getCueApproachDirection(): THREE.Vector3 {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.aimPitch, this.aimYaw, 0, "YXZ"),
    );
    return new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  }

  getHitPoint(cue: BallState): THREE.Vector3 {
    return cue.position.clone().addScaledVector(this.hitNormal, BALL.radius * 1.001);
  }

  private tableBlockedHalfExtents(): { hx: number; hz: number } {
    const body = CONTROLS.playerRadius;
    const rim = TABLE.cushionWidth + TABLE.railWidth;
    return {
      hx: TABLE.width / 2 + rim + body,
      hz: TABLE.length / 2 + rim + body,
    };
  }

  private collidesWithTable(x: number, z: number): boolean {
    const { hx, hz } = this.tableBlockedHalfExtents();
    return Math.abs(x) < hx && Math.abs(z) < hz;
  }

  private pushOutsideTable(): void {
    if (!this.collidesWithTable(this.position.x, this.position.z)) return;
    const { hx, hz } = this.tableBlockedHalfExtents();
    const dx = hx - Math.abs(this.position.x);
    const dz = hz - Math.abs(this.position.z);
    if (dx < dz) {
      this.position.x = Math.sign(this.position.x || 1) * hx;
    } else {
      this.position.z = Math.sign(this.position.z || 1) * hz;
    }
  }

  update(
    dt: number,
    cue: BallState | undefined,
    ballsMoving = false,
    balls: BallState[] = [],
    aiThinking = false,
  ): void {
    if (!this.enabled) return;

    const cueReady = !!cue && !cue.pocketed;
    const showCue = cueReady && !ballsMoving && !this.spectateFollow;
    this.cueGroup.visible = showCue;

    if (aiThinking) {
      this.spectateAiThinking(dt, cue);
      return;
    }

    if (this.spectateFollow) {
      if (ballsMoving) {
        this.updateSpectatorFollow(dt, balls);
        return;
      }
      this.spectateFollow = false;
    }

    // Keep the aim view locked while a player shot plays out
    if (this.watchingShot) {
      this.hideAimGuide();
      if (ballsMoving) return;
      this.watchingShot = false;
    }

    if (this.canShoot && cueReady) {
      this.mode = "aim";
      if (this.charging) {
        this.power = Math.min(1, this.power + dt * 0.55);
      } else {
        // ← / → swing the cue round the ball; Shift for fine adjustment.
        const turn =
          (this.keys.has("ArrowLeft") ? 1 : 0) - (this.keys.has("ArrowRight") ? 1 : 0);
        if (turn) {
          const fine = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
          this.aimYaw += turn * (fine ? CONTROLS.aimKeyFineSpeed : CONTROLS.aimKeySpeed) * dt;
        }
      }

      this.syncHitToCueAxis();
      const shotDir = this.getAimDirection();
      const cueDir = this.getCueApproachDirection();
      const hitPoint = this.getHitPoint(cue!);
      hitPoint.y = Math.max(hitPoint.y, TABLE.clothY + 0.006);
      // Place stick on the horizontal aim axis so it matches the shot + guide line
      this.placeCueTip(cue!, hitPoint, shotDir);

      this.updateAimGuide(cue!, shotDir, balls);

      if (this.lookingAround) {
        this.camera.rotation.order = "YXZ";
        this.camera.rotation.y = this.yaw;
        this.camera.rotation.x = this.pitch;
        return;
      }

      const camPos = this.aimCameraPosition(cue!, shotDir, cueDir);
      this.camera.position.lerp(camPos, 1 - Math.pow(0.0008, dt));
      this.camera.lookAt(cue!.position.clone().addScaledVector(shotDir, 0.25));
      return;
    }

    this.hideAimGuide();

    // Cue visible but not interactive (e.g. AI turn) — keep it aimed at the ball
    if (showCue && cue) {
      const cueDir = this.getCueApproachDirection();
      const hitPoint = this.getHitPoint(cue);
      this.placeCueTip(cue, hitPoint, cueDir);
    }

    this.mode = "walk";
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(forward);
    if (this.keys.has("KeyS")) move.sub(forward);
    if (this.keys.has("KeyA")) move.sub(right);
    if (this.keys.has("KeyD")) move.add(right);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(CONTROLS.walkSpeed * dt);
      const nextX = this.position.x + move.x;
      const nextZ = this.position.z + move.z;
      if (!this.collidesWithTable(nextX, this.position.z)) this.position.x = nextX;
      if (!this.collidesWithTable(this.position.x, nextZ)) this.position.z = nextZ;
    }

    clampToRoom(this.position);
    this.position.y = CONTROLS.eyeHeight;
    this.pushOutsideTable();
    this.syncWalkCamera();
  }
}
