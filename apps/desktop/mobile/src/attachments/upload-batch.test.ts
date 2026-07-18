import { describe, expect, it } from "vitest";
import { uploadBatch } from "./upload-batch";

describe("mobile attachment batch uploads", () => {
  it("keeps successful uploads when another file fails", async () => {
    const result = await uploadBatch(
      ["first", "broken", "last"],
      async (name) => {
        if (name === "broken") throw new Error("broken could not be read");
        return `${name}-uploaded`;
      },
      (name) => `${name} failed`,
    );

    expect(result).toEqual({
      uploaded: ["first-uploaded", "last-uploaded"],
      errors: ["broken could not be read"],
    });
  });

  it("uses a stable fallback for non-Error failures", async () => {
    const result = await uploadBatch(["photo.png"], async () => { throw "offline"; }, (name) => `${name} failed`);
    expect(result).toEqual({ uploaded: [], errors: ["photo.png failed"] });
  });
});
