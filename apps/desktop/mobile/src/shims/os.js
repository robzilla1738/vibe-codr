// Desktop-only os surface. The mobile renderer never relies on the local OS.
function notAvailable(name) {
  return function () { throw new Error(`node:os '${name}' is unavailable in the mobile renderer`); };
}
module.exports = {
  homedir: notAvailable("homedir"),
  tmpdir: notAvailable("tmpdir"),
  platform: () => "ios",
};
