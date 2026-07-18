// RN-safe crypto shim. Only `randomUUID` is referenced by the shared layer
// (editor-compose nonce); the mobile renderer never invokes desktop paths.
function randomUUID() {
  if (typeof global.crypto?.randomUUID === "function") return global.crypto.randomUUID();
  const b = (n) => Math.floor(Math.random() * n);
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) s += hex[b(16)];
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
module.exports = { randomUUID };
