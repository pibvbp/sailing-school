// Sailcloth material (spec §9.6): three's MeshPhysicalMaterial extended for thin, two-sided, translucent
// cloth. Additions:
//  - per-face decals (sail numbers read correctly from each side) chosen by gl_FrontFacing;
//  - transmission: sun and sky light arriving on the far face scatter through the cloth. One ply passes
//    `transmit`; seams, patches, tapes and battens (extra plies, from the base texture's alpha) pass far
//    less, and decals on EITHER face filter it — so seams, patches and the other side's numbers show dark
//    when the sail is backlit, as on real Dacron. A forward-scatter lobe makes the sun glow through; nylon's
//    dye tints the transmitted light and its ripstop grid shows against the light;
//  - surface relief as a physical height field (metres): ply edges from the texture, load wrinkles
//    radiating from the corners, scallops between the main's luff slides and a fine crinkle — the slope
//    per pixel footprint tilts the normal, so relief reads the same at every distance;
//  - crisp zig-zag seam stitching drawn analytically when the camera is close (the texture carries the
//    seams at distance);
//  - AoA colouring (blue luffing / green groove / red stalled) and an optional pressure overlay;
//  - directional-shadow normal bias always offset TOWARD the light (a single-sided normal would push the
//    lookup behind the cloth for the far face and self-shadow the sunlit side).
import * as THREE from 'three';
import type { PlanPoint, SailPlan } from './sailMesh';

export type ClothKind = 'dacron' | 'nylon';

export interface ClothTextures {
  /** RGB albedo (sRGB) · A = cloth thickness in plies / 4 (single ply = 0.25). */
  base: THREE.Texture;
  /** Premultiplied RGBA decals on the front (starboard for main and jib) and back faces. */
  decalFront: THREE.Texture;
  decalBack: THREE.Texture;
}

/** Where the procedural detail sits, in the sail's plan metres (see SailPlan). */
export interface ClothDetail {
  plan: SailPlan;
  /** Cross-cut seams: lines ⟂ `dir` at origin + k·panel·dir (k ≥ 1), as drawn in the texture. */
  seams?: { origin: PlanPoint; dir: PlanPoint; panel: number };
  /** Up to three corners with load wrinkles: position, reach (m), strength (0…1). */
  corners: Array<{ p: PlanPoint; reach: number; strength: number }>;
  /** Main only: slides every `spacing` metres pull the luff into small scallops. */
  luffSlides?: { spacing: number };
  /** Jib only: clear telltale windows (rounded rectangles, up to three) cut out of the cloth. */
  windows?: { centres: PlanPoint[]; half: PlanPoint; radius: number };
  /** Jib only: telltale ribbons lying on the far face show through as soft silhouettes (see setRibbons). */
  ribbons?: boolean;
}

export interface ClothMaterial {
  readonly material: THREE.MeshPhysicalMaterial;
  setColouring(on: boolean): void;
  /** Overlay sampled at (u chord fraction, v height fraction), blended by its alpha; null removes it. */
  setPressure(tex: THREE.Texture | null): void;
  /** 0 slack (luffing) … 1 hard-loaded: scales the corner wrinkles. */
  setLoad(load: number): void;
  /** Ribbon footprints from Telltales.writeFootprints (30 × vec4); ignored unless `ribbons` was set. */
  setRibbons(data: Float32Array): void;
  dispose(): void;
}

const VERT_PARS = /* glsl */`
attribute vec2 aSail;
attribute vec2 aState;
varying vec2 vSail;
varying vec2 vState;
void main() {`;

const VERT_SHADOW = /* glsl */`
#include <shadowmap_vertex>
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		{
			vec3 clothLightFwd = vec3( directionalShadowMatrix[ i ][ 0 ][ 2 ], directionalShadowMatrix[ i ][ 1 ][ 2 ], directionalShadowMatrix[ i ][ 2 ][ 2 ] );
			vec3 clothBiasN = dot( shadowWorldNormal, clothLightFwd ) > 0.0 ? - shadowWorldNormal : shadowWorldNormal;
			shadowWorldPosition = worldPosition + vec4( clothBiasN * directionalLightShadows[ i ].shadowNormalBias, 0.0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
	}
	#pragma unroll_loop_end
#endif`;

