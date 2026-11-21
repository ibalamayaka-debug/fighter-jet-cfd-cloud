# F-16 Fighting Falcon 3D Cloud CFD Lab ($0/month)

100% cloud-computed 3D external aerodynamics simulation of an open-source 1:1 scale **F-16 Fighting Falcon** CAD model (`14.53m × 9.42m × 4.53m`), powered by **4-core OpenFOAM v2512 (`snappyHexMesh` + `simpleFoam` `kOmegaSST`) on Modal Serverless**, cached on **Cloudflare Workers + KV**, and rendered in 3D via **Kitware VTK.js**.

## Features
- Real open-source watertight F-16 STL model (source: `senkrm/aspect-angle-specific-rcs`)
- Cloud OpenFOAM `snappyHexMesh` + 4-core MPI `simpleFoam` (`kOmegaSST`) with pitched inflow Angle of Attack ($\alpha \in [-4^\circ, +16^\circ]$), airspeed ($80\text{–}280\text{ m/s}$), and ISA altitude density ($0\text{–}10\text{ km}$)
- Live aerospace telemetry: Full-aircraft **Lift (kN & tonnes-force)**, **Drag (kN)**, **$C_L / C_D / L/D$**, and **Peak local airspeed $U_{\max}$**
- Interactive 3D VTK.js layers: Airframe surface pressure $C_p$, 3D velocity-colored LEX & wingtip vortex streamline tubes, vertical centerline velocity slice (XZ), and horizontal wing-plane velocity slice (XY)
