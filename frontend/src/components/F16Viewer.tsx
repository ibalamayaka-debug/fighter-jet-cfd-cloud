import React, { useCallback, useEffect, useRef, useState } from 'react';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkColorMaps from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction/ColorMaps';
import { ColorMode, ScalarMode } from '@kitware/vtk.js/Rendering/Core/Mapper/Constants';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor';
import { Box, Compass, Layers, Pause, Play, Sparkles, Wind } from 'lucide-react';
import { fetchVtpBuffer } from '../api';
import { TRANSLATIONS, type Lang } from '../i18n';
import type { F16PaletteMode, F16SimResponse, F16ViewState } from '../types';

interface F16ViewerProps {
  lang: Lang;
  result: F16SimResponse | null;
  view: F16ViewState;
  onTogglePlay: () => void;
  loading: boolean;
}

type RGB = [number, number, number];

// Van Gogh "Starry Night" velocity ramp: deep midnight indigo -> cerulean -> cyan swirl -> warm ochre -> radiant starlight gold
const STARRY_VEL_STOPS: Array<[number, RGB]> = [
  [0.0, [18, 34, 96]],
  [0.24, [37, 115, 235]],
  [0.5, [110, 215, 255]],
  [0.74, [234, 140, 22]],
  [1.0, [254, 240, 138]],
];

// Van Gogh "Starry Night" airframe Cp ramp: cobalt suction -> starlight cyan -> moonlit silver -> golden stagnation
const STARRY_CP_STOPS: Array<[number, RGB]> = [
  [0.0, [22, 42, 118]],
  [0.25, [56, 162, 248]],
  [0.52, [203, 213, 225]],
  [0.78, [234, 140, 22]],
  [1.0, [254, 240, 138]],
];

// Classic scientific velocity ramp
const SCI_VEL_STOPS: Array<[number, RGB]> = [
  [0.0, [27, 79, 156]],
  [0.25, [38, 169, 224]],
  [0.5, [95, 211, 141]],
  [0.75, [245, 195, 66]],
  [1.0, [201, 42, 42]],
];

const CP_SCI_GRADIENT =
  'linear-gradient(90deg, #3b4cc0 0%, #7b9ff9 25%, #e2e2e2 50%, #f4987a 75%, #b40426 100%)';
const CP_STARRY_GRADIENT =
  'linear-gradient(90deg, #162a76 0%, #38a2f8 25%, #cbd5e1 52%, #ea8c16 78%, #fef08a 100%)';
const VEL_SCI_GRADIENT =
  'linear-gradient(90deg, #1b4f9c 0%, #26a9e0 25%, #5fd38d 50%, #f5c342 75%, #c92a2a 100%)';
const VEL_STARRY_GRADIENT =
  'linear-gradient(90deg, #122260 0%, #2573eb 24%, #6ed7ff 50%, #ea8c16 74%, #fef08a 100%)';

const STEPS_PER_LINE = 68;
const TUBE_SIDES = 6;
const N_SPARKS = 280;

interface ResampledLine {
  pts: Float32Array;     // STEPS_PER_LINE * 3
  u: Float32Array;       // STEPS_PER_LINE
  normals: Float32Array; // STEPS_PER_LINE * 3
  binorms: Float32Array; // STEPS_PER_LINE * 3
  phase: number;
  waves: number;
  isGolden: boolean;
}

interface SparkSeed {
  lineIdx: number;
  offset: number;
  speedMul: number;
  radialR: number;
  radialAng: number;
  swirlFreq: number;
  goldTint: boolean;
}

interface AnimatedStreamData {
  lines: ResampledLine[];
  tubePoly: ReturnType<typeof vtkPolyData.newInstance>;
  tubePoints: Float32Array;
  tubeColors: Uint8Array;
  tubeColorArr: ReturnType<typeof vtkDataArray.newInstance>;
  sparkPoly: ReturnType<typeof vtkPolyData.newInstance>;
  sparkPoints: Float32Array;
  sparkColors: Uint8Array;
  sparkColorArr: ReturnType<typeof vtkDataArray.newInstance>;
  sparks: SparkSeed[];
  lastRadius: number;
}

interface SceneHandle {
  genericRW: ReturnType<typeof vtkGenericRenderWindow.newInstance>;
  jetActor: ReturnType<typeof vtkActor.newInstance>;
  jetMapper: ReturnType<typeof vtkMapper.newInstance>;
  streamActor: ReturnType<typeof vtkActor.newInstance>;
  streamMapper: ReturnType<typeof vtkMapper.newInstance>;
  sparkActor: ReturnType<typeof vtkActor.newInstance>;
  sparkMapper: ReturnType<typeof vtkMapper.newInstance>;
  starfieldActor: ReturnType<typeof vtkActor.newInstance>;
  sliceYActor: ReturnType<typeof vtkActor.newInstance>;
  sliceYMapper: ReturnType<typeof vtkMapper.newInstance>;
  sliceZActor: ReturnType<typeof vtkActor.newInstance>;
  sliceZMapper: ReturnType<typeof vtkMapper.newInstance>;
  cpLut: ReturnType<typeof vtkColorTransferFunction.newInstance>;
  flowLut: ReturnType<typeof vtkColorTransferFunction.newInstance>;
  orientWidget: ReturnType<typeof vtkOrientationMarkerWidget.newInstance> | null;
  anim: AnimatedStreamData | null;
  uRange: [number, number];
  dataLoaded: boolean;
}

