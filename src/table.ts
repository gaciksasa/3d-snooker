import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ROOM, TABLE } from "./constants";
import { LAMP } from "./render";
import { POCKET_HOLES } from "./tableGeometry";
import {
  applyBoxUV,
  createCarpetTexture,
  createClothTextures,
  createWoodTextures,
} from "./textures";

export interface Pocket {
  position: THREE.Vector2;
  radius: number;
  name: string;
}

/** Manual tuning for the imported OBJ table (edit if alignment is off). */
export const MODEL_TABLE = {
  url: "/snooker.obj",
  /** Room environment exported from the same Blender scene / coordinate space. */
  roomUrl: "/room.obj",
  /** Extra uniform scale nudge after auto-fit. */
  scaleMul: 1.0,
  /** Vertical nudge so the cloth surface sits exactly on the ball plane. */
  yOffset: 0.0,
  /** Extra yaw if the table ends up rotated (model long axis already = Z). */
  yaw: 0,
} as const;

/** Transform derived from fitting the table; reused to place the room. */
interface FitTransform {
  scale: THREE.Vector3;
  position: THREE.Vector3;
  yaw: number;
}

/**
 * Load the room environment (floor, walls, ceiling, skirting, pendant lamp)
 * exported from the same Blender scene and place it with the *same* transform
 * the table used, so it wraps the table exactly.
 */
function loadRoomModel(
  fit: FitTransform,
  onReady: (obj: THREE.Object3D) => void,
): void {
  const carpet = createCarpetTexture();
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: carpet, roughness: 1 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x5a4034, roughness: 0.92 });
  const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 1 });
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x24160e, roughness: 0.5 });
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.35, metalness: 0.6 });
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.3, metalness: 1 });
  // HDR emissive so the lamp panel blooms.
  const emitMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xfff3d6).multiplyScalar(3),
    toneMapped: false,
  });

  const loader = new OBJLoader();
  loader.load(MODEL_TABLE.roomUrl, (root) => {
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const n = mesh.name;
      if (n.startsWith("Lamp")) raiseLampPart(geo, n);
      else shrinkRoomPart(geo);
      geo.computeVertexNormals();
      if (n.startsWith("RoomFloor")) {
        applyBoxUV(geo, 0.6);
        mesh.receiveShadow = true;
      }
      if (n.startsWith("RoomFloor")) mesh.material = floorMat;
      else if (n.startsWith("Wall")) mesh.material = wallMat;
      else if (n.startsWith("Ceiling")) mesh.material = ceilingMat;
      else if (n.startsWith("Skirt")) mesh.material = skirtMat;
      else if (n.startsWith("Lamp_Emit")) mesh.material = emitMat;
      else if (n.startsWith("Lamp_Shade")) mesh.material = shadeMat;
      else if (n.startsWith("Lamp_Rod")) mesh.material = rodMat;
      else mesh.material = wallMat;
    });

    const pivot = new THREE.Group();
    pivot.add(root);
    root.scale.copy(fit.scale);
    pivot.rotation.y = fit.yaw;
    pivot.position.copy(fit.position);
    onReady(pivot);
  });
}

/** Model-space dimensions from room.obj (interior half-extents, ceiling). */
const OBJ_ROOM = { halfX: 11, halfZ: 15, height: 7 } as const;
const LAMP_BOTTOM = 2.04;
const LAMP_TOP = 2.26;

/**
 * The exported room is a 22 × 30 m hall with a 7 m ceiling, which dwarfs the
 * table (from a shooting stance it reads as if the table sat on the floor).
 * Remap walls / floor / ceiling to ROOM: scale the plan, scale wall height,
 * and move the ceiling slab down while keeping its thickness.
 */
function shrinkRoomPart(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute("position");
  const sx = ROOM.halfX / OBJ_ROOM.halfX;
  const sz = ROOM.halfZ / OBJ_ROOM.halfZ;
  const sy = ROOM.height / OBJ_ROOM.height;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) * sx);
    pos.setZ(i, pos.getZ(i) * sz);
    pos.setY(i, y <= OBJ_ROOM.height ? y * sy : y - OBJ_ROOM.height + ROOM.height);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