const FRAG_PARS = /* glsl */`
uniform sampler2D uBase;
uniform sampler2D uDecalFront;
uniform sampler2D uDecalBack;
uniform vec3 uTransmit;
uniform float uFwdAmt;
uniform float uFwdExp;
uniform float uPlyHeight;
uniform float uColouring;
uniform sampler2D uPressureMap;
uniform float uPressureOn;
uniform vec4 uPlan;
uniform vec4 uSeam;
uniform float uPanel;
uniform vec4 uCorner0;
uniform vec4 uCorner1;
uniform vec4 uCorner2;
uniform float uLoad;
uniform float uSlides;
#ifdef CLOTH_WINDOWS
	uniform vec2 uWindow[ 3 ];
	uniform vec3 uWindowShape;
#endif
#ifdef CLOTH_RIBBONS
	uniform vec4 uRibbon[ 30 ];
#endif
varying vec2 vSail;
varying vec2 vState;
vec3 clothTrans;

void RE_Direct_Cloth( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	// Light on the far face diffuses through the cloth; a forward lobe glows where the source is behind it.
	float back = saturate( - dot( geometryNormal, directLight.direction ) );
	float fwd = pow( saturate( dot( - geometryViewDir, directLight.direction ) ), uFwdExp );
	reflectedLight.directDiffuse += directLight.color * clothTrans * back * ( RECIPROCAL_PI + uFwdAmt * fwd );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Cloth

// Mikkelsen surface-gradient perturbation; dHdxy here is a physical slope (height / pixel footprint).
vec3 clothPerturb( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
	vec3 vSigmaX = normalize( dFdx( surfPos ) );
	vec3 vSigmaY = normalize( dFdy( surfPos ) );
	vec3 R1 = cross( vSigmaY, surfNorm );
	vec3 R2 = cross( surfNorm, vSigmaX );
	float fDet = dot( vSigmaX, R1 ) * faceDir;
	vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
	return normalize( abs( fDet ) * surfNorm - vGrad );
}

float clothHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float clothNoise( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( clothHash( i ), clothHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( clothHash( i + vec2( 0.0, 1.0 ) ), clothHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}

// Crow's-feet: shallow folds fanning out from a loaded corner (height in metres).
float clothCornerWrinkles( vec2 p, vec4 c ) {
	vec2 d = p - c.xy;
	float r = length( d );
	if ( c.w <= 0.0 || r > c.z ) return 0.0;
	float a = atan( d.y, d.x );
	float fan = sin( a * 24.0 + 1.8 * sin( a * 7.0 + r * 5.0 ) + r * 3.0 );
	float fold = fan * fan * sign( fan );
	float fade = smoothstep( 0.1, 0.3, r ) * ( 1.0 - smoothstep( 0.35 * c.z, c.z, r ) );
	return c.w * uLoad * 0.0022 * fade * fold;
}

void main() {`;

