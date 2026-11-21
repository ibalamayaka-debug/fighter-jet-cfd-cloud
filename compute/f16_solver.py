"""
Cloud OpenFOAM v2512 3D External Aerodynamics Solver for F-16 Fighting Falcon.

Uses the real watertight 1:1 scale open-source F-16 CAD STL (14.53m x 9.42m x 4.53m):
  1. Virtual wind tunnel blockMesh (half-aircraft y >= 0 with symmetryPlane at y = 0)
  2. surfaceFeatureExtract + snappyHexMesh -overwrite (body-fitted 3D hex mesh)
  3. potentialFoam + 4-core MPI simpleFoam (k-omega SST RANS) with pitched inflow AoA
  4. Native OpenFOAM `forceCoeffs` -> Lift (kN / tf), Drag (kN), CL, CD, L/D, Cm
  5. VTK postprocessing -> mirrored full-aircraft 3D surface Cp, 3D RK45 streamline
     tubes & LEX/wingtip vortices, centerline vertical slice, and horizontal wing slice.
"""

from __future__ import annotations

import hashlib
import math
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Optional

import numpy as np

OPENFOAM_BASHRC_CANDIDATES = [
    os.environ.get("OPENFOAM_BASHRC", ""),
    "/usr/lib/openfoam/openfoam2512/etc/bashrc",
    "/usr/lib/openfoam/openfoam2412/etc/bashrc",
    "/opt/openfoam2512/etc/bashrc",
]

# Real F-16 Fighting Falcon aerodynamic reference geometry
S_FULL_M2 = 27.87       # 300 ft^2 full wing reference area
S_HALF_M2 = S_FULL_M2 * 0.5
C_REF_M = 3.45          # Mean aerodynamic chord [m]
NU_AIR = 1.5e-5         # Kinematic viscosity [m^2/s]
N_PROCS = min(4, os.cpu_count() or 1)


def isa_air_density(altitude_m: float) -> float:
    """Standard ISA air density rho(h) [kg/m^3] for h in [0, 11000] m."""
    h = min(max(altitude_m, 0.0), 11000.0)
    return 1.225 * ((1.0 - 2.25577e-5 * h) ** 4.25588)


@dataclass(frozen=True)
class F16Params:
    aoa_deg: float = 8.0          # Angle of attack [-4, 16] deg
    speed_ms: float = 180.0       # Flight speed [80, 280] m/s (288..1008 km/h)
    altitude_m: float = 0.0       # Flight altitude [0, 10000] m

    def normalized(self) -> "F16Params":
        aoa = round(min(max(float(self.aoa_deg), -4.0), 16.0) / 2.0) * 2.0
        spd = round(min(max(float(self.speed_ms), 80.0), 280.0) / 10.0) * 10.0
        alt = round(min(max(float(self.altitude_m), 0.0), 10000.0) / 2500.0) * 2500.0
        return F16Params(aoa_deg=aoa, speed_ms=spd, altitude_m=alt)

    def case_key(self) -> str:
        p = self.normalized()
        canonical = f"f16|aoa={p.aoa_deg:.0f}|v={p.speed_ms:.0f}|alt={p.altitude_m:.0f}"
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _find_bashrc() -> Optional[str]:
    for p in OPENFOAM_BASHRC_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    return None


