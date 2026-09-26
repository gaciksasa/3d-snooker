import type { BallState } from "./balls";
import { BALL_VALUES, COLOR_ORDER, type BallColor } from "./constants";
import type { PhysicsWorld } from "./physics";

export type PlayerId = "player" | "ai";

export type GamePhase =
  | "reds"
  | "colors"
  | "frame_over";

export interface FoulInfo {
  points: number;
  reason: string;
}

export interface TurnResolution {
  scored: number;
  foul: FoulInfo | null;
  switchTurn: boolean;
  message: string;
  cueInHand: boolean;
  frameOver: boolean;
  winner: PlayerId | null;
}

export class SnookerRules {
  scores: Record<PlayerId, number> = { player: 0, ai: 0 };
  current: PlayerId = "player";
  phase: GamePhase = "reds";
  /** After potting a red, next ball must be a colour. */
  onColour: boolean = false;
  /** During colours phase, next required colour. */
  nextColourIndex = 0;
  breakScore = 0;
  frameOver = false;
  winner: PlayerId | null = null;

  remainingReds(balls: BallState[]): number {
    return balls.filter((b) => b.color === "red" && !b.pocketed).length;
  }

  expectedTarget(balls: BallState[]): string {
    if (this.phase === "frame_over") return "—";
    if (this.phase === "colors") {
      return COLOR_ORDER[this.effectiveColourIndex(balls)] ?? "—";
    }
    return this.onColour ? "any colour" : "red";
  }

  legalFirstBalls(balls: BallState[]): BallColor[] {
    if (this.phase === "colors") {
      const col = COLOR_ORDER[this.effectiveColourIndex(balls)];
      return col ? [col] : [];
    }
    if (this.onColour) {
      return COLOR_ORDER.slice();
    }
    return ["red"];
  }

  /**
   * Reds are gone and no colour is owed (the colour after the last red was
   * potted, missed or fouled): the clearance of the colours starts at yellow.
   * Also used when resuming a saved frame.
   */
  syncPhase(balls: BallState[]): void {
    if (this.phase === "reds" && !this.onColour && this.remainingReds(balls) === 0) {
      this.phase = "colors";
      this.nextColourIndex = 0;
    }
  }

  /** legalFirstBalls, but for the shot being resolved (balls potted on it count as present). */
  private legalFirstBallsForShot(balls: BallState[], pocketedThisShot: BallState[]): BallColor[] {
    if (this.phase === "colors") {
      const col = COLOR_ORDER[this.requiredColourIndexForShot(balls, pocketedThisShot)];
      return col ? [col] : [];
    }
    return this.legalFirstBalls(balls);
  }

  /**
   * Lowest-order colour still on the table (skips any that are gone). Keeps the
   * required target in sync with reality even if a colour ends up potted out of
   * the strict sequence — the phase can never demand a ball that isn't there.
   */
  private effectiveColourIndex(balls: BallState[]): number {
    let i = this.nextColourIndex;
    while (
      i < COLOR_ORDER.length &&
      !balls.some((b) => b.color === COLOR_ORDER[i] && !b.pocketed)
    ) {
      i++;
    }
    return i;
  }

  /**
   * Required colour index for the shot being resolved. Treats balls potted on
   * this very shot as still present so the pot can be validated, but skips
   * colours that disappeared on earlier shots.
   */
  private requiredColourIndexForShot(
    balls: BallState[],
    pocketedThisShot: BallState[],
  ): number {
    const present = (col: BallColor) =>
      balls.some(
        (b) => b.color === col && (!b.pocketed || pocketedThisShot.includes(b)),
      );
    let i = this.nextColourIndex;
    while (i < COLOR_ORDER.length && !present(COLOR_ORDER[i])) i++;
    return i;
  }

