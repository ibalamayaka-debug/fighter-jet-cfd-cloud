"""
Modal Cloud Serverless OpenFOAM v2512 3D F-16 Fighting Falcon Aerodynamics Solver.

Runs 4-core MPI OpenFOAM (snappyHexMesh + simpleFoam k-omega SST) in the cloud
within Modal's $30/month free tier, scaling to zero after 30s idle.
"""

import os
from pathlib import Path
import modal

app = modal.App("f16-fighter-openfoam")

# Reuses cached opencfd/openfoam-run:2512 + VTK image on Modal!
openfoam_image = (
    modal.Image.from_registry("opencfd/openfoam-run:2512", add_python="3.11")
    .apt_install("libgl1", "libxrender1", "libglib2.0-0", "libosmesa6")
    .pip_install("fastapi[standard]", "numpy", "vtk")
    .add_local_file("compute/f16_solver.py", "/root/f16_solver.py")
    .add_local_file("compute/assets/f16_normalized.stl", "/root/f16_normalized.stl")
)


@app.function(
    image=openfoam_image,
    cpu=4.0,
    memory=4096,
    timeout=360,
    scaledown_window=30,
    secrets=[modal.Secret.from_name("f16-cfd-secrets")],
)
@modal.asgi_app()
def fastapi_app():
    import sys
    import traceback

    sys.path.insert(0, "/root")
    from fastapi import FastAPI, Header, HTTPException
    from f16_solver import F16Params, run_f16_simulation

    web = FastAPI(title="F-16 Fighting Falcon OpenFOAM Cloud")

    @web.get("/health")
    def health():
        return {"status": "ok", "aircraft": "F-16", "engine": "openfoam2512"}

    @web.post("/simulate")
    @web.post("/")
    def simulate(payload: dict, authorization: str | None = Header(default=None)):
        expected = os.environ.get("COMPUTE_AUTH_TOKEN", "")
        if expected:
            provided = (authorization or "").replace("Bearer ", "").strip()
            if provided != expected:
                raise HTTPException(status_code=401, detail="Unauthorized compute request")

        params = F16Params(
            aoa_deg=float(payload.get("aoa_deg", 8.0)),
            speed_ms=float(payload.get("speed_ms", 180.0)),
            altitude_m=float(payload.get("altitude_m", 0.0)),
        ).normalized()

        try:
            out = run_f16_simulation(params, Path("/root/f16_normalized.stl"))
            return {"status": "ok", "cached": False, **out}
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"{exc}\n{traceback.format_exc()[-800:]}")

    return web
