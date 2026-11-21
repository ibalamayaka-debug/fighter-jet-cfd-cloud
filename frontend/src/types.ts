export interface F16Params {
  aoa_deg: number;
  speed_ms: number;
  altitude_m: number;
}

export interface F16Metrics {
  case_key: string;
  aircraft: string;
  params: F16Params;
  kpis: {
    cl: number;
    cd: number;
    cm_pitch: number;
    l_over_d: number;
    lift_kn: number;
    lift_tonnes: number;
    drag_kn: number;
    dynamic_pressure_kpa: number;
    air_density_kgm3: number;
    mach_approx: number;
    iterations: number;
    u_max_ms: number;
    u_max_kmh: number;
    n_cells_half: number;
    n_cells_full_equiv: number;
  };
  fields: {
    cp_min: number;
    cp_max: number;
    u_inf_ms: number;
    u_max_ms: number;
  };
  timing_sec: {
    mesh: number;
    solve: number;
    postprocess: number;
    total: number;
  };
  file_sizes_kb: Record<string, number>;
  computed_at: string;
}

export interface F16SimResponse {
  status: string;
  cached: boolean;
  backend: string;
  case_key: string;
  remaining_quota?: number;
  metrics: F16Metrics;
  urls: {
    jet: string;
    streamlines: string;
    slice_y: string;
    slice_z: string;
    metrics: string;
  };
}

export interface F16ViewState {
  showJet: boolean;
  showStreams: boolean;
  showSliceY: boolean;
  showSliceZ: boolean;
  wireframe: boolean;
  streamRadius: number;
  sliceOpacity: number;
}