const FRAG_ALBEDO = /* glsl */`
#include <map_fragment>
vec2 planP = uPlan.xy + vUv * uPlan.zw;
#ifdef CLOTH_WINDOWS
	// Clear vinyl telltale windows: see straight through to the telltale on the other side.
	for ( int i = 0; i < 3; i ++ ) {
		vec2 q = abs( planP - uWindow[ i ] ) - uWindowShape.xy + uWindowShape.z;
		if ( length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - uWindowShape.z < 0.0 ) discard;
	}
#endif
vec4 clothBase = texture2D( uBase, vUv );
vec4 clothDF = texture2D( uDecalFront, vUv );
vec4 clothDB = texture2D( uDecalBack, vUv );
vec4 decalNear = gl_FrontFacing ? clothDF : clothDB;
vec4 decalFar = gl_FrontFacing ? clothDB : clothDF;
// Decals are premultiplied: colour over cloth, and a filter on the light passing through.
vec3 clothAlbedo = clothBase.rgb * ( 1.0 - decalNear.a ) + decalNear.rgb;
float clothPlies = clothBase.a * 4.0;
vec3 trans = uTransmit * exp( -1.45 * max( clothPlies - 1.0, 0.0 ) );
trans *= ( 1.0 - decalNear.a ) + decalNear.rgb * 0.3;
trans *= ( 1.0 - decalFar.a ) + decalFar.rgb * 0.3;
vec2 clothFw = fwidth( planP );
float clothFoot = max( clothFw.x, clothFw.y );
// Fibre density varies: backlit cloth is faintly mottled, never perfectly even.
trans *= 0.88 + 0.16 * clothNoise( planP * 9.0 ) + 0.08 * clothNoise( planP * 27.0 );
#ifdef CLOTH_NYLON
	trans *= pow( clothBase.rgb, vec3( 1.35 ) ) * 1.5;
	// Ripstop: heavier threads every 6 mm, visible up close and against the light.
	{
		vec2 g = abs( fract( planP / 0.006 ) - 0.5 ) * 0.006;
		float line = 1.0 - smoothstep( 0.00025, 0.00025 + clothFoot, min( g.x, g.y ) );
		float near = 1.0 - smoothstep( 0.0012, 0.003, clothFoot );
		trans *= 1.0 - 0.35 * line * near;
		clothAlbedo *= 1.0 + 0.04 * line * near;
	}
#else
	trans *= clothBase.rgb;
#endif
#ifdef CLOTH_SEAMS
	// Two rows of zig-zag stitching 5.5 mm either side of every seam, drawn only when close enough to see.
	if ( clothFoot < 0.003 ) {
		float s = dot( planP - uSeam.xy, uSeam.zw );
		float k = floor( s / uPanel + 0.5 );
		float d = s - k * uPanel;
		float along = dot( planP, vec2( - uSeam.w, uSeam.z ) );
		float zig = ( abs( fract( along / 0.0045 ) - 0.5 ) * 2.0 - 0.5 ) * 0.0026;
		float dThread = abs( abs( d ) - 0.0055 - zig );
		float thread = 1.0 - smoothstep( 0.0003, 0.0003 + clothFoot, dThread );
		float edge = 1.0 - smoothstep( 0.0002, 0.0002 + clothFoot, abs( abs( d ) - 0.009 ) );
		float near = ( 1.0 - smoothstep( 0.0012, 0.003, clothFoot ) ) * step( 0.5, k );
		clothAlbedo *= 1.0 - near * ( 0.32 * thread + 0.06 * edge );
		trans *= 1.0 - near * 0.5 * thread;
	}
#endif
#ifdef CLOTH_RIBBONS
	// A telltale lying against the far face blocks the light coming through the cloth: its silhouette shows.
	{
		float faceSide = gl_FrontFacing ? 1.0 : -1.0;
		float shade = 0.0;
		for ( int r = 0; r < 6; r ++ ) {
			vec4 head = uRibbon[ r * 5 ];
			if ( head.w == 0.0 || head.w == faceSide || distance( planP, head.xy ) > 0.35 ) continue;
			for ( int k = 0; k < 4; k ++ ) {
				vec4 a = uRibbon[ r * 5 + k ];
				vec4 b = uRibbon[ r * 5 + k + 1 ];
				vec2 ab = b.xy - a.xy;
				float h = clamp( dot( planP - a.xy, ab ) / max( dot( ab, ab ), 1e-8 ), 0.0, 1.0 );
				float d = length( planP - a.xy - ab * h );
				shade = max( shade, mix( a.z, b.z, h ) * ( 1.0 - smoothstep( 0.005, 0.009 + 1.5 * clothFoot, d ) ) );
			}
		}
		trans *= 1.0 - 0.8 * shade;
	}
#endif
if ( uColouring > 0.5 ) {
	// Teaching overlay: blue luffing, green in the groove, red stalled. Dark albedos, so the colours stay
	// saturated in full sun after tone mapping (AgX desaturates anything bright).
	vec3 aoaCol = mix( vec3( 0.015, 0.26, 0.04 ), vec3( 0.015, 0.07, 0.5 ), smoothstep( 0.05, 0.55, vState.x ) );
	aoaCol = mix( aoaCol, vec3( 0.55, 0.025, 0.015 ), smoothstep( 0.1, 0.65, vState.y ) );
	clothAlbedo = mix( clothAlbedo, aoaCol, 0.85 );
	trans = mix( trans, aoaCol * 0.35, 0.85 );
}
if ( uPressureOn > 0.5 ) {
	vec4 clothPm = texture2D( uPressureMap, vSail );
	clothAlbedo = mix( clothAlbedo, clothPm.rgb, clothPm.a );
	trans = mix( trans, clothPm.rgb * 0.3, clothPm.a );
}
diffuseColor.rgb *= clothAlbedo;
clothTrans = trans;`;