const vtpCache = new Map<string, ArrayBuffer>();

async function getVtp(url: string): Promise<ArrayBuffer> {
  const hit = vtpCache.get(url);
  if (hit) return hit;
  const buf = await fetchVtpBuffer(url);
  vtpCache.set(url, buf);
  return buf;
}

function parseVtp(buf: ArrayBuffer) {
  const r = vtkXMLPolyDataReader.newInstance();
  r.parseAsArrayBuffer(buf);
  return r.getOutputData(0);
}

function sampleStops(stops: Array<[number, RGB]>, tRaw: number): RGB {
  const t = Math.min(Math.max(tRaw, 0), 1);
  let s0 = stops[0];
  let s1 = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      s0 = stops[i];
      s1 = stops[i + 1];
      break;
    }
  }
  const f = (t - s0[0]) / Math.max(s1[0] - s0[0], 1e-6);
  return [
    s0[1][0] + (s1[1][0] - s0[1][0]) * f,
    s0[1][1] + (s1[1][1] - s0[1][1]) * f,
    s0[1][2] + (s1[1][2] - s0[1][2]) * f,
  ];
}

function applyCustomStopsToLut(
  lut: ReturnType<typeof vtkColorTransferFunction.newInstance>,
  stops: Array<[number, RGB]>,
  minVal: number,
  maxVal: number
) {
  lut.removeAllPoints();
  const span = Math.max(maxVal - minVal, 1e-4);
  for (const [pos, [r, g, b]] of stops) {
    lut.addRGBPoint(minVal + pos * span, r / 255, g / 255, b / 255);
  }
  lut.setMappingRange(minVal, maxVal);
  lut.updateRange();
}

function buildStarfieldPolyData() {
  const nStars = 260;
  const pts = new Float32Array(nStars * 3);
  const verts = new Uint32Array(nStars * 2);
  const colors = new Uint8Array(nStars * 4);

  let seed = 188906;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < nStars; i++) {
    const u = rand();
    const v = rand();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const radius = 44 + rand() * 28;
    pts[i * 3 + 0] = radius * Math.sin(phi) * Math.cos(theta);
    pts[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    pts[i * 3 + 2] = radius * Math.cos(phi);

    verts[i * 2 + 0] = 1;
    verts[i * 2 + 1] = i;

    const warmStar = rand() > 0.35;
    const bright = 0.55 + rand() * 0.45;
    colors[i * 4 + 0] = Math.round((warmStar ? 254 : 165) * bright);
    colors[i * 4 + 1] = Math.round((warmStar ? 236 : 220) * bright);
    colors[i * 4 + 2] = Math.round((warmStar ? 148 : 255) * bright);
    colors[i * 4 + 3] = Math.round(150 + rand() * 105);
  }

  const poly = vtkPolyData.newInstance();
  const vtkPts = vtkPoints.newInstance();
  vtkPts.setData(pts, 3);
  poly.setPoints(vtkPts);
  const vtkVerts = vtkCellArray.newInstance();
  vtkVerts.setData(verts);
  poly.setVerts(vtkVerts);
  const colArr = vtkDataArray.newInstance({
    name: 'StarRGBA',
    values: colors,
    numberOfComponents: 4,
  });
  poly.getPointData().setScalars(colArr);
  return poly;
}

