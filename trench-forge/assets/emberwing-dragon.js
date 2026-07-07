/* ═══════════════════════════════════════════════════════════════
   EMBERWING — procedural low-poly baby dragon mascot (three.js r128+)

   Dark-fantasy / crypto-native faceted style: angular non-indexed
   geometry with flat-baked normals (PS1-revival, not organic sculpt).
   Charcoal-black scales, molten-gold spine/claws/horns, ember
   membranes, emissive fire throat + chest core. Coiled perched pose
   on an obsidian rock, jaws open mid-roar, wings flared.

   Static mesh, no rig — animate via GSAP tweens on the returned refs.

   Usage:
     const { group, refs, triCount } = buildEmberwingDragon(THREE, {
       fireMaterial,   // optional override for throat/chest orbs
     });
     refs: { head, jawPivot, mouth, wingL, wingR, throat, chest }
═══════════════════════════════════════════════════════════════ */
function buildEmberwingDragon(THREE, opts) {
  opts = opts || {};

  const MAT = {
    scales:   new THREE.MeshStandardMaterial({ color: 0x1b1410, roughness: 0.5,  metalness: 0.4,  side: THREE.DoubleSide }),
    gold:     new THREE.MeshStandardMaterial({ color: 0xffb31a, roughness: 0.32, metalness: 0.8,  emissive: 0xff7a00, emissiveIntensity: 0.55 }),
    membrane: new THREE.MeshStandardMaterial({ color: 0x33100a, roughness: 0.65, metalness: 0.1,  emissive: 0xff3d00, emissiveIntensity: 0.38, side: THREE.DoubleSide }),
    fire:     opts.fireMaterial || new THREE.MeshStandardMaterial({ color: 0xffa514, emissive: 0xff6600, emissiveIntensity: 1.0, roughness: 0.4 }),
    eye:      new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xffb300, emissiveIntensity: 1.0 }),
    obsidian: new THREE.MeshStandardMaterial({ color: 0x161116, roughness: 0.28, metalness: 0.85, emissive: 0x2a0b04, emissiveIntensity: 0.45 }),
  };

  let triCount = 0;
  const group = new THREE.Group();
  group.name = 'Emberwing';

  // Non-indexed + computed normals = hard faceted shading baked into
  // the geometry (survives glTF export, unlike the flatShading flag).
  const facet = (geo) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    triCount += g.attributes.position.count / 3;
    return g;
  };

  const mesh = (parent, geo, mat, p, r, s) => {
    const m = new THREE.Mesh(facet(geo), mat);
    if (p) m.position.set(p[0], p[1], p[2]);
    if (r) m.rotation.set(r[0], r[1], r[2]);
    if (s) { if (typeof s === 'number') m.scale.setScalar(s); else m.scale.set(s[0], s[1], s[2]); }
    parent.add(m);
    return m;
  };

  const bone = (parent, ax, ay, az, bx, by, bz, r0, r1, mat) => {
    const a = new THREE.Vector3(ax, ay, az);
    const dir = new THREE.Vector3(bx, by, bz).sub(a);
    const m = new THREE.Mesh(facet(new THREE.CylinderGeometry(r1, r0, dir.length(), 5)), mat);
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    parent.add(m);
    return m;
  };

  /* ── coiled body: tapered faceted tube along a spline ──
     Tail wraps the perch, spine rises through the chest to the neck. */
  const spine = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.55, -0.92,  0.55),
    new THREE.Vector3(-0.95, -0.90, -0.10),
    new THREE.Vector3(-0.40, -0.98, -0.70),
    new THREE.Vector3( 0.50, -0.95, -0.50),
    new THREE.Vector3( 0.70, -0.85,  0.25),
    new THREE.Vector3( 0.15, -0.60,  0.50),
    new THREE.Vector3(-0.05, -0.15,  0.30),
    new THREE.Vector3( 0.00,  0.40,  0.25),
    new THREE.Vector3( 0.03,  0.85,  0.40),
  ]);
  const R = [0.045, 0.09, 0.17, 0.25, 0.30, 0.32, 0.28, 0.20, 0.15];
  const radiusAt = (u) => {
    const f = u * (R.length - 1), i = Math.floor(f), k = Math.min(i + 1, R.length - 1);
    return R[i] + (R[k] - R[i]) * (f - i);
  };

  const SEGS = 24, RADIAL = 7;
  const frames = spine.computeFrenetFrames(SEGS, false);
  const rings = [];
  for (let i = 0; i <= SEGS; i++) {
    const u = i / SEGS;
    const c = spine.getPoint(u);           // uniform t to match frame indices
    const N = frames.normals[i], B = frames.binormals[i];
    const rad = radiusAt(u);
    const ring = [];
    for (let j = 0; j < RADIAL; j++) {
      const a = (j / RADIAL) * Math.PI * 2;
      const cs = Math.cos(a) * rad, sn = Math.sin(a) * rad;
      ring.push([c.x + N.x * cs + B.x * sn, c.y + N.y * cs + B.y * sn, c.z + N.z * cs + B.z * sn]);
    }
    rings.push(ring);
  }
  const bodyPos = [];
  const pushV = (v) => bodyPos.push(v[0], v[1], v[2]);
  for (let i = 0; i < SEGS; i++) {
    for (let j = 0; j < RADIAL; j++) {
      const j2 = (j + 1) % RADIAL;
      const a = rings[i][j], b = rings[i][j2], c = rings[i + 1][j], d = rings[i + 1][j2];
      pushV(a); pushV(c); pushV(b);
      pushV(b); pushV(c); pushV(d);
    }
  }
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bodyPos), 3));
  mesh(group, bodyGeo, MAT.scales);

  /* ── torso bulk + emissive chest core ── */
  mesh(group, new THREE.IcosahedronGeometry(0.34, 0), MAT.scales, [0, -0.12, 0.28], null, [0.95, 1.2, 0.9]);
  const chest = mesh(group, new THREE.IcosahedronGeometry(0.21, 0), MAT.fire, [0, -0.1, 0.52]);

  /* ── molten-gold dorsal spikes along the spine ── */
  const upV = new THREE.Vector3(0, 1, 0);
  const backV = new THREE.Vector3(0, 0.35, -1).normalize();
  for (let k = 0; k < 10; k++) {
    const u = 0.16 + (k / 9) * 0.76;
    const p = spine.getPoint(u);
    const blend = Math.min(Math.max((u - 0.62) / 0.28, 0), 1); // spikes rotate from "up" (tail coil) to "back" (neck)
    const dir = upV.clone().lerp(backV, blend).normalize();
    const size = 0.06 + 0.05 * Math.sin(Math.min(u * 1.4, 1) * Math.PI);
    const m = new THREE.Mesh(facet(new THREE.TetrahedronGeometry(size)), MAT.gold);
    m.position.copy(p).addScaledVector(dir, radiusAt(u) * 0.9);
    m.quaternion.setFromUnitVectors(upV, dir);
    m.scale.set(0.7, 1.8, 0.7);
    group.add(m);
  }

  /* ── tail spade ── */
  const tipDir = spine.getTangent(0).negate();
  const spade = new THREE.Mesh(facet(new THREE.OctahedronGeometry(0.13, 0)), MAT.gold);
  spade.position.copy(spine.getPoint(0)).addScaledVector(tipDir, 0.08);
  spade.quaternion.setFromUnitVectors(upV, tipDir);
  spade.scale.set(0.35, 1.0, 0.7);
  group.add(spade);

  /* ── head: mid-roar, jaws open, fire in the throat ── */
  const head = new THREE.Group();
  head.position.set(0.02, 1.0, 0.42);
  head.scale.setScalar(1.18);
  head.rotation.x = -0.05;                 // jaws level so the roar reads from the low hero camera
  group.add(head);

  mesh(head, new THREE.DodecahedronGeometry(0.26, 0), MAT.scales, [0, 0, 0], null, [1, 0.88, 1.12]);

  const snoutGeo = new THREE.ConeGeometry(0.15, 0.52, 4);
  snoutGeo.rotateY(Math.PI / 4);
  snoutGeo.rotateX(Math.PI / 2 - 0.22);
  mesh(head, snoutGeo, MAT.scales, [0, 0.05, 0.34]);

  const jawPivot = new THREE.Group();      // tween rotation.x for roar snaps
  jawPivot.position.set(0, -0.08, 0.1);
  head.add(jawPivot);
  const jawGeo = new THREE.ConeGeometry(0.12, 0.46, 4);
  jawGeo.rotateY(Math.PI / 4);
  jawGeo.rotateX(Math.PI / 2 + 0.55);
  mesh(jawPivot, jawGeo, MAT.scales, [0, -0.07, 0.18]);

  const throat = mesh(head, new THREE.IcosahedronGeometry(0.1, 0), MAT.fire, [0, -0.06, 0.2]);

  const fangGeo = new THREE.ConeGeometry(0.025, 0.1, 4);
  fangGeo.rotateX(Math.PI);
  mesh(head, fangGeo.clone(), MAT.gold, [-0.085, -0.04, 0.48]);
  mesh(head, fangGeo, MAT.gold, [0.085, -0.04, 0.48]);

  mesh(head, new THREE.OctahedronGeometry(0.055, 0), MAT.eye, [-0.16, 0.1, 0.22], null, [0.8, 1.3, 0.8]);
  mesh(head, new THREE.OctahedronGeometry(0.055, 0), MAT.eye, [ 0.16, 0.1, 0.22], null, [0.8, 1.3, 0.8]);

  const hornGeo = new THREE.ConeGeometry(0.055, 0.42, 5);
  hornGeo.rotateX(-2.4);
  mesh(head, hornGeo.clone(), MAT.gold, [-0.12, 0.18, -0.1], [0, 0, 0.3]);
  mesh(head, hornGeo, MAT.gold, [0.12, 0.18, -0.1], [0, 0, -0.3]);

  mesh(head, new THREE.TetrahedronGeometry(0.06), MAT.gold, [0, 0.24, 0.02], null, [0.7, 1.6, 0.7]);

  const mouth = new THREE.Object3D();      // flame-burst emitter anchor
  mouth.position.set(0, -0.02, 0.55);
  head.add(mouth);

  /* ── wings: gold finger bones + angular ember membrane fan ── */
  function buildWing() {
    const W = new THREE.Group();
    bone(W, 0, 0, 0,        0.5, 0.35, 0,   0.05, 0.032, MAT.scales);
    bone(W, 0.5, 0.35, 0,   1.05, 0.85, 0,  0.028, 0.012, MAT.gold);
    bone(W, 0.5, 0.35, 0,   1.28, 0.35, 0,  0.028, 0.012, MAT.gold);
    bone(W, 0.5, 0.35, 0,   1.0, -0.28, 0,  0.026, 0.012, MAT.gold);
    const v = [[0, 0, 0], [0.5, 0.35, 0], [1.05, 0.85, 0], [1.28, 0.35, 0], [1.0, -0.28, 0], [0.08, -0.42, 0]];
    const tris = [[1, 2, 3], [1, 3, 4], [0, 1, 4], [0, 4, 5]];
    const mpos = [];
    tris.forEach((t) => t.forEach((k) => mpos.push(v[k][0], v[k][1], v[k][2])));
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mpos), 3));
    mesh(W, mg, MAT.membrane);
    const clawGeo = new THREE.ConeGeometry(0.025, 0.1, 4);
    clawGeo.rotateZ(-2.2);
    mesh(W, clawGeo, MAT.gold, [0.55, 0.42, 0]);
    return W;
  }
  const wingR = new THREE.Group();
  wingR.position.set(0.3, 0.18, 0.12);
  wingR.rotation.set(0, -0.5, 0.2);
  wingR.userData = { baseZ: 0.2, sign: 1 };
  wingR.add(buildWing());

  const wingLInner = buildWing();
  wingLInner.scale.x = -1;
  const wingL = new THREE.Group();
  wingL.position.set(-0.3, 0.18, 0.12);
  wingL.rotation.set(0, 0.5, -0.2);
  wingL.userData = { baseZ: -0.2, sign: -1 };
  wingL.add(wingLInner);
  group.add(wingR, wingL);

  /* ── haunches, shins, gold talons gripping the perch ── */
  [1, -1].forEach((sx) => {
    mesh(group, new THREE.IcosahedronGeometry(0.17, 0), MAT.scales, [sx * 0.38, -0.62, 0.2], null, [1, 1.25, 1]);
    bone(group, sx * 0.4, -0.68, 0.26, sx * 0.42, -0.94, 0.42, 0.05, 0.035, MAT.scales);
    [-0.07, 0, 0.07].forEach((dx) => {
      const claw = new THREE.ConeGeometry(0.028, 0.13, 4);
      claw.rotateX(2.35);
      mesh(group, claw, MAT.gold, [sx * 0.42 + dx, -0.97, 0.5]);
    });
  });

  /* ── obsidian perch rock ── */
  mesh(group, new THREE.DodecahedronGeometry(0.6, 0), MAT.obsidian, [0, -1.28, 0.05], [0.1, 0.4, 0.05], [1.3, 0.62, 1.05]);

  return {
    group,
    refs: { head, jawPivot, mouth, wingL, wingR, throat, chest },
    triCount: Math.round(triCount),
  };
}

/* UMD-ish escape hatch so the same file works in a plain <script> tag
   and in module bundlers. */
if (typeof module !== 'undefined' && module.exports) module.exports = { buildEmberwingDragon };
