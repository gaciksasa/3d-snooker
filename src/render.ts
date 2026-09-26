import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { ROOM, TABLE } from "./constants";

/** Overhead canopy lamp, matching the Lamp_Emit panel in room.obj. */
export const LAMP = {
  /** How far the lamp is raised above its position in room.obj (metres). */
  lift: 0.6,
  y: 2.03 + 0.6,
  width: 0.36,
  length: 2.8,
} as const;

/**
 * Pre-filtered environment for reflections: a dark hall with the long
 * rectangular canopy overhead and green baize below, so glossy balls mirror
 * what a real table would show (a strip of light on top, cloth at the bottom).
 */
export function createEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM.halfX * 2, ROOM.height, ROOM.halfZ * 2),
    new THREE.MeshBasicMaterial({ color: 0x0d0a09, side: THREE.BackSide }),
  );
  room.position.y = ROOM.height / 2;
  env.add(room);

  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.96, 0.88).multiplyScalar(14) });
  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(LAMP.width * 1.6, LAMP.length), lampMat);
  lamp.rotation.x = Math.PI / 2;
  lamp.position.y = LAMP.y;
  env.add(lamp);

  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE.width, TABLE.length),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0x1d6a38).multiplyScalar(0.9) }),
  );
  cloth.rotation.x = -Math.PI / 2;
  cloth.position.y = TABLE.clothY;
  env.add(cloth);

  // Faint warm walls so edges of balls pick up a rim instead of pure black
  const wallMat = new THREE.MeshBasicMaterial({ color: 0x2a1c16 });
  for (const s of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.halfZ * 2, 2.2), wallMat);
    wall.position.set(s * (ROOM.halfX - 0.01), 1.3, 0);
    wall.rotation.y = -s * Math.PI / 2;
    env.add(wall);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02, 0.1, 30);
  pmrem.dispose();
  return rt.texture;
}

/** Lighting rig: canopy area light + a shadow-casting key straight down. */
export function setupLights(scene: THREE.Scene): void {
  RectAreaLightUniformsLib.init();

  // Very low bounce fill so the room reads but the table dominates.
  scene.add(new THREE.HemisphereLight(0xffeedd, 0x14261a, 0.35));

  // Canopy: soft, even pool of light over the cloth with a rectangular highlight
  // on every ball.
  const canopy = new THREE.RectAreaLight(0xfff2dc, 6.5, LAMP.width * 2.4, LAMP.length);
  canopy.position.set(0, LAMP.y - 0.01, 0);
  canopy.lookAt(0, 0, 0);
  scene.add(canopy);

  // Shadow key: nearly vertical, so balls drop a tight soft shadow under them
  // as under a real canopy.
  const key = new THREE.DirectionalLight(0xfff4e4, 1.0);
  key.position.set(0.12, 4, 0.2);
  key.target.position.set(0, TABLE.clothY, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  const cam = key.shadow.camera;
  cam.left = -TABLE.width / 2 - 0.35;
  cam.right = TABLE.width / 2 + 0.35;
  cam.top = TABLE.length / 2 + 0.35;
  cam.bottom = -TABLE.length / 2 - 0.35;
  cam.near = 1.5;
  cam.far = 5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.006;
  key.shadow.radius = 5;
  key.shadow.blurSamples = 16;
  scene.add(key);
  scene.add(key.target);

  // Faint warm spill toward the room so walls are not a black void.
  const spill = new THREE.PointLight(0xffd9a8, 4, 7, 1.6);
  spill.position.set(0, LAMP.y + 0.1, 0);
  scene.add(spill);
}

/**
 * Saturation boost + vignette + very fine film grain, applied before the sRGB
 * output pass (ACES tone mapping in OutputPass desaturates bright colours).
 */
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uStrength: { value: 0.42 },
    uSaturation: { value: 1.08 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uStrength;
    uniform float uSaturation;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(luma), c.rgb, uSaturation), 0.0);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.2, length(d * vec2(1.15, 1.0)));
      c.rgb *= mix(1.0 - uStrength, 1.0, v);
      c.rgb += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.012;
      gl_FragColor = c;
    }
  `,
};

export interface PostFX {
  composer: EffectComposer;
  render(dt: number): void;
  setSize(w: number, h: number): void;
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFX {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  // MSAA on the HDR target — the composer would otherwise lose antialiasing.
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.2, 0.4, 1.25);
  composer.addPass(bloom);
  const vignette = new ShaderPass(VignetteShader);
  composer.addPass(vignette);
  composer.addPass(new OutputPass());

  let t = 0;
  return {
    composer,
    render(dt: number) {
      t += dt;
      vignette.uniforms.uTime.value = t % 100;
      composer.render(dt);
    },
    setSize(w: number, h: number) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
  };
}
