// Desktop-only child_process — the mobile renderer never spawns local processes.
function notAvailable(name) {
  return function () { throw new Error(`node:child_process '${name}' is unavailable in the mobile renderer`); };
}
module.exports = { spawn: notAvailable("spawn"), exec: notAvailable("exec"), execFile: notAvailable("execFile") };