const FRAG_BUMP = /* glsl */`
#include <normal_fragment_maps>
{
	vec3 clothPos = - vViewPosition;
	float lx = max( length( dFdx( clothPos ) ), 1e-6 );
	float ly = max( length( dFdy( clothPos ) ), 1e-6 );
	// Ply thickness as physical height: its slope across one pixel tilts the normal.
	vec2 dSTdx = dFdx( vUv ), dSTdy = dFdy( vUv );
	float h0 = texture2D( uBase, vUv ).a;
	vec2 slope = vec2( texture2D( uBase, vUv + dSTdx ).a - h0, texture2D( uBase, vUv + dSTdy ).a - h0 ) * ( 4.0 * uPlyHeight ) / vec2( lx, ly );
	// Procedural relief (m): corner load wrinkles, luff scallops between slides, fine crinkle.
	float hp = clothCornerWrinkles( planP, uCorner0 ) + clothCornerWrinkles( planP, uCorner1 ) + clothCornerWrinkles( planP, uCorner2 );
	if ( uSlides > 0.0 ) {
		float yy = planP.y / uSlides;
		hp += uLoad * 0.0012 * ( 1.0 - cos( 6.2831853 * yy ) ) * exp( - max( planP.x, 0.0 ) / 0.09 );
	}
	float near = 1.0 - smoothstep( 0.0015, 0.004, clothFoot );
	hp += near * 0.00004 * ( clothNoise( planP * 380.0 ) + 0.5 * clothNoise( planP * 900.0 ) );
	slope += vec2( dFdx( hp ) / lx, dFdy( hp ) / ly );
	normal = clothPerturb( clothPos, normal, slope, faceDirection );
}`;

// Vinyl numbers and tape have no cloth sheen.
const FRAG_SHEEN = /* glsl */`
#include <lights_physical_fragment>
#ifdef USE_SHEEN
	material.sheenColor *= 1.0 - 0.9 * decalNear.a;
#endif`;

const FRAG_SKY_THROUGH = /* glsl */`
#include <lights_fragment_maps>
#if defined( RE_IndirectDiffuse )
{
	vec3 backIrr = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		backIrr += getIBLIrradiance( - geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			backIrr += getHemisphereLightIrradiance( hemisphereLights[ i ], - geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
	reflectedLight.indirectDiffuse += clothTrans * backIrr * RECIPROCAL_PI;
}
#endif`;

/**
 * Light passing through thin dyed nylon (telltales, burgee): the face away from the sun and sky still
 * glows in the fabric's colour. `transmit` is the fraction of its albedo that passes through.
 */
export function makeThinTranslucent(material: THREE.MeshStandardMaterial, transmit: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uThinTransmit'] = { value: transmit };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uThinTransmit;
void RE_Direct_Thin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	float back = saturate( - dot( geometryNormal, directLight.direction ) );
	reflectedLight.directDiffuse += directLight.color * material.diffuseColor * uThinTransmit * back * RECIPROCAL_PI;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Thin
void main() {`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectDiffuse ) && defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
	reflectedLight.indirectDiffuse += material.diffuseColor * uThinTransmit * getIBLIrradiance( - geometryNormal ) * RECIPROCAL_PI;
#endif`);
  };
  material.customProgramCacheKey = () => `thin-translucent-${transmit}`;
}

let blank: THREE.DataTexture | null = null;
/** 1×1 transparent texture for unused decal / overlay slots. */
export function blankTexture(): THREE.DataTexture {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    blank.needsUpdate = true;
  }
  return blank;
}

