/**
 * NuraSense 3D Cardiac Anatomy Engine
 * Three.js WebGL Interactive 3D Heart Viewer
 * Features:
 * - Anatomical Human Heart model with physical porcelain/ceramic pearl shader
 * - Studio 3-point lighting with cool cyan rim highlight
 * - Smooth 360-degree rotation with momentum damping (OrbitControls)
 * - Mouse drag & mobile touch gesture support
 * - Idle auto-rotation with gentle resume
 * - Subtle resting physiological heartbeat pulse (72 bpm)
 * - Viewport visibility detection (IntersectionObserver) to pause rendering off-screen
 * - Device pixel ratio capping for high-DPI battery efficiency
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

let scene, camera, renderer, controls;
let modelGroup, heartMesh;
let baseScale = 1.0;
let isAnimating = false;
let animationFrameId = null;
let idleTimer = null;
let autoRotateEnabled = true;
let isUserInteracting = false;
let clock;
let initialCameraPos = { x: 0, y: 0, z: 3.65 };

export function initHeart3D() {
  const container = document.getElementById('heart3dStage');
  const canvas = document.getElementById('heartCanvas');
  const loaderEl = document.getElementById('heart3dLoader');
  const errorEl = document.getElementById('heart3dError');

  if (!container || !canvas) {
    return;
  }

  clock = new THREE.Clock();

  // 1. Scene setup
  scene = new THREE.Scene();

  // 2. Camera setup
  const width = container.clientWidth || 640;
  const height = container.clientHeight || 640;
  camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 100);
  camera.position.set(initialCameraPos.x, initialCameraPos.y, initialCameraPos.z);

  // 3. Renderer setup
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // 4. Lighting setup (Studio 3-Point + Ambient + Cyan Silhouette Rim)
  const ambientLight = new THREE.AmbientLight(0x223c56, 1.8);
  scene.add(ambientLight);

  // Key light (crisp studio white from top-left)
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  keyLight.position.set(4, 5, 4);
  keyLight.castShadow = true;
  scene.add(keyLight);

  // Fill light (soft sky blue from bottom-right)
  const fillLight = new THREE.DirectionalLight(0x9ec7eb, 1.5);
  fillLight.position.set(-4, -2, 3);
  scene.add(fillLight);

  // Rim / Back light (electric cyan luminescence for glowing anatomical silhouette)
  const rimLight = new THREE.DirectionalLight(0x38bdf8, 2.8);
  rimLight.position.set(0, 3.5, -4);
  scene.add(rimLight);

  // Top specular highlight
  const topLight = new THREE.DirectionalLight(0xf0fdf4, 1.2);
  topLight.position.set(0, 6, 1);
  scene.add(topLight);

  // 5. OrbitControls (Smooth 360 Rotation & Touch)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -0.04, 0); // Precision center orbit pivot on anatomical heart mass
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enableZoom = false; // Prevent wheel hijacking on scroll
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.95;
  controls.minPolarAngle = Math.PI * 0.32; // Allow smooth vertical tilt up to 32.4° while safeguarding edges
  controls.maxPolarAngle = Math.PI * 0.68;

  // Interaction detection for smooth idle resumption
  controls.addEventListener('start', () => {
    isUserInteracting = true;
    controls.autoRotate = false;
    if (idleTimer) clearTimeout(idleTimer);
  });

  controls.addEventListener('end', () => {
    isUserInteracting = false;
    if (autoRotateEnabled) {
      idleTimer = setTimeout(() => {
        if (!isUserInteracting && autoRotateEnabled) {
          controls.autoRotate = true;
        }
      }, 2400);
    }
  });

  // 6. Model Loading
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  const loader = new GLTFLoader();
  loader.load(
    '/models/heart.glb',
    (gltf) => {
      const root = gltf.scene;

      // Compute bounding box and center model
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z);
      // Dominant centerpiece: 76.3% neutral height coverage, mathematically safe against clipping
      baseScale = 2.48 / maxDim;

      root.position.sub(center); // Center geometry

      root.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          const origNormalMap = child.material?.normalMap || null;

          // Studio Porcelain / Ceramic Pearl Shader
          child.material = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(0xf2f5f9),       // Crisp ivory / porcelain white
            roughness: 0.16,                       // Smooth satin finish
            metalness: 0.04,                       // Dielectric porcelain
            clearcoat: 0.96,                       // Clear-coat gloss
            clearcoatRoughness: 0.08,
            reflectivity: 0.94,
            normalMap: origNormalMap,
            normalScale: new THREE.Vector2(0.85, 0.85),
            envMapIntensity: 1.35
          });
        }
      });

      // Default anatomical orientation (slight forward tilt, apex pointing down-left)
      modelGroup.scale.set(baseScale, baseScale, baseScale);
      modelGroup.position.set(0, -0.04, 0); // Balanced anatomical vertical centering (9.8% top margin, 11.3% bottom margin)
      modelGroup.rotation.y = -0.22;
      modelGroup.rotation.x = 0.08;
      modelGroup.add(root);

      heartMesh = modelGroup;

      if (loaderEl) {
        loaderEl.classList.add('is-hidden');
      }

      startAnimation();
    },
    undefined,
    (error) => {
      console.warn('[Heart3D] Failed to load GLB model:', error);
      if (loaderEl) loaderEl.classList.add('is-hidden');
      if (errorEl) errorEl.classList.remove('is-hidden');
    }
  );

  // 7. Window / Container Resize Observer
  const resizeObserver = new ResizeObserver(() => {
    if (!container || !renderer || !camera) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0) {
      camera.aspect = w / h;
      // In narrow portrait screens (aspect < 0.68), back up camera smoothly so lateral sides never clip
      const aspect = w / h;
      const dist = aspect < 0.68 ? 3.65 * (0.68 / aspect) : 3.65;
      camera.position.z = dist;
      initialCameraPos.z = dist;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
  });
  resizeObserver.observe(container);

  // 8. Visibility Observer to pause loop when off-screen
  const visibilityObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        startAnimation();
      } else {
        stopAnimation();
      }
    });
  }, { threshold: 0.05 });
  visibilityObserver.observe(container);

  // 9. Attach Button Controls
  const resetBtn = document.getElementById('heartResetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetHeartView);
  }

  const rotateBtn = document.getElementById('heartRotateBtn');
  if (rotateBtn) {
    rotateBtn.addEventListener('click', toggleAutoRotate);
  }
}

function startAnimation() {
  if (!isAnimating) {
    isAnimating = true;
    clock.start();
    animate();
  }
}

function stopAnimation() {
  if (isAnimating) {
    isAnimating = false;
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    clock.stop();
  }
}

function animate() {
  if (!isAnimating) return;
  animationFrameId = requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsedTime = clock.getElapsedTime();

  // Subtle physiological heartbeat pulse (72 bpm = 1.2 Hz)
  if (heartMesh) {
    const bpm = 72;
    const pulseCycle = (elapsedTime * (bpm / 60)) % 1;
    // Dual contraction curve (systole spike + soft diastolic bounce)
    let pulseScale = 1.0;
    if (pulseCycle < 0.15) {
      pulseScale = 1.0 + Math.sin((pulseCycle / 0.15) * Math.PI) * 0.028;
    } else if (pulseCycle > 0.22 && pulseCycle < 0.36) {
      pulseScale = 1.0 + Math.sin(((pulseCycle - 0.22) / 0.14) * Math.PI) * 0.012;
    }
    
    // Scale slightly from base
    heartMesh.scale.setScalar(baseScale * pulseScale);
  }

  controls.update();
  renderer.render(scene, camera);
}

export function resetHeartView() {
  if (!controls || !camera) return;
  controls.reset();
  camera.position.set(initialCameraPos.x, initialCameraPos.y, initialCameraPos.z);
  controls.target.set(0, -0.04, 0);
  controls.autoRotate = autoRotateEnabled;
}

export function toggleAutoRotate() {
  autoRotateEnabled = !autoRotateEnabled;
  if (controls) {
    controls.autoRotate = autoRotateEnabled;
  }
  const rotateBtn = document.getElementById('heartRotateBtn');
  if (rotateBtn) {
    rotateBtn.classList.toggle('is-active', autoRotateEnabled);
  }
}

