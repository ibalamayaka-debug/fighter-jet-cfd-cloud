import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  Database,
  Eye,
  Flame,
  Gauge,
  PanelLeftClose,
  PanelLeftOpen,
  Plane,
  Play,
  Timer,
  TrendingUp,
  Wind,
} from 'lucide-react';
import { fetchCachedCases, runF16Simulation } from './api';
import { F16Viewer } from './components/F16Viewer';
import { detectInitialLang, TRANSLATIONS, type Lang } from './i18n';
import type { F16Metrics, F16Params, F16SimResponse, F16ViewState } from './types';

const DEFAULT_PARAMS: F16Params = {
  aoa_deg: 8,
  speed_ms: 180,
  altitude_m: 0,
};

export const App: React.FC = () => {
  const [lang, setLang] = useState<Lang>(detectInitialLang);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [params, setParams] = useState<F16Params>(DEFAULT_PARAMS);
  const [view, setView] = useState<F16ViewState>({
    showJet: true,
    showStreams: true,
    showSliceY: false,
    showSliceZ: false,
    wireframe: false,
    streamRadius: 0.022,
    sliceOpacity: 0.55,
    palette: 'starry',
    playing: true,
    flowSpeed: 1.0,
  });

  const [result, setResult] = useState<F16SimResponse | null>(null);
  const [cachedList, setCachedList] = useState<F16Metrics[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const t = TRANSLATIONS[lang];

  useEffect(() => {
    document.title = t.pageTitle;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try {
      localStorage.setItem('f16cfd_lang', lang);
    } catch {
      // ignore
    }
  }, [lang, t.pageTitle]);

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchCachedCases();
        setCachedList(list);
        if (list.length > 0) {
          const first = list.find((c) => c.params.aoa_deg >= 8) || list[0];
          setParams(first.params);
          setResult({
            status: 'ok',
            cached: true,
            backend: 'cloudflare-kv-cache',
            case_key: first.case_key,
            metrics: first,
            urls: {
              jet: `/api/results/${first.case_key}/jet.vtp`,
              streamlines: `/api/results/${first.case_key}/streamlines.vtp`,
              slice_y: `/api/results/${first.case_key}/slice_y.vtp`,
              slice_z: `/api/results/${first.case_key}/slice_z.vtp`,
              metrics: `/api/results/${first.case_key}/metrics.json`,
            },
          });
        }
      } catch {
        // ignore on initial paint
      }
    })();
  }, []);

  const handleRun = async (override?: F16Params) => {
    const target = override ?? params;
    setLoading(true);
    setError('');
    try {
      const resp = await runF16Simulation(target);
      setResult(resp);
      setParams(resp.metrics.params);
      const list = await fetchCachedCases();
      setCachedList(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const kpis = result?.metrics.kpis;
  const timing = result?.metrics.timing_sec;

  return (
    <div className={`app-layout ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-top">
            <div className="brand-badge">{t.badge}</div>
            <div className="lang-switch" role="group" aria-label="Language">
              <button type="button" className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>
                中文
              </button>
              <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>
                EN
              </button>
            </div>
          </div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>

        {/* Section 1: Flight Conditions */}
        <section className="panel-section">
          <div className="section-title">
            <Plane size={14} /> {t.sectionFlight}
          </div>

          <div className="preset-list">
            {[
              { p: { aoa_deg: 12, speed_ms: 120, altitude_m: 0 }, label: t.presets.climb },
              { p: { aoa_deg: 4, speed_ms: 220, altitude_m: 5000 }, label: t.presets.cruise },
              { p: { aoa_deg: 0, speed_ms: 260, altitude_m: 0 }, label: t.presets.pass },
            ].map((item) => {
              const active =
                params.aoa_deg === item.p.aoa_deg &&
                params.speed_ms === item.p.speed_ms &&
                params.altitude_m === item.p.altitude_m;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={`preset-btn ${active ? 'active' : ''}`}
                  onClick={() => setParams(item.p)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <label className="slider-row">
            <div className="slider-header">
              <span>{t.aoa}</span>
              <strong>{params.aoa_deg > 0 ? `+${params.aoa_deg}°` : `${params.aoa_deg}°`}</strong>
            </div>
            <input
              type="range"
              min={-4}
              max={16}
              step={2}
              value={params.aoa_deg}
              onChange={(e) => setParams({ ...params, aoa_deg: Number(e.target.value) })}
            />
          </label>

          <label className="slider-row">
            <div className="slider-header">
              <span>{t.speed}</span>
              <strong>
                {params.speed_ms} m/s ({Math.round(params.speed_ms * 3.6)} km/h)
              </strong>
            </div>
            <input
              type="range"
              min={80}
              max={280}
              step={10}
              value={params.speed_ms}
              onChange={(e) => setParams({ ...params, speed_ms: Number(e.target.value) })}
            />
          </label>

          <label className="select-row">
            <span>{t.altitude}</span>
            <select
              value={params.altitude_m}
              onChange={(e) => setParams({ ...params, altitude_m: Number(e.target.value) })}
            >
              <option value={0}>{t.altOptions[0]}</option>
              <option value={5000}>{t.altOptions[5000]}</option>
              <option value={10000}>{t.altOptions[10000]}</option>
            </select>
          </label>

          <button type="button" className="run-btn" disabled={loading} onClick={() => handleRun()}>
            <Play size={15} />
            {loading ? t.runningBtn : t.runBtn}
          </button>
        </section>

        {/* Section 2: VTK.js 3D Airflow & Slices */}
        <section className="panel-section">
          <div className="section-title">
            <Eye size={14} /> {t.sectionVisual}
          </div>

          <div className="select-row">
            <span>{t.paletteLabel}</span>
            <div className="palette-switch">
              <button
                type="button"
                className={view.palette === 'starry' ? 'active' : ''}
                onClick={() => setView({ ...view, palette: 'starry' })}
              >
                ✨ {t.paletteStarry}
              </button>
              <button
                type="button"
                className={view.palette === 'scientific' ? 'active' : ''}
                onClick={() => setView({ ...view, palette: 'scientific' })}
              >
                {t.paletteScientific}
              </button>
            </div>
          </div>

          <div className="toggle-list">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={view.showJet}
                onChange={(e) => setView({ ...view, showJet: e.target.checked })}
              />
              <span>{t.showJet}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={view.showStreams}
                onChange={(e) => setView({ ...view, showStreams: e.target.checked })}
              />
              <span>{t.showStreams}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={view.showSliceY}
                onChange={(e) => setView({ ...view, showSliceY: e.target.checked })}
              />
              <span>{t.showSliceY}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={view.showSliceZ}
                onChange={(e) => setView({ ...view, showSliceZ: e.target.checked })}
              />
              <span>{t.showSliceZ}</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={view.wireframe}
                onChange={(e) => setView({ ...view, wireframe: e.target.checked })}
              />
              <span>{t.wireframe}</span>
            </label>
          </div>

          <label className="slider-row">
            <div className="slider-header">
              <span>{t.flowSpeed}</span>
              <strong>{view.flowSpeed.toFixed(1)}×</strong>
            </div>
            <input
              type="range"
              min={0.3}
              max={2.5}
              step={0.1}
              value={view.flowSpeed}
              onChange={(e) => setView({ ...view, flowSpeed: Number(e.target.value) })}
            />
          </label>

          <label className="slider-row">
            <div className="slider-header">
              <span>{t.streamRadius}</span>
              <strong>{(view.streamRadius * 100).toFixed(1)} cm</strong>
            </div>
            <input
              type="range"
              min={0.008}
              max={0.08}
              step={0.002}
              value={view.streamRadius}
              onChange={(e) => setView({ ...view, streamRadius: Number(e.target.value) })}
            />
          </label>

          {(view.showSliceY || view.showSliceZ) && (
            <label className="slider-row">
              <div className="slider-header">
                <span>{t.sliceOpacity}</span>
                <strong>{Math.round(view.sliceOpacity * 100)}%</strong>
              </div>
              <input
                type="range"
                min={0.15}
                max={0.95}
                step={0.05}
                value={view.sliceOpacity}
                onChange={(e) => setView({ ...view, sliceOpacity: Number(e.target.value) })}
              />
            </label>
          )}
        </section>

        <div className="sidebar-footer">
          <Flame size={13} />
          <span>{t.footerNote}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="kpi-bar">
          <button
            type="button"
            className="collapse-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? t.hideSidebar : t.showSidebar}
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>

          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">
                <ArrowUp size={14} /> {t.kpiLift}
              </div>
              <div className="kpi-value gold">
                {kpis ? `${kpis.lift_kn.toFixed(1)} kN (${kpis.lift_tonnes.toFixed(1)} ${t.tonnesUnit})` : '--'}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">
                <Wind size={14} /> {t.kpiDrag}
              </div>
              <div className="kpi-value coral">
                {kpis ? `${kpis.drag_kn.toFixed(1)} kN` : '--'}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">
                <TrendingUp size={14} /> {t.kpiAero}
              </div>
              <div className="kpi-value">
                {kpis ? `${kpis.l_over_d.toFixed(2)} (${kpis.cl.toFixed(2)} / ${kpis.cd.toFixed(2)})` : '--'}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">
                <Gauge size={14} /> {t.kpiPeakU}
              </div>
              <div className="kpi-value">
                {kpis ? `${kpis.u_max_ms.toFixed(0)} m/s (${kpis.u_max_kmh.toFixed(0)} km/h)` : '--'}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">
                {result?.cached ? <Database size={14} /> : <Timer size={14} />}
                {t.kpiSource}
              </div>
              <div className={`kpi-value ${result?.cached ? 'sage' : 'gold'}`}>
                {timing
                  ? result?.cached
                    ? t.hitSaved(timing.total.toFixed(1))
                    : `${timing.total.toFixed(1)} s`
                  : '--'}
              </div>
            </div>
          </div>
        </header>

        {error && (
          <div className="error-banner">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        )}

        <div className="viewer-wrapper">
          <F16Viewer
            lang={lang}
            result={result}
            view={view}
            onTogglePlay={() => setView((prev) => ({ ...prev, playing: !prev.playing }))}
            loading={loading}
          />
        </div>

        {cachedList.length > 0 && (
          <footer className="presets-strip">
            <span className="strip-label">
              <Database size={13} /> {t.cachedStrip}
            </span>
            <div className="strip-items">
              {cachedList.map((c) => {
                const active = c.case_key === result?.case_key;
                return (
                  <button
                    key={c.case_key}
                    type="button"
                    className={`case-chip ${active ? 'active' : ''}`}
                    onClick={() => handleRun(c.params)}
                  >
                    α={c.params.aoa_deg}° · {c.params.speed_ms}m/s · {c.params.altitude_m / 1000}km · L={c.kpis.lift_tonnes.toFixed(1)}t
                  </button>
                );
              })}
            </div>
          </footer>
        )}
      </main>
    </div>
  );
};
