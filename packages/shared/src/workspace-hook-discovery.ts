// The discovery barrel once exposed monotonicity and mutation APIs together,
// creating a second export path: consumers could bypass the dedicated subpath, and a bad re-export once caused Desktop builds
// to fail to start. A single source requires "exactly one export path per API": this file exports only the discovery-required
// config/digest; mutation and monotonicity must be imported directly from their respective package subpaths.
export * from "./workspace-hook-config.js";
export * from "./workspace-hook-digest.js";