/**
 * Lift the pendant lamp by LAMP.lift. The shade and panel move up; the rods are
 * shortened so they still reach the (lowered) ceiling. The emissive panel sits 2 mm
 * below the shade — in the OBJ it is coplanar with the shade bottom, which
 * z-fought and made the lamp flicker.
 */
function raiseLampPart(geo: THREE.BufferGeometry, name: string): void {
  const pos = geo.getAttribute("position");
  const top = LAMP_TOP + LAMP.lift;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (name.startsWith("Lamp_Rod")) {
      pos.setY(i, top + ((y - LAMP_TOP) / (OBJ_ROOM.height - LAMP_TOP)) * (ROOM.height - top));
    } else if (name.startsWith("Lamp_Emit")) {
      pos.setY(i, LAMP_BOTTOM + LAMP.lift - 0.002);
    } else {
      pos.setY(i, y + LAMP.lift);
    }
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

/**
 * Load the exported OBJ table (Blender), colour its named parts and fit it to
 * our WPBSA coordinate system. Invokes `onReady` with the prepared object once
 * parsed. The model ships without textures, so materials are assigned by name.
 */
export function loadTableModel(onReady: (obj: THREE.Object3D) => void): void {
  const loader = new OBJLoader();
  loader.load(MODEL_TABLE.url, (root) => {
    const cloth = createClothTextures();
    // ~0.35 m per tile — fibre grain reads at close range without visible repeats.
    cloth.map.repeat.set(1, 1);
    const clothMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: cloth.map,
      bumpMap: cloth.bump,
      bumpScale: 0.3,
      roughness: 0.95,
      sheen: 0.35,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0x2f8a4a),
      envMapIntensity: 0.15,
    });
    const cushionMat = clothMat.clone();
    cushionMat.color = new THREE.Color(0xd8e8dc);
    const wood = createWoodTextures();
    const woodMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: wood.map,
      roughnessMap: wood.rough,
      roughness: 0.6,
      clearcoat: 0.3,
      clearcoatRoughness: 0.5,
      envMapIntensity: 0.6,
    });
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x030303 });

    // The exported OBJ ships with named parts, so colour by object name instead
    // of a fragile geometric heuristic: cloth = bed, cushions = martinela green,
    // pocket wells = black, everything else (rails, cabinet, legs) = wood.
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry as THREE.BufferGeometry;
      geo.computeVertexNormals();
      const n = mesh.name;
      if (n.startsWith("Cushion")) {
        applyBoxUV(geo, 3);
        mesh.material = cushionMat;
        mesh.receiveShadow = true;
      } else if (n.startsWith("Bed")) {
        applyBoxUV(geo, 3);
        mesh.material = clothMat;
        mesh.receiveShadow = true;
      } else if (n.startsWith("PocketWell")) {
        mesh.material = holeMat;
      } else {
        applyBoxUV(geo, 0.8, true);
        mesh.material = woodMat;
        mesh.receiveShadow = true;
      }
    });

    // The OBJ is authored in metres at WPBSA size: its cushion noses already
    // sit on the 3569 × 1778 mm playing area. Use it 1:1 (an earlier fit to
    // our outer rail box shrank it ~0.5%, leaving the visible cushions ~4 mm
    // inside the physics ones) and only drop it so its bed top is the cloth.
    const s = MODEL_TABLE.scaleMul;
    const sX = s;
    const sY = s;
    const sZ = s;

    const pivot = new THREE.Group();
    pivot.add(root);
    root.scale.set(sX, sY, sZ);
    pivot.rotation.y = MODEL_TABLE.yaw;

    const fitted = new THREE.Box3().setFromObject(pivot);
    pivot.position.x -= (fitted.max.x + fitted.min.x) / 2;
    pivot.position.z -= (fitted.max.z + fitted.min.z) / 2;
    const bed = root.getObjectByName("Bed");
    const bedTop = bed ? new THREE.Box3().setFromObject(bed).max.y : fitted.max.y;
    pivot.position.y += TABLE.clothY - bedTop + MODEL_TABLE.yOffset;

    onReady(pivot);

    // The imported OBJ ships without cloth markings, so overlay the baulk
    // line, the "D" and the spots in our world coordinate system.
    onReady(createTableMarkings());

    // Soft shadow the table casts on the floor from the overhead lamp.
    const footX = fitted.max.x - fitted.min.x;
    const footZ = fitted.max.z - fitted.min.z;
    const floorY = pivot.position.y;
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(footX * 1.4, footZ * 1.12),
      new THREE.MeshBasicMaterial({
        map: createTableShadowTexture(),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, floorY + 0.02, 0);
    shadow.renderOrder = 1;
    onReady(shadow);

    // Wrap the table in its Blender room using the identical fit transform.
    loadRoomModel(
      {
        scale: new THREE.Vector3(sX, sY, sZ),
        position: pivot.position.clone(),
        yaw: MODEL_TABLE.yaw,
      },
      onReady,
    );
  });
}