function buildAnimatedStreams(
  rawStreamPoly: ReturnType<typeof parseVtp>,
  uInf: number,
  radius: number
): AnimatedStreamData {
  const rawPts = rawStreamPoly.getPoints().getData() as Float32Array | Float64Array;
  const rawLines = rawStreamPoly.getLines().getData() as Uint32Array | Int32Array;
  const rawUArr = rawStreamPoly.getPointData().getArrayByName('U_mag');
  const rawU = rawUArr ? (rawUArr.getData() as Float32Array | Float64Array) : null;

  const lines: ResampledLine[] = [];
  let cursor = 0;
  let lineCounter = 0;
  const minSpeed = Math.max(uInf * 0.18, 8.0);

  while (cursor < rawLines.length) {
    const n = rawLines[cursor];
    cursor += 1;
    if (n < 4) {
      cursor += n;
      continue;
    }

    // Compute physical advection time tCum along this real OpenFOAM streamline
    const tCum = new Float32Array(n);
    tCum[0] = 0;
    for (let k = 1; k < n; k++) {
      const i0 = rawLines[cursor + k - 1];
      const i1 = rawLines[cursor + k];
      const dx = rawPts[i1 * 3 + 0] - rawPts[i0 * 3 + 0];
      const dy = rawPts[i1 * 3 + 1] - rawPts[i0 * 3 + 1];
      const dz = rawPts[i1 * 3 + 2] - rawPts[i0 * 3 + 2];
      const ds = Math.hypot(dx, dy, dz);
      const u0 = rawU ? rawU[i0] : uInf;
      const u1 = rawU ? rawU[i1] : uInf;
      const uAvg = Math.max(0.5 * (u0 + u1), minSpeed);
      tCum[k] = tCum[k - 1] + ds / uAvg;
    }
    const totalT = tCum[n - 1];
    if (totalT <= 1e-5) {
      cursor += n;
      continue;
    }

    const pts = new Float32Array(STEPS_PER_LINE * 3);
    const uVals = new Float32Array(STEPS_PER_LINE);
    let seg = 0;
    for (let s = 0; s < STEPS_PER_LINE; s++) {
      const targetT = (s / (STEPS_PER_LINE - 1)) * totalT;
      while (seg < n - 2 && tCum[seg + 1] < targetT) seg++;
      const dt = Math.max(tCum[seg + 1] - tCum[seg], 1e-8);
      const f = Math.min(Math.max((targetT - tCum[seg]) / dt, 0), 1);
      const i0 = rawLines[cursor + seg];
      const i1 = rawLines[cursor + seg + 1];
      pts[s * 3 + 0] = rawPts[i0 * 3 + 0] + (rawPts[i1 * 3 + 0] - rawPts[i0 * 3 + 0]) * f;
      pts[s * 3 + 1] = rawPts[i0 * 3 + 1] + (rawPts[i1 * 3 + 1] - rawPts[i0 * 3 + 1]) * f;
      pts[s * 3 + 2] = rawPts[i0 * 3 + 2] + (rawPts[i1 * 3 + 2] - rawPts[i0 * 3 + 2]) * f;
      const u0 = rawU ? rawU[i0] : uInf;
      const u1 = rawU ? rawU[i1] : uInf;
      uVals[s] = u0 + (u1 - u0) * f;
    }

    // Parallel-transport Frenet frames for twist-free smooth thin tubes
    const normals = new Float32Array(STEPS_PER_LINE * 3);
    const binorms = new Float32Array(STEPS_PER_LINE * 3);
    let nx = 0;
    let ny = 0;
    let nz = 1;

    for (let s = 0; s < STEPS_PER_LINE; s++) {
      const sPrev = Math.max(0, s - 1);
      const sNext = Math.min(STEPS_PER_LINE - 1, s + 1);
      let tx = pts[sNext * 3 + 0] - pts[sPrev * 3 + 0];
      let ty = pts[sNext * 3 + 1] - pts[sPrev * 3 + 1];
      let tz = pts[sNext * 3 + 2] - pts[sPrev * 3 + 2];
      const tLen = Math.hypot(tx, ty, tz) || 1;
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;

      if (s === 0) {
        const upX = Math.abs(tz) > 0.9 ? 0 : 0;
        const upY = Math.abs(tz) > 0.9 ? 1 : 0;
        const upZ = Math.abs(tz) > 0.9 ? 0 : 1;
        // n = normalize(up - (up·t) t)
        const dot = upX * tx + upY * ty + upZ * tz;
        nx = upX - dot * tx;
        ny = upY - dot * ty;
        nz = upZ - dot * tz;
      } else {
        const dot = nx * tx + ny * ty + nz * tz;
        nx -= dot * tx;
        ny -= dot * ty;
        nz -= dot * tz;
      }
      const nLen = Math.hypot(nx, ny, nz) || 1;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      const bx = ty * nz - tz * ny;
      const by = tz * nx - tx * nz;
      const bz = tx * ny - ty * nx;

      normals[s * 3 + 0] = nx;
      normals[s * 3 + 1] = ny;
      normals[s * 3 + 2] = nz;
      binorms[s * 3 + 0] = bx;
      binorms[s * 3 + 1] = by;
      binorms[s * 3 + 2] = bz;
    }

    const h = Math.sin((lineCounter + 1) * 12.9898) * 43758.5453;
    const phase = h - Math.floor(h);
    const h2 = Math.sin((lineCounter + 7) * 78.233) * 19341.231;
    const frac2 = h2 - Math.floor(h2);

    lines.push({
      pts,
      u: uVals,
      normals,
      binorms,
      phase,
      waves: 2.5 + frac2 * 1.1,
      isGolden: lineCounter % 3 === 0 || frac2 > 0.58,
    });

    lineCounter += 1;
    cursor += n;
  }

  const nLines = lines.length;
  const vertsPerLine = STEPS_PER_LINE * TUBE_SIDES;
  const totalVerts = nLines * vertsPerLine;
  const tubePoints = new Float32Array(totalVerts * 3);
  const tubeColors = new Uint8Array(totalVerts * 4);

  // Build quad strip topology as triangles (2 tris per quad, 4 ints per tri: [3, a, b, c])
  const quadsPerLine = (STEPS_PER_LINE - 1) * TUBE_SIDES;
  const polys = new Uint32Array(nLines * quadsPerLine * 2 * 4);
  let pIdx = 0;
  for (let l = 0; l < nLines; l++) {
    const baseV = l * vertsPerLine;
    for (let s = 0; s < STEPS_PER_LINE - 1; s++) {
      const r0 = baseV + s * TUBE_SIDES;
      const r1 = baseV + (s + 1) * TUBE_SIDES;
      for (let k = 0; k < TUBE_SIDES; k++) {
        const kn = (k + 1) % TUBE_SIDES;
        const a = r0 + k;
        const b = r0 + kn;
        const c = r1 + kn;
        const d = r1 + k;
        polys[pIdx++] = 3;
        polys[pIdx++] = a;
        polys[pIdx++] = b;
        polys[pIdx++] = c;
        polys[pIdx++] = 3;
        polys[pIdx++] = a;
        polys[pIdx++] = c;
        polys[pIdx++] = d;
      }
    }
  }

  const tubePoly = vtkPolyData.newInstance();
  const vtkTubePts = vtkPoints.newInstance();
  vtkTubePts.setData(tubePoints, 3);
  tubePoly.setPoints(vtkTubePts);
  const vtkTubePolys = vtkCellArray.newInstance();
  vtkTubePolys.setData(polys);
  tubePoly.setPolys(vtkTubePolys);
  const tubeColorArr = vtkDataArray.newInstance({
    name: 'BrushRGBA',
    values: tubeColors,
    numberOfComponents: 4,
  });
  tubePoly.getPointData().setScalars(tubeColorArr);

  // Build 280 surfing 3D stardust sparks along the streamlines
  const sparks: SparkSeed[] = [];
  const sparkCount = nLines > 0 ? N_SPARKS : 0;
  const sparkPoints = new Float32Array(sparkCount * 3);
  const sparkColors = new Uint8Array(sparkCount * 4);
  const sparkVerts = new Uint32Array(sparkCount * 2);

  let sSeed = 202611;
  const sRand = () => {
    sSeed = (sSeed * 1664525 + 1013904223) >>> 0;
    return sSeed / 4294967296;
  };

  for (let i = 0; i < sparkCount; i++) {
    sparks.push({
      lineIdx: i % nLines,
      offset: sRand(),
      speedMul: 0.85 + sRand() * 0.45,
      radialR: 0.06 + sRand() * 0.22,
      radialAng: sRand() * Math.PI * 2,
      swirlFreq: (sRand() > 0.5 ? 1 : -1) * (5.0 + sRand() * 8.0),
      goldTint: sRand() > 0.42,
    });
    sparkVerts[i * 2 + 0] = 1;
    sparkVerts[i * 2 + 1] = i;
  }

  const sparkPoly = vtkPolyData.newInstance();
  const vtkSparkPts = vtkPoints.newInstance();
  vtkSparkPts.setData(sparkPoints, 3);
  sparkPoly.setPoints(vtkSparkPts);
  const vtkSparkVerts = vtkCellArray.newInstance();
  vtkSparkVerts.setData(sparkVerts);
  sparkPoly.setVerts(vtkSparkVerts);
  const sparkColorArr = vtkDataArray.newInstance({
    name: 'SparkRGBA',
    values: sparkColors,
    numberOfComponents: 4,
  });
  sparkPoly.getPointData().setScalars(sparkColorArr);

  const animData: AnimatedStreamData = {
    lines,
    tubePoly,
    tubePoints,
    tubeColors,
    tubeColorArr,
    sparkPoly,
    sparkPoints,
    sparkColors,
    sparkColorArr,
    sparks,
    lastRadius: -1,
  };
  updateTubeRadius(animData, radius);
  return animData;
}

