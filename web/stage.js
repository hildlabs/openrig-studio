// three.js stage: an R15 rig on a studded baseplate. Viewer = one canvas; MultiViewer = one
// renderer drawing into many tiles (scissor), used by the comparison grid.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RIG_R15, REGION, solve } from '/core/rig.js';
import { sampleTracks } from '/core/anim.js';

const COLORS = { arms: 0xf5cd30, head: 0xf5cd30, torso: 0x2a6fd6, legs: 0x4ba34b };

function studTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#c3cad3'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(30, 30, 17, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(80,92,110,.18)'; g.beginPath(); g.arc(34, 34, 17, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#c8cfd8'; g.beginPath(); g.arc(32, 32, 16, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(80,92,110,.12)'; g.lineWidth = 2; g.strokeRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 40);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function faceTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f5cd30'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#2b2118';
  g.beginPath(); g.ellipse(46, 55, 6.5, 11, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(82, 55, 6.5, 11, 0, 0, Math.PI * 2); g.fill();
  g.lineWidth = 5.5; g.lineCap = 'round'; g.strokeStyle = '#2b2118';
  g.beginPath(); g.arc(64, 74, 20, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
let STUDS, FACE;

export function createScene() {
  STUDS ??= studTexture();
  FACE ??= faceTexture();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe4ea);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8f99a8, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-6, 12, -8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 8, bottom: -4, near: 1, far: 40 });
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: STUDS, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  return scene;
}

export function createRig(scene, rig = RIG_R15) {
  const meshes = {};
  for (const [name, size] of Object.entries(rig.parts)) {
    if (name === rig.root) continue;
    const geo = new THREE.BoxGeometry(...size);
    const base = new THREE.MeshStandardMaterial({ color: COLORS[REGION(name)], roughness: 0.7 });
    const mat = name === 'Head' ? [base, base, base, base, base, new THREE.MeshStandardMaterial({ map: FACE, roughness: 0.7 })] : base;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.userData.part = name;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 })));
    scene.add(mesh);
    meshes[name] = mesh;
  }
  return {
    meshes,
    data: rig,
    pose(transforms) {
      const world = solve(transforms, rig);
      for (const [name, mesh] of Object.entries(meshes)) {
        const { p, R } = world[name];
        mesh.matrix.set(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2], 0, 0, 0, 1);
        mesh.matrixWorldNeedsUpdate = true;
      }
    },
    highlight(part) {
      for (const [name, mesh] of Object.entries(meshes)) for (const m of [mesh.material].flat()) {
        m.emissive.setHex(name === part ? 0x2457e6 : 0x000000);
        m.emissiveIntensity = name === part ? 0.35 : 0;
      }
    },
    dispose() {
      for (const mesh of Object.values(meshes)) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        for (const m of [mesh.material].flat()) m.dispose();
      }
    },
  };
}

function makeCamera() {
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  camera.position.set(6.5, 4.6, -10.5);
  return camera;
}
function makeControls(camera, element) {
  const controls = new OrbitControls(camera, element);
  controls.target.set(0, 2.6, 0);
  controls.enableDamping = true;
  controls.minDistance = 4;
  controls.maxDistance = 40;
  controls.update();
  return controls;
}

export class Viewer {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.prepend(this.renderer.domElement);
    this.scene = createScene();
    this.rig = createRig(this.scene);
    this.camera = makeCamera();
    this.controls = makeControls(this.camera, this.renderer.domElement);
    new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = container;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }).observe(container);
    const ray = new THREE.Raycaster();
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      this.onPick?.(ray.intersectObjects(Object.values(this.rig.meshes), false)[0]?.object.userData.part ?? null);
    });
  }
  // Rebuilds the body when the clip is made for another rig.
  setRig(rig) {
    if (this.rig.data === rig) return;
    this.rig.dispose();
    this.rig = createRig(this.scene, rig);
  }
  show(tracks, t) { this.rig.pose(tracks ? sampleTracks(tracks, t) : {}); }
  // Frames the camera so the whole clip (incl. jumps) stays in view, keeping the orbit direction.
  fit(tracks, length) {
    let top = 5.6;
    for (let t = 0; t <= length + 1e-6; t += 1 / 15) top = Math.max(top, solve(sampleTracks(tracks, t), this.rig.data).Head.p[1] + 0.7);
    const target = new THREE.Vector3(0, top / 2, 0);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = (top * 0.62) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.update();
  }
  render() { this.controls.update(); this.renderer.render(this.scene, this.camera); }
}

// One renderer for many tiles. The canvas covers the visible part of the scroll container.
export class MultiViewer {
  constructor(scroller, canvas) {
    this.scroller = scroller;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.setScissorTest(true);
    this.tiles = new Map();
  }
  add(key, element, rig = RIG_R15) {
    const scene = createScene();
    const tile = { element, scene, rig: createRig(scene, rig), camera: makeCamera(), tracks: null };
    tile.controls = makeControls(tile.camera, element);
    this.tiles.set(key, tile);
    return tile;
  }
  clear() { for (const tile of this.tiles.values()) tile.controls.dispose(); this.tiles.clear(); }
  render(t) {
    const { clientWidth: w, clientHeight: h } = this.scroller;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.round(h * this.renderer.getPixelRatio())) this.renderer.setSize(w, h, true);
    this.canvas.style.top = `${this.scroller.scrollTop}px`;
    this.renderer.setScissor(0, 0, w, h);
    this.renderer.clear();
    const base = this.scroller.getBoundingClientRect();
    for (const tile of this.tiles.values()) {
      if (!tile.tracks || tile.element.offsetParent === null) continue;
      const r = tile.element.getBoundingClientRect();
      const x = r.left - base.left, y = r.top - base.top;
      if (y + r.height < 0 || y > h) continue;
      tile.rig.pose(sampleTracks(tile.tracks, Math.min(t, tile.length)));
      tile.camera.aspect = r.width / r.height;
      tile.camera.updateProjectionMatrix();
      tile.controls.update();
      const by = h - y - r.height;
      this.renderer.setViewport(x, by, r.width, r.height);
      this.renderer.setScissor(x, by, r.width, r.height);
      this.renderer.render(tile.scene, tile.camera);
    }
  }
}