export function createClothMaterial(kind: ClothKind, tex: ClothTextures, detail: ClothDetail): ClothMaterial {
  const nylon = kind === 'nylon';
  const plan = detail.plan;
  const corner = (i: number) => {
    const c = detail.corners[i];
    return new THREE.Vector4(c?.p.x ?? 0, c?.p.y ?? 0, c?.reach ?? 0, c?.strength ?? 0);
  };
  const seams = detail.seams;
  const uniforms = {
    uBase: { value: tex.base },
    uDecalFront: { value: tex.decalFront },
    uDecalBack: { value: tex.decalBack },
    // Single-ply transmittance (linear): 4 oz Dacron passes about a third (slightly warm), light nylon ~50 %.
    uTransmit: { value: nylon ? new THREE.Color(0.52, 0.52, 0.52) : new THREE.Color(0.38, 0.355, 0.29) },
    uFwdAmt: { value: nylon ? 2.4 : 1.5 },
    uFwdExp: { value: nylon ? 9 : 4 },
    // Height of one ply (m), exaggerated ×2 for the stitching puckers along the edges.
    uPlyHeight: { value: nylon ? 0.0002 : 0.0006 },
    uColouring: { value: 0 },
    uPressureMap: { value: blankTexture() as THREE.Texture },
    uPressureOn: { value: 0 },
    uPlan: { value: new THREE.Vector4(plan.x0, plan.y0, plan.w, plan.h) },
    uSeam: { value: new THREE.Vector4(seams?.origin.x ?? 0, seams?.origin.y ?? 0, seams?.dir.x ?? 1, seams?.dir.y ?? 0) },
    uPanel: { value: seams?.panel ?? 1 },
    uCorner0: { value: corner(0) },
    uCorner1: { value: corner(1) },
    uCorner2: { value: corner(2) },
    uLoad: { value: 1 },
    uSlides: { value: detail.luffSlides?.spacing ?? 0 },
    uWindow: { value: [0, 1, 2].map((i) => new THREE.Vector2(detail.windows?.centres[i]?.x ?? -99, detail.windows?.centres[i]?.y ?? -99)) },
    uWindowShape: { value: new THREE.Vector3(detail.windows?.half.x ?? 0, detail.windows?.half.y ?? 0, detail.windows?.radius ?? 0) },
    uRibbon: { value: Array.from({ length: 30 }, () => new THREE.Vector4()) },
  };
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: nylon ? 0.36 : 0.6,
    metalness: 0,
    side: THREE.DoubleSide,
    specularIntensity: nylon ? 0.7 : 0.45,
    sheen: nylon ? 0.5 : 0.16,
    sheenRoughness: nylon ? 0.3 : 0.45,
    sheenColor: new THREE.Color(1, 1, 1),
  });
  material.name = nylon ? 'sail-nylon' : 'sail-dacron';
  const defines: Record<string, string> = { USE_UV: '' };
  if (nylon) defines['CLOTH_NYLON'] = '';
  if (seams) defines['CLOTH_SEAMS'] = '';
  if (detail.windows) defines['CLOTH_WINDOWS'] = '';
  if (detail.ribbons) defines['CLOTH_RIBBONS'] = '';
  material.defines = defines;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', VERT_PARS)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSail = aSail;\nvState = aState;')
      .replace('#include <shadowmap_vertex>', VERT_SHADOW);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', FRAG_PARS)
      .replace('#include <map_fragment>', FRAG_ALBEDO)
      .replace('#include <normal_fragment_maps>', FRAG_BUMP)
      .replace('#include <lights_physical_fragment>', FRAG_SHEEN)
      .replace('#include <lights_fragment_maps>', FRAG_SKY_THROUGH);
  };
  material.customProgramCacheKey = () => `sailcloth-${kind}`;
  return {
    material,
    setColouring(on) { uniforms.uColouring.value = on ? 1 : 0; },
    setPressure(t) {
      uniforms.uPressureMap.value = t ?? blankTexture();
      uniforms.uPressureOn.value = t ? 1 : 0;
    },
    setLoad(load) { uniforms.uLoad.value = Math.min(Math.max(load, 0), 1.5); },
    setRibbons(data) {
      const v = uniforms.uRibbon.value;
      for (let i = 0; i < 30; i++) v[i]!.set(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!, data[i * 4 + 3]!);
    },
    dispose() { material.dispose(); },
  };
}
