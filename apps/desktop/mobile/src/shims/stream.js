// Desktop-only stream types — only referenced as a type import in the shared
// layer; no runtime behavior needed in the mobile renderer.
class Readable {}
class Writable {}
class Transform {}
module.exports = { Readable, Writable, Transform };
