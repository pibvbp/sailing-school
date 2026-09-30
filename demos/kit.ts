import * as THREE from 'three';
import { createDemoKit } from './shared/demoKit';

const kit = createDemoKit({ cameraPos: [10, 3, 12], target: [0, 1, 0] });
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
  new THREE.MeshPhysicalMaterial({ color: 0x0a2a44, roughness: 0.08, metalness: 0 }),
);
water.receiveShadow = true;
kit.scene.add(water);
const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
box.position.y = 1;
box.castShadow = true;
kit.scene.add(box);
kit.start();
