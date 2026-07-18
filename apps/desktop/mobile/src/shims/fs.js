// Desktop-only filesystem surface — the mobile app is a remote renderer and
// never touches the local disk. Export named bindings so the shared source
// imports resolve; calling them throws (a desktop path accidentally reached RN).
function notAvailable(name) {
  return function () { throw new Error(`node:fs '${name}' is unavailable in the mobile renderer`); };
}
module.exports = {
  existsSync: notAvailable("existsSync"),
  realpathSync: notAvailable("realpathSync"),
  readFile: notAvailable("readFile"),
  writeFile: notAvailable("writeFile"),
  mkdir: notAvailable("mkdir"),
  rename: notAvailable("rename"),
  rm: notAvailable("rm"),
  stat: notAvailable("stat"),
  chmod: notAvailable("chmod"),
  promises: {
    readFile: notAvailable("readFile"),
    writeFile: notAvailable("writeFile"),
    mkdir: notAvailable("mkdir"),
    rename: notAvailable("rename"),
    rm: notAvailable("rm"),
    stat: notAvailable("stat"),
    chmod: notAvailable("chmod"),
    realpath: notAvailable("realpath"),
  },
};
