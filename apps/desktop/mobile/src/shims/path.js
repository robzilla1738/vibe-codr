// Minimal POSIX path shim for the shared contract layer under React Native.
// The mobile app is a remote renderer and never touches the local filesystem,
// but the shared source imports `node:path` for desktop-only modules; this keeps
// the shared layer importable unmodified (single source of truth).
const posix = {
  sep: "/",
  delimiter: ":",
  isAbsolute(p) {
    return typeof p === "string" && p.length > 0 && p.charCodeAt(0) === 47; // "/"
  },
  normalize(p) {
    if (!p) return ".";
    const isAbs = posix.isAbsolute(p);
    const trailing = p.slice(-1) === "/";
    const segs = p.split("/").filter(Boolean);
    const out = [];
    for (const s of segs) {
      if (s === ".") continue;
      if (s === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!isAbs) out.push("..");
        continue;
      }
      out.push(s);
    }
    let res = (isAbs ? "/" : "") + out.join("/");
    if (!res && !isAbs) res = ".";
    if (trailing && res !== "/") res += "/";
    return res;
  },
  join() {
    const args = Array.from(arguments).filter((a) => typeof a === "string" && a.length);
    if (!args.length) return ".";
    let res = args.join("/");
    return posix.normalize(res);
  },
  resolve() {
    const segs = [];
    for (let i = arguments.length - 1; i >= 0; i--) {
      const a = arguments[i];
      if (typeof a !== "string" || !a) continue;
      if (posix.isAbsolute(a)) { segs.length = 0; segs.push(a); continue; }
      segs.push(a);
    }
    return posix.normalize(segs.reverse().join("/")) || "/";
  },
  relative(from, to) {
    const f = posix.resolve(from).split("/").filter(Boolean);
    const t = posix.resolve(to).split("/").filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    const up = Array(f.length - i).fill("..");
    return up.concat(t.slice(i)).join("/") || ".";
  },
  dirname(p) {
    if (!p) return ".";
    const segs = p.split("/").filter(Boolean);
    segs.pop();
    return (posix.isAbsolute(p) ? "/" : "") + segs.join("/") || (posix.isAbsolute(p) ? "/" : ".");
  },
  basename(p, ext) {
    const base = (p || "").split("/").filter(Boolean).pop() || "";
    if (ext && base.endsWith(ext)) return base.slice(0, base.length - ext.length);
    return base;
  },
  extname(p) {
    const base = posix.basename(p);
    const i = base.lastIndexOf(".");
    return i > 0 ? base.slice(i) : "";
  },
};
module.exports = posix;
module.exports.posix = posix;
module.exports.win32 = posix;
module.exports.default = posix;
