import { describe, expect, it } from "vitest";
import { readTextFileCapped, type CappedReadFs } from "./capped-read";

function memFs(content: Buffer): CappedReadFs {
  return {
    async open() {
      return {
        async read(buffer, offset, length, position) {
          const pos = position ?? 0;
          const slice = content.subarray(pos, pos + length);
          slice.copy(buffer, offset);
          return { bytesRead: slice.length };
        },
        async close() {},
      };
    },
  };
}

describe("readTextFileCapped", () => {
  it("returns full text when under the cap", async () => {
    const res = await readTextFileCapped("/x", 100, memFs(Buffer.from("hello world")));
    expect(res).toEqual({ ok: true, text: "hello world", truncated: false });
  });

  it("truncates without reading past maxBytes+1", async () => {
    const big = Buffer.alloc(10_000, 0x61); // 'a'
    let readLen = 0;
    const fs: CappedReadFs = {
      async open() {
        return {
          async read(buffer, offset, length, position) {
            readLen = length;
            const pos = position ?? 0;
            const slice = big.subarray(pos, pos + length);
            slice.copy(buffer, offset);
            return { bytesRead: slice.length };
          },
          async close() {},
        };
      },
    };
    const res = await readTextFileCapped("/big", 64, fs);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.truncated).toBe(true);
      expect(res.text.length).toBe(64);
    }
    // Must only request maxBytes+1 — never the full file size.
    expect(readLen).toBe(65);
  });

  it("rejects binary (NUL) content", async () => {
    const res = await readTextFileCapped("/bin", 100, memFs(Buffer.from([0x68, 0x00, 0x69])));
    expect(res).toEqual({ ok: false, error: "Binary file — reveal in Finder instead" });
  });
});