def _run_foam(case_dir: Path, cmd: str, timeout: int = 300) -> str:
    bashrc = _find_bashrc()
    full_cmd = f"source '{bashrc}' >/dev/null 2>&1 || true; {cmd}" if bashrc else cmd
    proc = subprocess.run(
        ["bash", "-lc", full_cmd],
        cwd=str(case_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        tail = "\n".join(proc.stdout.splitlines()[-20:])
        raise RuntimeError(f"OpenFOAM command failed ({cmd}):\n{tail}")
    return proc.stdout


def _setup_case(case_dir: Path, params: F16Params, stl_src: Path) -> None:
    for sub in ("0", "constant/triSurface", "system"):
        (case_dir / sub).mkdir(parents=True, exist_ok=True)

    shutil.copyfile(stl_src, case_dir / "constant" / "triSurface" / "f16.stl")

    rho = isa_air_density(params.altitude_m)
    u_inf = params.speed_ms
    aoa_rad = math.radians(params.aoa_deg)
    ux = u_inf * math.cos(aoa_rad)
    uz = u_inf * math.sin(aoa_rad)

    # Lift is perpendicular to freestream; drag is aligned with freestream
    lift_x, lift_z = -math.sin(aoa_rad), math.cos(aoa_rad)
    drag_x, drag_z = math.cos(aoa_rad), math.sin(aoa_rad)

    # Free-air atmospheric turbulence (TI = 1.0%, length scale 0.35 m)
    k_in = 1.5 * (u_inf * 0.01) ** 2
    omega_in = math.sqrt(k_in) / (0.09 ** 0.25 * 0.35)

    # Virtual wind tunnel around F-16 (bounds x:[-7.27, 7.27], y:[-4.71, 4.71], z:[-0.91, 3.63])
    # Half-aircraft symmetry at y = 0 -> domain x:[-24, 34], y:[0, 20], z:[-18, 22]
    (case_dir / "system" / "blockMeshDict").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}

scale 1;

vertices
(
    (-24.0  0.0 -18.0) // 0
    ( 34.0  0.0 -18.0) // 1
    ( 34.0 20.0 -18.0) // 2
    (-24.0 20.0 -18.0) // 3
    (-24.0  0.0  22.0) // 4
    ( 34.0  0.0  22.0) // 5
    ( 34.0 20.0  22.0) // 6
    (-24.0 20.0  22.0) // 7
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (36 12 24) simpleGrading (1 1 1)
);

edges ();

boundary
(
    inlet
    {
        type patch;
        faces ((0 4 7 3));
    }
    outlet
    {
        type patch;
        faces ((1 2 6 5));
    }
    symmetry
    {
        type symmetryPlane;
        faces ((0 1 5 4));
    }
    farField
    {
        type patch;
        faces
        (
            (3 7 6 2)
            (0 3 2 1)
            (4 5 6 7)
        );
    }
);

mergePatchPairs ();
""")

    (case_dir / "system" / "surfaceFeatureExtractDict").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      surfaceFeatureExtractDict;
}

f16.stl
{
    extractionMethod    extractFromSurface;
    extractFromSurfaceCoeffs
    {
        includedAngle   150;
    }
    writeObj            no;
}
""")

    (case_dir / "system" / "snappyHexMeshDict").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      snappyHexMeshDict;
}

castellatedMesh true;
snap            true;
addLayers       false;

geometry
{
    f16.stl
    {
        type triSurfaceMesh;
        name f16;
    }
    wakeBox
    {
        type searchableBox;
        min (-10.0 0.0 -4.0);
        max ( 18.0 8.5  7.0);
    }
    nearJetBox
    {
        type searchableBox;
        min (-8.2 0.0 -1.8);
        max ( 8.8 5.8  4.5);
    }
}

castellatedMeshControls
{
    maxLocalCells       400000;
    maxGlobalCells      1200000;
    minRefinementCells  5;
    maxLoadUnbalance    0.10;
    nCellsBetweenLevels 2;

    features
    (
        {
            file "f16.eMesh";
            level 4;
        }
    );

    refinementSurfaces
    {
        f16
        {
            level (3 4);
            patchInfo
            {
                type wall;
            }
        }
    }

    resolveFeatureAngle 30;

    refinementRegions
    {
        wakeBox
        {
            mode inside;
            levels ((1E15 1));
        }
        nearJetBox
        {
            mode inside;
            levels ((1E15 2));
        }
    }

    locationInMesh (-20.0 15.0 15.0);
    allowFreeStandingZoneFaces true;
}

snapControls
{
    nSmoothPatch    3;
    tolerance       2.0;
    nSolveIter      30;
    nRelaxIter      5;
    nFeatureSnapIter 10;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}

addLayersControls
{
    relativeSizes true;
    layers {}
    expansionRatio 1.2;
    finalLayerThickness 0.3;
    minThickness 0.1;
    nGrow 0;
    featureAngle 60;
    nRelaxIter 3;
    nSmoothSurfaceNormals 1;
    nSmoothNormals 3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
}

meshQualityControls
{
    maxNonOrtho         65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave          80;
    minVol              1e-13;
    minTetQuality       -1e30;
    minArea             -1;
    minTwist            0.02;
    minDeterminant      0.001;
    minFaceWeight       0.02;
    minVolRatio         0.01;
    minTriangleTwist    -1;
    nSmoothScale        4;
    errorReduction      0.75;
}