/**
 * Build the white cloth markings (baulk line, the "D" and the six spots) in the
 * game's world coordinates so they line up with the ball spot positions. Drawn
 * with depthTest off so they read clearly on top of the imported cloth mesh.
 */
function createTableMarkings(): THREE.Group {
  const group = new THREE.Group();
  const halfL = TABLE.length / 2;
  const halfW = TABLE.width / 2;
  const baulkZ = -halfL + TABLE.baulkDistance;
  const y = TABLE.clothY + 0.006;

  const lineMat = new THREE.LineBasicMaterial({
    color: 0xf0f4ec,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });

  // Baulk line across the table.
  const baulk = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-halfW, y, baulkZ),
      new THREE.Vector3(halfW, y, baulkZ),
    ]),
    lineMat,
  );
  group.add(baulk);

  // The "D" — semicircle bulging toward the baulk cushion (-z).
  const dCurve = new THREE.EllipseCurve(
    0, baulkZ, TABLE.dRadius, TABLE.dRadius, Math.PI, Math.PI * 2, false, 0,
  );
  const dPts = dCurve.getPoints(64).map((p) => new THREE.Vector3(p.x, y, p.y));
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(dPts), lineMat));

  // Spots.
  const spotMat = new THREE.MeshBasicMaterial({
    color: 0xf4f8f0,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const spotGeo = new THREE.CircleGeometry(0.007, 20);
  const spots: THREE.Vector3[] = [
    new THREE.Vector3(-TABLE.dRadius, y, baulkZ), // green
    new THREE.Vector3(0, y, baulkZ), // brown
    new THREE.Vector3(TABLE.dRadius, y, baulkZ), // yellow
    new THREE.Vector3(0, y, 0), // blue
    new THREE.Vector3(0, y, halfL / 2), // pink
    new THREE.Vector3(0, y, halfL - TABLE.blackSpotFromTop), // black
  ];
  for (const p of spots) {
    const s = new THREE.Mesh(spotGeo, spotMat);
    s.rotation.x = -Math.PI / 2;
    s.position.copy(p);
    group.add(s);
  }

  group.renderOrder = 3;
  group.traverse((o) => (o.renderOrder = 3));
  return group;
}

/** Soft-edged rounded-rectangle blob used as the table's cast shadow. */
function createTableShadowTexture(): THREE.CanvasTexture {
  const w = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = w;
  const ctx = canvas.getContext("2d")!;
  const roundRect = (x: number, y: number, ww: number, hh: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + ww, y, x + ww, y + hh, r);
    ctx.arcTo(x + ww, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + ww, y, r);
    ctx.closePath();
  };
  // Feathered edge via a heavy blur so the patch reads as a soft penumbra.
  ctx.filter = "blur(26px)";
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  roundRect(w * 0.2, w * 0.2, w * 0.6, w * 0.6, w * 0.14);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Pocket holes as drawn (centre + radius), from the measured table geometry. */
export function getPockets(): Pocket[] {
  return POCKET_HOLES.map((h) => ({
    name: h.name,
    position: new THREE.Vector2(h.x, h.z),
    radius: h.r,
  }));
}