function updateTubeRadius(anim: AnimatedStreamData, radius: number) {
  if (Math.abs(anim.lastRadius - radius) < 1e-5) return;
  anim.lastRadius = radius;
  const cosTable = new Float32Array(TUBE_SIDES);
  const sinTable = new Float32Array(TUBE_SIDES);
  for (let k = 0; k < TUBE_SIDES; k++) {
    const a = (k / TUBE_SIDES) * Math.PI * 2;
    cosTable[k] = Math.cos(a) * radius;
    sinTable[k] = Math.sin(a) * radius;
  }

  const out = anim.tubePoints;
  let vOff = 0;
  for (let l = 0; l < anim.lines.length; l++) {
    const line = anim.lines[l];
    const pts = line.pts;
    const nrm = line.normals;
    const bnm = line.binorms;
    for (let s = 0; s < STEPS_PER_LINE; s++) {
      const p3 = s * 3;
      const px = pts[p3 + 0];
      const py = pts[p3 + 1];
      const pz = pts[p3 + 2];
      const nx = nrm[p3 + 0];
      const ny = nrm[p3 + 1];
      const nz = nrm[p3 + 2];
      const bx = bnm[p3 + 0];
      const by = bnm[p3 + 1];
      const bz = bnm[p3 + 2];
      for (let k = 0; k < TUBE_SIDES; k++) {
        const c = cosTable[k];
        const sn = sinTable[k];
        out[vOff++] = px + nx * c + bx * sn;
        out[vOff++] = py + ny * c + by * sn;
        out[vOff++] = pz + nz * c + bz * sn;
      }
    }
  }
  anim.tubePoly.getPoints().modified();
  anim.tubePoly.modified();
}