mergeTolerance 1e-6;
""")

    (case_dir / "system" / "decomposeParDict").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      decomposeParDict;
}}

numberOfSubdomains {N_PROCS};
method          scotch;
""")

    (case_dir / "system" / "controlDict").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      controlDict;
}}

application     simpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         200;
deltaT          1;
writeControl    timeStep;
writeInterval   200;
purgeWrite      1;
writeFormat     binary;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;

functions
{{
    f16ForceCoeffs
    {{
        type            forceCoeffs;
        libs            (forces);
        writeControl    timeStep;
        writeInterval   5;
        patches         (f16);
        rho             rhoInf;
        rhoInf          {rho:.5f};
        liftDir         ({lift_x:.6f} 0 {lift_z:.6f});
        dragDir         ({drag_x:.6f} 0 {drag_z:.6f});
        CofR            (0.0 0.0 0.0);
        pitchAxis       (0 1 0);
        magUInf         {u_inf:.4f};
        lRef            {C_REF_M};
        Aref            {S_HALF_M2};
    }}
}}
""")

    (case_dir / "system" / "fvSchemes").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSchemes;
}

ddtSchemes
{
    default         steadyState;
}

gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwindV grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear limited corrected 0.5;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         limited corrected 0.5;
}

wallDist
{
    method          meshWave;
}
""")

    (case_dir / "system" / "fvSolution").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      fvSolution;
}

solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-6;
        relTol          0.05;
    }

    Phi
    {
        $p;
    }

    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-6;
        relTol          0.1;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;
    residualControl
    {
        p               1e-4;
        U               1e-4;
        "(k|omega)"     1e-4;
    }
}

potentialFlow
{
    nNonOrthogonalCorrectors 4;
}

relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
        k               0.6;
        omega           0.6;
    }
}
""")

    (case_dir / "constant" / "transportProperties").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      transportProperties;
}}

transportModel  Newtonian;
nu              [0 2 -1 0 0 0 0] {NU_AIR:.6e};
""")

    (case_dir / "constant" / "turbulenceProperties").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      turbulenceProperties;
}

simulationType  RAS;

RAS
{
    RASModel        kOmegaSST;
    turbulence      on;
    printCoeffs     off;
}
""")

    u_vec = f"({ux:.5f} 0 {uz:.5f})"
    (case_dir / "0" / "U").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volVectorField;
    object      U;
}}

dimensions      [0 1 -1 0 0 0 0];
internalField   uniform {u_vec};

boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform {u_vec};
    }}
    outlet
    {{
        type            inletOutlet;
        inletValue      uniform (0 0 0);
        value           uniform {u_vec};
    }}
    farField
    {{
        type            freestreamVelocity;
        freestreamValue uniform {u_vec};
    }}
    symmetry
    {{
        type            symmetryPlane;
    }}
    f16
    {{
        type            noSlip;
    }}
}}
""")

    (case_dir / "0" / "p").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      p;
}

dimensions      [0 2 -2 0 0 0 0];
internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            zeroGradient;
    }
    outlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    farField
    {
        type            freestreamPressure;
        freestreamValue uniform 0;
    }
    symmetry
    {
        type            symmetryPlane;
    }
    f16
    {
        type            zeroGradient;
    }
}
""")

    (case_dir / "0" / "k").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      k;
}}

dimensions      [0 2 -2 0 0 0 0];
internalField   uniform {k_in:.6e};

boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform {k_in:.6e};
    }}
    outlet
    {{
        type            inletOutlet;
        inletValue      uniform {k_in:.6e};
        value           uniform {k_in:.6e};
    }}
    farField
    {{
        type            inletOutlet;
        inletValue      uniform {k_in:.6e};
        value           uniform {k_in:.6e};
    }}
    symmetry
    {{
        type            symmetryPlane;
    }}
    f16
    {{
        type            kqRWallFunction;
        value           uniform {k_in:.6e};
    }}
}}
""")

    (case_dir / "0" / "omega").write_text(f"""FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      omega;
}}

dimensions      [0 0 -1 0 0 0 0];
internalField   uniform {omega_in:.6e};

boundaryField
{{
    inlet
    {{
        type            fixedValue;
        value           uniform {omega_in:.6e};
    }}
    outlet
    {{
        type            inletOutlet;
        inletValue      uniform {omega_in:.6e};
        value           uniform {omega_in:.6e};
    }}
    farField
    {{
        type            inletOutlet;
        inletValue      uniform {omega_in:.6e};
        value           uniform {omega_in:.6e};
    }}
    symmetry
    {{
        type            symmetryPlane;
    }}
    f16
    {{
        type            omegaWallFunction;
        value           uniform {omega_in:.6e};
    }}
}}
""")

    (case_dir / "0" / "nut").write_text("""FoamFile
{
    version     2.0;
    format      ascii;
    class       volScalarField;
    object      nut;
}

dimensions      [0 2 -1 0 0 0 0];
internalField   uniform 0;

boundaryField
{
    inlet
    {
        type            calculated;
        value           uniform 0;
    }
    outlet
    {
        type            calculated;
        value           uniform 0;
    }
    farField
    {
        type            calculated;
        value           uniform 0;
    }
    symmetry
    {
        type            symmetryPlane;
    }
    f16
    {
        type            nutkWallFunction;
        value           uniform 0;
    }
}
""")


