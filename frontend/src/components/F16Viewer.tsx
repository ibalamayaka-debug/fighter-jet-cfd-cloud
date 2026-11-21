import React, { useCallback, useEffect, useRef, useState } from 'react';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkTubeFilter from '@kitware/vtk.js/Filters/General/TubeFilter';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkColorMaps from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction/ColorMaps';
import { ColorMode, ScalarMode } from '@kitware/vtk.js/Rendering/Core/Mapper/Constants';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor';
import { Box, Compass, Layers, Wind } from 'lucide-react';
import { fetchVtpBuffer } from '../api';
import { TRANSLATIONS, type Lang } from '../i18n';
import type { F16SimResponse, F16ViewState } from '../types';

interface F16ViewerProps {
  lang: Lang;
  result: F16SimResponse | null;
  view: F16ViewState;
  loading: boolean;
}

interface SceneHandle {
  genericRW: ReturnType<typeof vtkGenericRenderWindow.newInstance>;
  jetActor: ReturnType<typeof vtkActor.newInstance>;
  jetMapper: ReturnType<typeof vtkMapper.newInstance>;
  streamActor: ReturnType<typeof vtkActor.newInstance>;
  streamMapper: ReturnType<typeof vtkMapper.newInstance>;
  tubeFilter: ReturnType<typeof vtkTubeFilter.newInstance>;
  sliceYActor: ReturnType<typeof vtkActor.newInstance>;
  sliceYMapper: ReturnType<typeof vtkMapper.newInstance>;
  sliceZActor: ReturnType<typeof vtkActor.newInstance>;
  sliceZMapper: ReturnType<typeof vtkMapper.newInstance>;
  flowLut: ReturnType<typeof vtkColorTransferFunction.newInstance>;
  orientWidget: ReturnType<typeof vtkOrientationMarkerWidget.newInstance> | null;
  dataLoaded: boolean;
}

const CP_GRADIENT =
  'linear-gradient(90deg, #3b4cc0 0%, #7b9ff9 25%, #e2e2e2 50%, #f4987a 75%, #b40426 100%)';
const VEL_GRADIENT =
  'linear-gradient(90deg, #1b4f9c 0%, #26a9e0 25%, #5fd38d 50%, #f5c342 75%, #c92a2a 100%)';

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

export const F16Viewer: React.FC<F16ViewerProps> = ({ lang, result, view, loading }) => {
  const t = TRANSLATIONS[lang];
  const langRef = useRef<Lang>(lang);
  langRef.current = lang;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const viewRef = useRef<F16ViewState>(view);
  viewRef.current = view;
  const hasInitCam = useRef(false);

  const [meshStatus, setMeshStatus] = useState<string>('');
  const [velRange, setVelRange] = useState<[number, number]>([40, 240]);

  const applyView = useCallback((s: SceneHandle, res: F16SimResponse, v: F16ViewState) => {
    if (!s.dataLoaded) return;
    const uInf = res.metrics.params.speed_ms;
    const uMin = Math.max(10, Math.round(uInf * 0.25));
    const uMax = Math.max(uInf * 1.25, res.metrics.fields.u_max_ms);
    setVelRange([uMin, uMax]);

    s.flowLut.setMappingRange(uMin, uMax);
    s.flowLut.updateRange();

    s.jetActor.setVisibility(v.showJet);
    s.jetActor.getProperty().setRepresentation(v.wireframe ? 1 : 2);

    s.tubeFilter.setRadius(v.streamRadius);
    s.streamMapper.setScalarRange(uMin, uMax);
    s.streamActor.setVisibility(v.showStreams);

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    const genericRW = vtkGenericRenderWindow.newInstance({
      background: [0.105, 0.082, 0.066],
    });
    genericRW.setContainer(el);
    genericRW.resize();

    const renderer = genericRW.getRenderer();
    const interactor = genericRW.getInteractor();

    const cpLut = vtkColorTransferFunction.newInstance();
    cpLut.applyColorMap(vtkColorMaps.getPresetByName('Cool to Warm'));
    cpLut.setMappingRange(-1.2, 1.0);
    cpLut.updateRange();

    const flowLut = vtkColorTransferFunction.newInstance();
    flowLut.applyColorMap(
      vtkColorMaps.getPresetByName('Rainbow Desaturated') ||
        vtkColorMaps.getPresetByName('Cool to Warm')
    );
    flowLut.setMappingRange(40, 240);
    flowLut.updateRange();

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
    jetActor.getProperty().setAmbient(0.32);
    jetActor.getProperty().setDiffuse(0.68);
    jetActor.getProperty().setSpecular(0.35);
    jetActor.getProperty().setSpecularPower(28);
    renderer.addActor(jetActor);

    // Actor 2: 3D Velocity-Colored Streamline Tubes (LEX & Wingtip Vortices)
    const tubeFilter = vtkTubeFilter.newInstance({
      radius: 0.065,
      numberOfSides: 6,
      capping: false,
    });
    const streamMapper = vtkMapper.newInstance();
    streamMapper.setInputConnection(tubeFilter.getOutputPort());
    streamMapper.setLookupTable(flowLut);
    streamMapper.setColorMode(ColorMode.MAP_SCALARS);
    streamMapper.setScalarMode(ScalarMode.USE_POINT_FIELD_DATA);
    streamMapper.setColorByArrayName('U_mag');
    streamMapper.setScalarVisibility(true);
    const streamActor = vtkActor.newInstance();
    streamActor.setMapper(streamMapper);
    streamActor.setVisibility(false);
    streamActor.getProperty().setAmbient(0.35);
    streamActor.getProperty().setDiffuse(0.65);
    streamActor.getProperty().setOpacity(0.92);
    renderer.addActor(streamActor);

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
        faceColor: '#2a2019',
        edgeThickness: 0.12,
        edgeColor: '#f59e0b',
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
      tubeFilter,
      sliceYActor,
      sliceYMapper,
      sliceZActor,
      sliceZMapper,
      flowLut,
      orientWidget,
      dataLoaded: false,
    };

    const ro = new ResizeObserver(() => {
      if (!disposed) genericRW.resize();
    });
    ro.observe(el);

    return () => {
      disposed = true;
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
        s.tubeFilter.setInputData(parseVtp(streamBuf));
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

  return (
    <div className="viewer-shell">
      <div ref={containerRef} className="vtk-canvas" />

      <div className="viewer-toolbar">
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
              <div className="colorbar-strip" style={{ background: CP_GRADIENT }} />
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
                <span>{t.colorbarVel}</span>
                <span className="colorbar-unit">m/s</span>
              </div>
              <div className="colorbar-strip" style={{ background: VEL_GRADIENT }} />
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