function updateAnimatedFrame(
  anim: AnimatedStreamData,
  simTime: number,
  uMin: number,
  uMax: number,
  palette: F16PaletteMode,
  showSparks: boolean
) {
  const span = Math.max(uMax - uMin, 1e-4);
  const stops = palette === 'starry' ? STARRY_VEL_STOPS : SCI_VEL_STOPS;
  const cols = anim.tubeColors;
  let cOff = 0;

  for (let l = 0; l < anim.lines.length; l++) {
    const line = anim.lines[l];
    const uArr = line.u;
    const waves = line.waves;
    const phase0 = line.phase;

    for (let s = 0; s < STEPS_PER_LINE; s++) {
      const tFrac = s / (STEPS_PER_LINE - 1);
      const uNorm = Math.min(Math.max((uArr[s] - uMin) / span, 0), 1);
      const [br, bg, bb] = sampleStops(stops, uNorm);

      // Traveling Van Gogh brushstroke comet moving along +t (nose -> wing -> wake)
      const rawPhase = tFrac * waves - simTime * 0.42 + phase0;
      const cyc = rawPhase - Math.floor(rawPhase);

      let pulse = 0;
      if (cyc > 0.34) {
        if (cyc < 0.9) {
          const uTail = (cyc - 0.34) / 0.56;
          pulse = uTail * uTail;
        } else {
          // Soft leading tip fade so comet head isn't jagged
          pulse = 1.0 - (cyc - 0.9) / 0.1 * 0.25;
        }
      }

      // Fade in/out gently at streamline start & far wake end
      const edgeFade = Math.min(tFrac * 10, (1 - tFrac) * 8, 1);

      let r = br;
      let g = bg;
      let b = bb;
      let alpha: number;

      if (palette === 'starry') {
        // Luminous Van Gogh oil-paint glow on brushstroke heads
        const tipGlow = pulse * pulse;
        const targetR = line.isGolden || uNorm > 0.62 ? 254 : 155;
        const targetG = line.isGolden || uNorm > 0.62 ? 240 : 228;
        const targetB = line.isGolden || uNorm > 0.62 ? 138 : 255;
        r = br + (targetR - br) * tipGlow * 0.72;
        g = bg + (targetG - bg) * tipGlow * 0.72;
        b = bb + (targetB - bb) * tipGlow * 0.72;
        alpha = (36 + pulse * 214) * edgeFade;
      } else {
        // Scientific mode: crisp velocity colors with clean flowing highlight
        const lift = pulse * 0.32;
        r = br + (255 - br) * lift;
        g = bg + (255 - bg) * lift;
        b = bb + (255 - bb) * lift;
        alpha = (75 + pulse * 175) * edgeFade;
      }

      const ri = Math.min(255, Math.max(0, r | 0));
      const gi = Math.min(255, Math.max(0, g | 0));
      const bi = Math.min(255, Math.max(0, b | 0));
      const ai = Math.min(255, Math.max(0, alpha | 0));

      for (let k = 0; k < TUBE_SIDES; k++) {
        cols[cOff++] = ri;
        cols[cOff++] = gi;
        cols[cOff++] = bi;
        cols[cOff++] = ai;
      }
    }
  }
  anim.tubeColorArr.modified();

  if (showSparks && anim.sparks.length > 0) {
    const spPts = anim.sparkPoints;
    const spCols = anim.sparkColors;
    for (let i = 0; i < anim.sparks.length; i++) {
      const sp = anim.sparks[i];
      const line = anim.lines[sp.lineIdx];
      const progRaw = sp.offset + simTime * 0.24 * sp.speedMul;
      const prog = progRaw - Math.floor(progRaw);
      const fIdx = prog * (STEPS_PER_LINE - 1);
      const s0 = Math.min(STEPS_PER_LINE - 2, Math.floor(fIdx));
      const frac = fIdx - s0;
      const p0 = s0 * 3;
      const p1 = (s0 + 1) * 3;

      const cx = line.pts[p0 + 0] + (line.pts[p1 + 0] - line.pts[p0 + 0]) * frac;
      const cy = line.pts[p0 + 1] + (line.pts[p1 + 1] - line.pts[p0 + 1]) * frac;
      const cz = line.pts[p0 + 2] + (line.pts[p1 + 2] - line.pts[p0 + 2]) * frac;

      const ang = sp.radialAng + prog * sp.swirlFreq;
      // Gently expand helical swirl as particles travel into the wingtip/LEX wake
      const swirlR = sp.radialR * (0.45 + prog * 0.9);
      const ca = Math.cos(ang) * swirlR;
      const sa = Math.sin(ang) * swirlR;

      spPts[i * 3 + 0] = cx + line.normals[p0 + 0] * ca + line.binorms[p0 + 0] * sa;
      spPts[i * 3 + 1] = cy + line.normals[p0 + 1] * ca + line.binorms[p0 + 1] * sa;
      spPts[i * 3 + 2] = cz + line.normals[p0 + 2] * ca + line.binorms[p0 + 2] * sa;

      const fade = Math.sin(prog * Math.PI);
      const uLocal = line.u[s0];
      const uNorm = Math.min(Math.max((uLocal - uMin) / span, 0), 1);
      const warm = sp.goldTint || uNorm > 0.6;
      spCols[i * 4 + 0] = warm ? 254 : 140;
      spCols[i * 4 + 1] = warm ? 240 : 225;
      spCols[i * 4 + 2] = warm ? 138 : 255;
      spCols[i * 4 + 3] = Math.round(240 * Math.max(fade, 0.08));
    }
    anim.sparkPoly.getPoints().modified();
    anim.sparkColorArr.modified();
  }
}