def _parse_force_coeffs(case_dir: Path, params: F16Params) -> Dict[str, float | int]:
    dat_files = sorted((case_dir / "postProcessing" / "f16ForceCoeffs").rglob("*.dat"))
    if not dat_files:
        raise RuntimeError("No f16ForceCoeffs .dat output found")

    lines = dat_files[-1].read_text().splitlines()
    headers = []
    rows = []
    for line in lines:
        s = line.strip()
        if s.startswith("# Time"):
            headers = s.lstrip("#").split()
            continue
        if not s or s.startswith("#"):
            continue
        parts = s.split()
        if len(parts) >= 6:
            rows.append([float(x) for x in parts])

    cd_idx = headers.index("Cd") if "Cd" in headers else 1
    cl_idx = headers.index("Cl") if "Cl" in headers else 4
    cm_idx = headers.index("CmPitch") if "CmPitch" in headers else 7

    tail = rows[-6:] if len(rows) >= 6 else rows
    cd = sum(r[cd_idx] for r in tail) / len(tail)
    cl = sum(r[cl_idx] for r in tail) / len(tail)
    cm = sum(r[cm_idx] for r in tail) / len(tail)

    rho = isa_air_density(params.altitude_m)
    q_inf = 0.5 * rho * (params.speed_ms ** 2)
    lift_n = cl * q_inf * S_FULL_M2
    drag_n = cd * q_inf * S_FULL_M2

    return {
        "cl": round(cl, 4),
        "cd": round(cd, 4),
        "cm_pitch": round(cm, 4),
        "l_over_d": round(cl / cd, 2) if abs(cd) > 1e-5 else 0.0,
        "lift_kn": round(lift_n / 1000.0, 2),
        "lift_tonnes": round(lift_n / 9810.0, 2),
        "drag_kn": round(drag_n / 1000.0, 2),
        "dynamic_pressure_kpa": round(q_inf / 1000.0, 2),
        "air_density_kgm3": round(rho, 4),
        "mach_approx": round(params.speed_ms / 340.3, 2),
        "iterations": int(rows[-1][0]) if rows else 0,
    }


