# Fixture project

Used only by the Electron parity harness. The fixture is intentionally small
and deterministic: it supplies a real cwd for lifecycle, transcript, approval,
workspace-dock, end-panel, and packaged-host checks without becoming a product
source tree. Do not add runtime behavior here; update the harness or renderer
contract instead.