  resolveShot(
    world: PhysicsWorld,
    pocketedThisShot: BallState[],
    firstContact: BallState | null,
    cuePocketed: boolean,
  ): TurnResolution {
    const balls = world.balls;
    let scored = 0;
    let foul: FoulInfo | null = null;
    let cueInHand = false;
    let message = "";

    // Phase at the *start* of the shot. A colour potted alongside the last red
    // is still a reds-phase pot and must be respotted, even though we flip to
    // the colours phase within this same resolution.
    const startedInColours = this.phase === "colors";

    // Legal first contact as it was when the shot was *played*: judging it
    // from the table after the shot treated the colour just potted as already
    // gone, so every correct pot in the colours phase was called a foul
    // ("Hit yellow first") and handed the turn to the opponent.
    const legal = this.legalFirstBallsForShot(balls, pocketedThisShot);

    if (cuePocketed) {
      foul = { points: Math.max(4, this.minFoulValue(legal)), reason: "Cue ball potted" };
      cueInHand = true;
    } else if (!firstContact) {
      foul = { points: Math.max(4, this.minFoulValue(legal)), reason: "Missed all balls" };
    } else if (!legal.includes(firstContact.color as BallColor) && firstContact.color !== "cue") {
      const hitVal = firstContact.color === "red" ? 4 : BALL_VALUES[firstContact.color as Exclude<BallColor, "cue">];
      foul = {
        points: Math.max(4, hitVal, this.minFoulValue(legal)),
        reason: `Hit ${firstContact.color} first`,
      };
    }

    // Wrong balls potted
    const redsPotted = pocketedThisShot.filter((b) => b.color === "red");
    const coloursPotted = pocketedThisShot.filter(
      (b) => b.color !== "red" && b.color !== "cue",
    );

    if (!foul) {
      if (this.phase === "reds") {
        if (!this.onColour) {
          if (coloursPotted.length > 0) {
            foul = {
              points: Math.max(4, ...coloursPotted.map((b) => BALL_VALUES[b.color as Exclude<BallColor, "cue">])),
              reason: "Potted colour on red",
            };
          } else if (redsPotted.length > 0) {
            scored = redsPotted.length;
            this.onColour = true;
            message = redsPotted.length > 1 ? `Potted ${redsPotted.length} reds` : "Red potted";
          } else {
            message = "No pot — end of break";
          }
        } else {
          // Must pot exactly one colour (or none)
          if (redsPotted.length > 0) {
            const vals = coloursPotted.map((b) => BALL_VALUES[b.color as Exclude<BallColor, "cue">]);
            if (firstContact && firstContact.color !== "red" && firstContact.color !== "cue") {
              vals.push(BALL_VALUES[firstContact.color as Exclude<BallColor, "cue">]);
            }
            foul = { points: Math.max(4, ...vals), reason: "Potted red on colour" };
          } else if (coloursPotted.length > 1) {
            foul = {
              points: Math.max(4, ...coloursPotted.map((b) => BALL_VALUES[b.color as Exclude<BallColor, "cue">])),
              reason: "Potted multiple colours",
            };
          } else if (coloursPotted.length === 1) {
            const c = coloursPotted[0];
            scored = BALL_VALUES[c.color as Exclude<BallColor, "cue">];
            c.needsRespot = true;
            this.onColour = false;
            message = `${c.color} potted (+${scored})`;
            // If no reds left after this colour, enter colours phase
            if (this.remainingReds(balls) === 0) {
              this.phase = "colors";
              this.nextColourIndex = 0;
              this.onColour = false;
              message += " — colours phase";
            }
          } else {
            message = "No pot — end of break";
            this.onColour = false;
          }
        }
      } else if (this.phase === "colors") {
        // Re-sync to the lowest colour actually on the table so we can never
        // demand a ball that has already gone.
        const idx = this.requiredColourIndexForShot(balls, pocketedThisShot);
        this.nextColourIndex = idx;
        const required = COLOR_ORDER[idx];
        if (idx >= COLOR_ORDER.length) {
          this.phase = "frame_over";
        } else if (redsPotted.length > 0) {
          foul = { points: 4, reason: "Potted red in colours phase" };
        } else if (coloursPotted.length > 1) {
          foul = {
            points: Math.max(
              4,
              BALL_VALUES[required],
              ...coloursPotted.map((b) => BALL_VALUES[b.color as Exclude<BallColor, "cue">]),
            ),
            reason: "Potted multiple colours",
          };
        } else if (coloursPotted.length === 1) {
          const c = coloursPotted[0];
          if (c.color !== required) {
            foul = {
              points: Math.max(4, BALL_VALUES[c.color as Exclude<BallColor, "cue">], BALL_VALUES[required]),
              reason: `Needed ${required}, potted ${c.color}`,
            };
            c.needsRespot = true;
          } else {
            scored = BALL_VALUES[required];
            message = `${required} potted (+${scored})`;
            this.nextColourIndex = idx + 1;
            if (this.nextColourIndex >= COLOR_ORDER.length) {
              this.phase = "frame_over";
            }
          }
        } else {
          message = "No pot — end of break";
        }
      }
    }

    // Respot colours incorrectly left down on foul during reds/colours
    if (foul) {
      for (const b of coloursPotted) {
        b.needsRespot = true;
      }
      // Reds stay down
      this.onColour = false;
    }

    let switchTurn = false;
    if (foul) {
      const opponent: PlayerId = this.current === "player" ? "ai" : "player";
      this.scores[opponent] += foul.points;
      this.breakScore = 0;
      switchTurn = true;
      message = `Foul: ${foul.reason} (+${foul.points} to opponent)`;
    } else if (scored > 0) {
      this.scores[this.current] += scored;
      this.breakScore += scored;
      switchTurn = false;
    } else {
      this.breakScore = 0;
      switchTurn = true;
    }

    // Apply respots
    for (const b of balls) {
      if (b.needsRespot && b.color !== "red" && b.color !== "cue") {
        // A colour correctly potted during the colours-clearing phase stays
        // down. A colour potted together with the last red (shot started in the
        // reds phase) must still be respotted before the clearance begins.
        if (startedInColours && !foul && scored > 0 && pocketedThisShot.includes(b)) {
          b.needsRespot = false;
          continue;
        }
        const spot = world.findRespot(b.color);
        if (spot) {
          b.pocketed = false;
          b.position.copy(spot);
          b.velocity.set(0, 0, 0);
          b.mesh.visible = true;
        }
        b.needsRespot = false;
      }
    }

    // Cue ball return
    if (cuePocketed) {
      const cue = balls.find((b) => b.color === "cue")!;
      cue.pocketed = false;
      cue.position.copy(world.randomInD());
      cue.velocity.set(0, 0, 0);
      cue.mesh.visible = true;
    }

    this.syncPhase(balls);

    let frameOver = this.phase === "frame_over";
    let winner: PlayerId | null = null;
    if (frameOver) {
      if (this.scores.player > this.scores.ai) winner = "player";
      else if (this.scores.ai > this.scores.player) winner = "ai";
      else winner = null; // draw — rare
      this.frameOver = true;
      this.winner = winner;
      message = winner
        ? `Frame over — ${winner === "player" ? "You" : "Opponent"} win!`
        : "Frame over — draw";
    }

    if (switchTurn && !frameOver) {
      this.current = this.current === "player" ? "ai" : "player";
    }

    return {
      scored,
      foul,
      switchTurn,
      message,
      cueInHand,
      frameOver,
      winner,
    };
  }

  private minFoulValue(legal: BallColor[]): number {
    if (legal.includes("red") || legal[0] === undefined) return 4;
    if (legal.length > 1) return 4; // any colour
    return BALL_VALUES[legal[0] as Exclude<BallColor, "cue" | "red">] ?? 4;
  }
}