def _extract_web_vtps(case_dir: Path, params: F16Params) -> Dict[str, object]:
    """
    Extract 4 compact VTK.js-ready ASCII .vtp files in memory:
      - jet.vtp         : Full-span mirrored 3D F-16 surface colored by Cp & pressure (kPa)
      - streamlines.vtp : 56 full-span 3D RK45 streamlines (LEX + wingtip vortices) colored by |U|
      - slice_y.vtp     : Centerline vertical airflow slice (y ~ 0.15 m) colored by |U| & Cp
      - slice_z.vtp     : Horizontal wing-plane airflow slice (z = 0.05 m) colored by |U| & Cp
    """
    import vtk
    from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy

    vtk_root = case_dir / "VTK"
    internal_vtu = sorted(vtk_root.rglob("internal.vtu"), key=lambda p: p.stat().st_mtime)
    if internal_vtu:
        r_int = vtk.vtkXMLUnstructuredGridReader()
        r_int.SetFileName(str(internal_vtu[-1]))
    else:
        legacy = sorted(vtk_root.glob("*.vtk"), key=lambda p: p.stat().st_mtime)
        r_int = vtk.vtkUnstructuredGridReader()
        r_int.SetFileName(str(legacy[-1]))
        r_int.ReadAllScalarsOn()
        r_int.ReadAllVectorsOn()
    r_int.Update()
    ug = r_int.GetOutput()

    jet_vtp = sorted(vtk_root.rglob("f16.vtp"), key=lambda p: p.stat().st_mtime)
    if jet_vtp:
        r_jet = vtk.vtkXMLPolyDataReader()
        r_jet.SetFileName(str(jet_vtp[-1]))
    else:
        legacy_j = sorted((vtk_root / "f16").glob("*.vtk"), key=lambda p: p.stat().st_mtime)
        r_jet = vtk.vtkPolyDataReader()
        r_jet.SetFileName(str(legacy_j[-1]))
        r_jet.ReadAllScalarsOn()
        r_jet.ReadAllVectorsOn()
    r_jet.Update()
    jet_raw = r_jet.GetOutput()

    c2p_int = vtk.vtkCellDataToPointData()
    c2p_int.SetInputData(ug)
    c2p_int.Update()
    ug_pt = c2p_int.GetOutput()

    c2p_jet = vtk.vtkCellDataToPointData()
    c2p_jet.SetInputData(jet_raw)
    c2p_jet.Update()
    jet_pt = c2p_jet.GetOutput()

    rho = isa_air_density(params.altitude_m)
    q_inf = max(0.5 * rho * (params.speed_ms ** 2), 1.0)

    u_max_global = params.speed_ms
    cp_min, cp_max = -1.5, 1.0

    for ds_idx, ds in enumerate((ug_pt, jet_pt)):
        pd = ds.GetPointData()
        p_arr = pd.GetArray("p")
        if p_arr is not None:
            p_pa = vtk_to_numpy(p_arr) * rho
            cp = (p_pa / q_inf).astype(np.float32)
            cp_vtk = numpy_to_vtk(cp, deep=True)
            cp_vtk.SetName("Cp")
            pd.AddArray(cp_vtk)
            if ds_idx == 1:
                cp_min = float(np.percentile(cp, 1.0))
                cp_max = float(np.percentile(cp, 99.5))
        u_arr = pd.GetArray("U")
        if u_arr is not None:
            u_np = vtk_to_numpy(u_arr)
            umag = np.linalg.norm(u_np, axis=1).astype(np.float32)
            umag_vtk = numpy_to_vtk(umag, deep=True)
            umag_vtk.SetName("U_mag")
            pd.AddArray(umag_vtk)
            pd.SetActiveVectors("U")
            if ds_idx == 0:
                u_max_global = float(np.percentile(umag, 99.9))

    def keep_only(poly: vtk.vtkPolyData, keep: tuple[str, ...]) -> vtk.vtkPolyData:
        out = vtk.vtkPolyData()
        out.DeepCopy(poly)
        out.GetCellData().Initialize()
        out.GetFieldData().Initialize()
        pd = out.GetPointData()
        for n in [pd.GetArrayName(i) for i in range(pd.GetNumberOfArrays())]:
            if n not in keep:
                pd.RemoveArray(n)
        if keep and pd.GetArray(keep[0]) is not None:
            pd.SetActiveScalars(keep[0])
        return out

    def mirror_y(poly: vtk.vtkPolyData, reverse_cells: bool = True) -> vtk.vtkPolyData:
        t = vtk.vtkTransform()
        t.Scale(1.0, -1.0, 1.0)
        tf = vtk.vtkTransformPolyDataFilter()
        tf.SetTransform(t)
        tf.SetInputData(poly)
        tf.Update()
        second = tf.GetOutput()
        if reverse_cells:
            rev = vtk.vtkReverseSense()
            rev.SetInputData(second)
            rev.ReverseCellsOn()
            rev.ReverseNormalsOn()
            rev.Update()
            second = rev.GetOutput()
        app = vtk.vtkAppendPolyData()
        app.AddInputData(poly)
        app.AddInputData(second)
        app.Update()
        return app.GetOutput()

    def poly_to_ascii_str(poly: vtk.vtkPolyData) -> str:
        w = vtk.vtkXMLPolyDataWriter()
        w.SetWriteToOutputString(True)
        w.SetInputData(poly)
        w.SetDataModeToAscii()
        w.Write()
        return w.GetOutputString()

    # 1) Full-span 3D F-16 surface colored by Cp
    tri_jet = vtk.vtkTriangleFilter()
    tri_jet.SetInputData(mirror_y(jet_pt, reverse_cells=True))
    tri_jet.Update()
    jet_clean = keep_only(tri_jet.GetOutput(), ("Cp",))

    # 2) 3D Streamlines via uniform resampling (unbroken smooth streamlines + LEX & wingtip vortices!)
    resampler = vtk.vtkResampleToImage()
    resampler.SetInputDataObject(ug_pt)
    resampler.UseInputBoundsOff()
    resampler.SetSamplingBounds(-11.0, 16.0, 0.08, 7.5, -3.2, 6.2)
    resampler.SetSamplingDimensions(105, 42, 48)
    resampler.Update()
    img = resampler.GetOutput()
    img.GetPointData().SetActiveVectors("U")

    seeds = vtk.vtkPoints()
    # Nose / canopy / dorsal spine rake
    for y in (0.35, 0.95):
        for z in (-0.4, 0.35, 1.15):
            seeds.InsertNextPoint(-9.5, y, z)
    # LEX strake & delta wing lifting surface rake
    for y in np.linspace(1.3, 4.1, 5):
        for z in (-0.35, 0.25):
            seeds.InsertNextPoint(-6.5, float(y), float(z))
    # Wingtip vortex cluster (y ~ 4.4..5.2)
    for y in (4.45, 4.75, 5.05):
        for z in (-0.35, 0.05, 0.45):
            seeds.InsertNextPoint(-2.0, y, z)

    seed_poly = vtk.vtkPolyData()
    seed_poly.SetPoints(seeds)

    tracer = vtk.vtkStreamTracer()
    tracer.SetInputData(img)
    tracer.SetSourceData(seed_poly)
    tracer.SetMaximumPropagation(26.0)
    tracer.SetInitialIntegrationStep(0.18)
    tracer.SetMaximumIntegrationStep(0.35)
    tracer.SetIntegrationDirectionToForward()
    tracer.SetIntegratorTypeToRungeKutta45()
    tracer.SetInputArrayToProcess(0, 0, 0, vtk.vtkDataObject.FIELD_ASSOCIATION_POINTS, "U")
    tracer.Update()

    raw_s = tracer.GetOutput()
    s_pts_in = vtk_to_numpy(raw_s.GetPoints().GetData())
    s_u_in = vtk_to_numpy(raw_s.GetPointData().GetArray("U_mag"))
    out_pts, out_lines, out_u = vtk.vtkPoints(), vtk.vtkCellArray(), []
    lines = raw_s.GetLines()
    lines.InitTraversal()
    ids = vtk.vtkIdList()
    while lines.GetNextCell(ids):
        n = ids.GetNumberOfIds()
        if n < 5:
            continue
        step = max(1, n // 65)
        idxs = list(range(0, n, step))
        if idxs[-1] != n - 1:
            idxs.append(n - 1)
        new_ids = []
        for k in idxs:
            oid = ids.GetId(k)
            c = s_pts_in[oid]
            new_ids.append(out_pts.InsertNextPoint(float(c[0]), float(c[1]), float(c[2])))
            out_u.append(float(s_u_in[oid]))
        out_lines.InsertNextCell(len(new_ids))
        for nid in new_ids:
            out_lines.InsertCellPoint(nid)

    half_s = vtk.vtkPolyData()
    half_s.SetPoints(out_pts)
    half_s.SetLines(out_lines)
    if out_u:
        a = numpy_to_vtk(np.array(out_u, dtype=np.float32), deep=True)
        a.SetName("U_mag")
        half_s.GetPointData().SetScalars(a)
    streams_full = keep_only(mirror_y(half_s, reverse_cells=False), ("U_mag",))

    def cut_and_crop(origin, normal, bounds, mirror: bool = False) -> vtk.vtkPolyData:
        pl = vtk.vtkPlane()
        pl.SetOrigin(*origin)
        pl.SetNormal(*normal)
        cut = vtk.vtkCutter()
        cut.SetCutFunction(pl)
        cut.SetInputData(ug_pt)
        cut.Update()
        tri = vtk.vtkTriangleFilter()
        tri.SetInputConnection(cut.GetOutputPort())
        tri.Update()
        box = vtk.vtkBox()
        box.SetBounds(*bounds)
        ex = vtk.vtkExtractPolyDataGeometry()
        ex.SetImplicitFunction(box)
        ex.SetInputConnection(tri.GetOutputPort())
        ex.ExtractInsideOn()
        ex.Update()
        poly = ex.GetOutput()
        if mirror:
            poly = mirror_y(poly, reverse_cells=True)
        return keep_only(poly, ("U_mag", "Cp"))

    # 3) Centerline vertical airflow slice (y = 0.15 m) & 4) Horizontal wing-plane slice (z = 0.08 m)
    slice_y = cut_and_crop((0.0, 0.15, 0.0), (0.0, 1.0, 0.0), (-11.5, 16.5, -1.0, 1.0, -3.5, 6.5), mirror=False)
    slice_z = cut_and_crop((0.0, 0.0, 0.08), (0.0, 0.0, 1.0), (-11.5, 16.5, -8.5, 8.5, -1.0, 1.0), mirror=True)

    files_content = {
        "jet.vtp": poly_to_ascii_str(jet_clean),
        "streamlines.vtp": poly_to_ascii_str(streams_full),
        "slice_y.vtp": poly_to_ascii_str(slice_y),
        "slice_z.vtp": poly_to_ascii_str(slice_z),
    }
    return {
        "n_cells_half": int(ug.GetNumberOfCells()),
        "n_cells_full_equiv": int(ug.GetNumberOfCells()) * 2,
        "u_max_ms": round(u_max_global, 2),
        "u_max_kmh": round(u_max_global * 3.6, 1),
        "cp_min": round(cp_min, 3),
        "cp_max": round(cp_max, 3),
        "file_sizes_kb": {k: round(len(v.encode("utf-8")) / 1024.0, 1) for k, v in files_content.items()},
        "files_content": files_content,
    }


def run_f16_simulation(raw_params: F16Params, stl_path: Path) -> Dict[str, object]:
    t0 = time.perf_counter()
    params = raw_params.normalized()
    case_key = params.case_key()

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"of_f16_{case_key}_"))
    try:
        _setup_case(tmp_dir, params, stl_path)

        t_mesh0 = time.perf_counter()
        _run_foam(tmp_dir, "blockMesh", timeout=60)
        _run_foam(tmp_dir, "surfaceFeatureExtract", timeout=60)
        _run_foam(tmp_dir, "snappyHexMesh -overwrite", timeout=240)
        t_mesh = time.perf_counter() - t_mesh0

        t_solve0 = time.perf_counter()
        _run_foam(tmp_dir, "potentialFoam -noFunctionObjects", timeout=90)
        if N_PROCS > 1:
            _run_foam(tmp_dir, "decomposePar -force", timeout=60)
            _run_foam(
                tmp_dir,
                f"OMPI_ALLOW_RUN_AS_ROOT=1 OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1 mpirun --allow-run-as-root --oversubscribe -np {N_PROCS} simpleFoam -parallel",
                timeout=360,
            )
            _run_foam(tmp_dir, "reconstructPar -latestTime", timeout=90)
        else:
            _run_foam(tmp_dir, "simpleFoam", timeout=360)
        t_solve = time.perf_counter() - t_solve0

        t_post0 = time.perf_counter()
        _run_foam(tmp_dir, "foamToVTK -latestTime -noFaceZones", timeout=120)
        vtk_res = _extract_web_vtps(tmp_dir, params)
        aero = _parse_force_coeffs(tmp_dir, params)
        t_post = time.perf_counter() - t_post0
        total_sec = time.perf_counter() - t0

        metrics = {
            "case_key": case_key,
            "aircraft": "F-16 Fighting Falcon (1:1 Scale Open-Source CAD)",
            "params": asdict(params),
            "kpis": {
                **aero,
                "u_max_ms": vtk_res["u_max_ms"],
                "u_max_kmh": vtk_res["u_max_kmh"],
                "n_cells_half": vtk_res["n_cells_half"],
                "n_cells_full_equiv": vtk_res["n_cells_full_equiv"],
            },
            "fields": {
                "cp_min": vtk_res["cp_min"],
                "cp_max": vtk_res["cp_max"],
                "u_inf_ms": params.speed_ms,
                "u_max_ms": vtk_res["u_max_ms"],
            },
            "timing_sec": {
                "mesh": round(t_mesh, 2),
                "solve": round(t_solve, 2),
                "postprocess": round(t_post, 2),
                "total": round(total_sec, 2),
            },
            "file_sizes_kb": vtk_res["file_sizes_kb"],
            "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        return {
            "metrics": metrics,
            "files_content": vtk_res["files_content"],
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