export const F16Viewer: React.FC<F16ViewerProps> = ({
  lang,
  result,
  view,
  onTogglePlay,
  loading,
}) => {
  const t = TRANSLATIONS[lang];
  const langRef = useRef<Lang>(lang);
  langRef.current = lang;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const viewRef = useRef<F16ViewState>(view);
  viewRef.current = view;
  const simTimeRef = useRef<number>(0);
  const hasInitCam = useRef(false);

  const [meshStatus, setMeshStatus] = useState<string>('');
  const [velRange, setVelRange] = useState<[number, number]>([40, 240]);

  const applyView = useCallback((s: SceneHandle, res: F16SimResponse, v: F16ViewState) => {
    if (!s.dataLoaded) return;
    const uInf = res.metrics.params.speed_ms;
    const uMin = Math.max(10, Math.round(uInf * 0.25));
    const uMax = Math.max(uInf * 1.25, res.metrics.fields.u_max_ms);
    s.uRange = [uMin, uMax];
    setVelRange([uMin, uMax]);

    const ren = s.genericRW.getRenderer();
    if (v.palette === 'starry') {
      ren.setBackground(0.032, 0.052, 0.128);
      applyCustomStopsToLut(s.cpLut, STARRY_CP_STOPS, -1.2, 1.0);
      applyCustomStopsToLut(s.flowLut, STARRY_VEL_STOPS, uMin, uMax);
    } else {
      ren.setBackground(0.105, 0.082, 0.066);
      s.cpLut.applyColorMap(vtkColorMaps.getPresetByName('Cool to Warm'));
      s.cpLut.setMappingRange(-1.2, 1.0);
      s.cpLut.updateRange();
      s.flowLut.applyColorMap(
        vtkColorMaps.getPresetByName('Rainbow Desaturated') ||
          vtkColorMaps.getPresetByName('Cool to Warm')
      );
      s.flowLut.setMappingRange(uMin, uMax);
      s.flowLut.updateRange();
    }

    s.starfieldActor.setVisibility(v.palette === 'starry');

    s.jetActor.setVisibility(v.showJet);
    s.jetActor.getProperty().setRepresentation(v.wireframe ? 1 : 2);

    if (s.anim) {
      updateTubeRadius(s.anim, v.streamRadius);
      updateAnimatedFrame(
        s.anim,
        simTimeRef.current,
        uMin,
        uMax,
        v.palette,
        v.showStreams && v.palette === 'starry'
      );
    }
    s.streamActor.setVisibility(v.showStreams);
    s.sparkActor.setVisibility(v.showStreams && v.palette === 'starry');

    s.sliceYMapper.setScalarRange(uMin, uMax);
    s.sliceYActor.setVisibility(v.showSliceY);
    s.sliceYActor.getProperty().setOpacity(v.sliceOpacity);

    s.sliceZMapper.setScalarRange(uMin, uMax);
    s.sliceZActor.setVisibility(v.showSliceZ);
    s.sliceZActor.getProperty().setOpacity(v.sliceOpacity);

    s.genericRW.getRenderWindow().render();
  }, []);

  const setCameraPreset = useCallback((preset: 'chase' | 'wake' | 'side' | 'top') => {
    const s = sceneRef.current;
    if (!s) return;
    const ren = s.genericRW.getRenderer();
    const cam = ren.getActiveCamera();
    cam.setFocalPoint(0.5, 0.0, 0.7);
    if (preset === 'wake') {
      cam.setPosition(23.0, 4.0, 4.5);
      cam.setViewUp(0, 0, 1);
    } else if (preset === 'side') {
      cam.setPosition(0.5, -24.0, 1.0);
      cam.setViewUp(0, 0, 1);
    } else if (preset === 'top') {
      cam.setPosition(0.5, 0.0, 26.0);
      cam.setViewUp(0, 1, 0);
    } else {
      cam.setPosition(-15.5, -16.0, 8.5);
      cam.setViewUp(0, 0, 1);
    }
    ren.resetCameraClippingRange();
    s.genericRW.getRenderWindow().render();
  }, []);

  // Initialize VTK.js WebGL scene + 60 FPS Starry Night animation loop
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    const genericRW = vtkGenericRenderWindow.newInstance({
      background: [0.032, 0.052, 0.128],
    });
    genericRW.setContainer(el);
    genericRW.resize();

    const renderer = genericRW.getRenderer();
    const interactor = genericRW.getInteractor();

    const cpLut = vtkColorTransferFunction.newInstance();
    applyCustomStopsToLut(cpLut, STARRY_CP_STOPS, -1.2, 1.0);

    const flowLut = vtkColorTransferFunction.newInstance();
    applyCustomStopsToLut(flowLut, STARRY_VEL_STOPS, 40, 240);

    // Actor 0: 3D Van Gogh Starry Night Sky Sphere
    const starMapper = vtkMapper.newInstance();
    starMapper.setInputData(buildStarfieldPolyData());
    starMapper.setColorMode(ColorMode.DIRECT_SCALARS);
    starMapper.setScalarMode(ScalarMode.USE_POINT_DATA);
    starMapper.setScalarVisibility(true);
    const starfieldActor = vtkActor.newInstance();
    starfieldActor.setMapper(starMapper);
    starfieldActor.getProperty().setPointSize(2.8);
    starfieldActor.getProperty().setLighting(false);
    starfieldActor.getProperty().setOpacity(0.95);
    renderer.addActor(starfieldActor);

    // Actor 1: F-16 Airframe colored by Cp
    const jetMapper = vtkMapper.newInstance();
    jetMapper.setLookupTable(cpLut);
    jetMapper.setColorMode(ColorMode.MAP_SCALARS);
    jetMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    jetMapper.setColorByArrayName('Cp');
    jetMapper.setScalarRange(-1.2, 1.0);
    jetMapper.setScalarVisibility(true);
    const jetActor = vtkActor.newInstance();
    jetActor.setMapper(jetMapper);
    jetActor.setVisibility(false);
    jetActor.getProperty().setAmbient(0.36);
    jetActor.getProperty().setDiffuse(0.68);
    jetActor.getProperty().setSpecular(0.38);
    jetActor.getProperty().setSpecularPower(30);
    renderer.addActor(jetActor);

    // Actor 2: 60 FPS Animated Van Gogh Brushstroke 3D Streamline Tubes
    const streamMapper = vtkMapper.newInstance();
    streamMapper.setColorMode(ColorMode.DIRECT_SCALARS);
    streamMapper.setScalarMode(ScalarMode.USE_POINT_DATA);
    streamMapper.setScalarVisibility(true);
    const streamActor = vtkActor.newInstance();
    streamActor.setMapper(streamMapper);
    streamActor.setVisibility(false);
    streamActor.getProperty().setAmbient(0.86);
    streamActor.getProperty().setDiffuse(0.24);
    streamActor.getProperty().setOpacity(0.99);
    renderer.addActor(streamActor);

    // Actor 2b: 280 Luminous 3D Stardust Vortex Particles surfing the streamlines
    const sparkMapper = vtkMapper.newInstance();
    sparkMapper.setColorMode(ColorMode.DIRECT_SCALARS);
    sparkMapper.setScalarMode(ScalarMode.USE_POINT_DATA);
    sparkMapper.setScalarVisibility(true);
    const sparkActor = vtkActor.newInstance();
    sparkActor.setMapper(sparkMapper);
    sparkActor.setVisibility(false);
    sparkActor.getProperty().setPointSize(4.0);
    sparkActor.getProperty().setLighting(false);
    sparkActor.getProperty().setOpacity(0.96);
    renderer.addActor(sparkActor);

    // Actor 3: Centerline Vertical Velocity Slice (y ~ 0)
    const sliceYMapper = vtkMapper.newInstance();
    sliceYMapper.setLookupTable(flowLut);
    sliceYMapper.setColorMode(ColorMode.MAP_SCALARS);
    sliceYMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    sliceYMapper.setColorByArrayName('U_mag');
    sliceYMapper.setScalarVisibility(true);
    const sliceYActor = vtkActor.newInstance();
    sliceYActor.setMapper(sliceYMapper);
    sliceYActor.setVisibility(false);
    renderer.addActor(sliceYActor);

    // Actor 4: Horizontal Wing-Plane Velocity Slice (z ~ 0)
    const sliceZMapper = vtkMapper.newInstance();
    sliceZMapper.setLookupTable(flowLut);
    sliceZMapper.setColorMode(ColorMode.MAP_SCALARS);
    sliceZMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    sliceZMapper.setColorByArrayName('U_mag');
    sliceZMapper.setScalarVisibility(true);
    const sliceZActor = vtkActor.newInstance();
    sliceZActor.setMapper(sliceZMapper);
    sliceZActor.setVisibility(false);
    renderer.addActor(sliceZActor);

    renderer.resetCamera();
    genericRW.getRenderWindow().render();

    let orientWidget: ReturnType<typeof vtkOrientationMarkerWidget.newInstance> | null = null;
    try {
      const cube = vtkAnnotatedCubeActor.newInstance();
      cube.setDefaultStyle({
        text: '+X',
        fontStyle: 'bold',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontColor: '#fdf6ee',
        fontSizeScale: (res: number) => res / 2.2,
        faceColor: '#1e2948',
        edgeThickness: 0.12,
        edgeColor: '#fbbf24',
        resolution: 256,
      });
      cube.setXPlusFaceProperty({ text: 'TAIL' });
      cube.setXMinusFaceProperty({ text: 'NOSE' });
      cube.setYPlusFaceProperty({ text: 'L' });
      cube.setYMinusFaceProperty({ text: 'R' });
      cube.setZPlusFaceProperty({ text: 'TOP' });
      cube.setZMinusFaceProperty({ text: 'BOT' });

      orientWidget = vtkOrientationMarkerWidget.newInstance({
        actor: cube,
        interactor,
        parentRenderer: renderer,
        viewportCorner: vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT,
        viewportSize: 0.15,
        minPixelSize: 76,
        maxPixelSize: 118,
      });
      orientWidget.setEnabled(true);
    } catch {
      orientWidget = null;
    }

    sceneRef.current = {
      genericRW,
      jetActor,
      jetMapper,
      streamActor,
      streamMapper,
      sparkActor,
      sparkMapper,
      starfieldActor,
      sliceYActor,
      sliceYMapper,
      sliceZActor,
      sliceZMapper,
      cpLut,
      flowLut,
      orientWidget,
      anim: null,
      uRange: [40, 240],
      dataLoaded: false,
    };

    const ro = new ResizeObserver(() => {
      if (!disposed) genericRW.resize();
    });
    ro.observe(el);

    // Silky 60 FPS Van Gogh Starry Night advection loop
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (ts: number) => {
      if (disposed) return;
      const dt = Math.min((ts - lastTs) / 1000, 0.05);
      lastTs = ts;

      const s = sceneRef.current;
      const v = viewRef.current;
      if (s && s.dataLoaded && s.anim && v.showStreams && v.playing) {
        simTimeRef.current += dt * v.flowSpeed;
        updateAnimatedFrame(
          s.anim,
          simTimeRef.current,
          s.uRange[0],
          s.uRange[1],
          v.palette,
          v.palette === 'starry'
        );
        s.genericRW.getRenderWindow().render();
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      if (orientWidget) {
        try {
          orientWidget.setEnabled(false);
          orientWidget.delete();
        } catch {
          // ignore
        }
      }
      try {
        genericRW.delete();
      } catch {
        // ignore
      }
      sceneRef.current = null;
    };
  }, []);

  // Load VTP meshes when result changes
  useEffect(() => {
    if (!result || !sceneRef.current) return;
    let cancelled = false;

    const loadAll = async () => {
      setMeshStatus(TRANSLATIONS[langRef.current].loadingVtp);
      try {
        const [jetBuf, streamBuf, syBuf, szBuf] = await Promise.all([
          getVtp(result.urls.jet),
          getVtp(result.urls.streamlines),
          getVtp(result.urls.slice_y),
          getVtp(result.urls.slice_z),
        ]);
        if (cancelled || !sceneRef.current) return;

        const s = sceneRef.current;
        s.jetMapper.setInputData(parseVtp(jetBuf));

        const anim = buildAnimatedStreams(
          parseVtp(streamBuf),
          result.metrics.params.speed_ms,
          viewRef.current.streamRadius
        );
        s.anim = anim;
        s.streamMapper.setInputData(anim.tubePoly);
        s.sparkMapper.setInputData(anim.sparkPoly);

        s.sliceYMapper.setInputData(parseVtp(syBuf));
        s.sliceZMapper.setInputData(parseVtp(szBuf));
        s.dataLoaded = true;

        applyView(s, result, viewRef.current);
        if (!hasInitCam.current) {
          setCameraPreset('chase');
          hasInitCam.current = true;
        }
        setMeshStatus('');
      } catch (err) {
        if (!cancelled) setMeshStatus((err as Error).message);
      }
    };

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [result, applyView, setCameraPreset]);

  useEffect(() => {
    if (sceneRef.current?.dataLoaded && result) {
      applyView(sceneRef.current, result, view);
    }
  }, [result, view, applyView]);

  const isStarry = view.palette === 'starry';

  return (
    <div className="viewer-shell">
      <div ref={containerRef} className="vtk-canvas" />

      <div className="viewer-toolbar">
        <button
          type="button"
          className={view.playing ? 'active' : ''}
          onClick={onTogglePlay}
        >
          {view.playing ? <Pause size={14} /> : <Play size={14} />}
          {view.playing ? t.pauseFlow : t.playFlow}
        </button>
        <button type="button" onClick={() => setCameraPreset('chase')}>
          <Box size={14} /> {t.camChase}
        </button>
        <button type="button" onClick={() => setCameraPreset('wake')}>
          <Wind size={14} /> {t.camWake}
        </button>
        <button type="button" onClick={() => setCameraPreset('side')}>
          <Layers size={14} /> {t.camSide}
        </button>
        <button type="button" onClick={() => setCameraPreset('top')}>
          <Compass size={14} /> {t.camTop}
        </button>
      </div>

      {result && (
        <div className="colorbars-stack">
          {view.showJet && (
            <div className="colorbar-card">
              <div className="colorbar-header">
                <span>{t.colorbarCp}</span>
                <span className="colorbar-unit">Cp</span>
              </div>
              <div
                className="colorbar-strip"
                style={{ background: isStarry ? CP_STARRY_GRADIENT : CP_SCI_GRADIENT }}
              />
              <div className="colorbar-ticks">
                <span>{t.colorbarSuction}</span>
                <span>0.0</span>
                <span>{t.colorbarStag}</span>
              </div>
            </div>
          )}
          {(view.showStreams || view.showSliceY || view.showSliceZ) && (
            <div className="colorbar-card">
              <div className="colorbar-header">
                <span>
                  {isStarry && <Sparkles size={11} style={{ marginRight: 4, verticalAlign: -1, color: '#fef08a' }} />}
                  {t.colorbarVel}
                </span>
                <span className="colorbar-unit">m/s</span>
              </div>
              <div
                className="colorbar-strip"
                style={{ background: isStarry ? VEL_STARRY_GRADIENT : VEL_SCI_GRADIENT }}
              />
              <div className="colorbar-ticks">
                <span>{velRange[0].toFixed(0)}</span>
                <span>{((velRange[0] + velRange[1]) * 0.5).toFixed(0)}</span>
                <span>{velRange[1].toFixed(0)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="viewer-hint">{t.hint}</div>

      {(loading || meshStatus || !result) && (
        <div className="viewer-overlay">
          {loading ? (
            <div className="spinner-card">
              <div className="spinner" />
              <h3>{t.loadingCloud}</h3>
              <p>{t.loadingCloudDesc}</p>
            </div>
          ) : meshStatus ? (
            <div className="spinner-card">
              <div className="spinner" />
              <h3>{meshStatus}</h3>
            </div>
          ) : (
            <div className="spinner-card">
              <h3>{t.emptyTitle}</h3>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
