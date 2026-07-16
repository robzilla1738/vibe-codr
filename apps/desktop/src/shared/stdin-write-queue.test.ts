import { describe, expect, it } from "vitest";
import { StdinWriteQueue } from "./stdin-write-queue";

describe("StdinWriteQueue", () => {
  it("writes immediately when no backpressure", () => {
    const q = new StdinWriteQueue();
    const written: string[] = [];
    q.enqueue("a\n", (c) => {
      written.push(c);
      return true;
    }, () => {
      throw new Error("should not need drain");
    });
    q.enqueue("b\n", (c) => {
      written.push(c);
      return true;
    }, () => {
      throw new Error("should not need drain");
    });
    expect(written).toEqual(["a\n", "b\n"]);
    expect(q.pending).toBe(0);
    expect(q.pendingBytes).toBe(0);
    expect(q.isWaitingForDrain).toBe(false);
  });

  it("holds later chunks until drain resumes", () => {
    const q = new StdinWriteQueue();
    const written: string[] = [];
    let resume: (() => void) | null = null;
    let writeCount = 0;

    const write = (c: string) => {
      written.push(c);
      writeCount += 1;
      // First write signals backpressure
      return writeCount !== 1;
    };

    q.enqueue("first\n", write, (r) => {
      resume = r;
    });
    expect(written).toEqual(["first\n"]);
    expect(q.isWaitingForDrain).toBe(true);

    q.enqueue("second\n", write, (r) => {
      resume = r;
    });
    q.enqueue("third\n", write, (r) => {
      resume = r;
    });
    // Still waiting — only first chunk flushed
    expect(written).toEqual(["first\n"]);
    expect(q.pending).toBe(2);
    expect(q.pendingBytes).toBe(Buffer.byteLength("second\nthird\n"));

    resume!();
    expect(written).toEqual(["first\n", "second\n", "third\n"]);
    expect(q.pending).toBe(0);
    expect(q.pendingBytes).toBe(0);
    expect(q.isWaitingForDrain).toBe(false);
  });

  it("rejects an unbounded backlog while the host is not draining", () => {
    const q = new StdinWriteQueue(6);
    let resume: (() => void) | undefined;

    q.enqueue("first", () => false, (value) => {
      resume = value;
    });
    q.enqueue("1234", () => true, () => undefined);
    expect(q.pendingBytes).toBe(4);
    expect(() => q.enqueue("567", () => true, () => undefined)).toThrow(
      "stdin backlog exceeded 6 bytes",
    );
    expect(q.pending).toBe(1);
    expect(q.pendingBytes).toBe(4);

    q.clear();
    expect(q.pendingBytes).toBe(0);
    resume?.();
  });

  it("clear drops pending work and ignores stale drain", () => {
    const q = new StdinWriteQueue();
    let resume: (() => void) | undefined;
    const written: string[] = [];
    q.enqueue("x\n", (c) => {
      written.push(c);
      return false;
    }, (r) => {
      resume = r;
    });
    q.enqueue("y\n", (c) => {
      written.push(c);
      return true;
    }, () => undefined);
    expect(q.pending).toBe(1);
    const epochBefore = q.generation;
    q.clear();
    expect(q.pending).toBe(0);
    expect(q.isWaitingForDrain).toBe(false);
    expect(q.generation).toBe(epochBefore + 1);
    // Stale drain must not re-enter flush or throw
    if (resume) resume();
    expect(written).toEqual(["x\n"]);
    expect(q.pending).toBe(0);
  });

  it("host-recycle race: stale drain from host A must not write host B payloads via writeA", () => {
    const q = new StdinWriteQueue();
    const writtenA: string[] = [];
    const writtenB: string[] = [];
    let resumeA: (() => void) | undefined;

    // Host A hits backpressure after accepting msg1-A into the kernel buffer.
    q.enqueue(
      "msg1-A\n",
      (c) => {
        writtenA.push(c);
        return false;
      },
      (r) => {
        resumeA = r;
      },
    );
    q.enqueue(
      "msg2-A\n",
      (c) => {
        writtenA.push(c);
        return true;
      },
      () => undefined,
    );
    expect(writtenA).toEqual(["msg1-A\n"]);
    expect(q.pending).toBe(1);
    expect(q.isWaitingForDrain).toBe(true);

    // stopCurrent / startCurrent: retire host A
    q.clear();
    expect(q.pending).toBe(0);

    // Host B enqueues; must use writeB only
    q.enqueue(
      "msg2-B\n",
      (c) => {
        writtenB.push(c);
        return true;
      },
      () => {
        throw new Error("host B should not hit backpressure in this test");
      },
    );
    expect(writtenB).toEqual(["msg2-B\n"]);

    // Late drain from host A fires — must not push msg2-B (or anything) through writeA
    resumeA!();
    expect(writtenA).toEqual(["msg1-A\n"]);
    expect(writtenA).not.toContain("msg2-B\n");
    expect(writtenA).not.toContain("msg2-A\n");
    expect(writtenB).toEqual(["msg2-B\n"]);
    expect(q.pending).toBe(0);
  });

  it("host-recycle: B's pending queue is not flushed by A's write after stale drain", () => {
    const q = new StdinWriteQueue();
    const writtenA: string[] = [];
    const writtenB: string[] = [];
    let resumeA: (() => void) | undefined;
    let resumeB: (() => void) | undefined;

    q.enqueue(
      "A1\n",
      (c) => {
        writtenA.push(c);
        return false;
      },
      (r) => {
        resumeA = r;
      },
    );
    q.clear();

    // B also hits backpressure with a second queued chunk
    let bWrites = 0;
    q.enqueue(
      "B1\n",
      (c) => {
        writtenB.push(c);
        bWrites += 1;
        return bWrites !== 1;
      },
      (r) => {
        resumeB = r;
      },
    );
    q.enqueue(
      "B2\n",
      (c) => {
        writtenB.push(c);
        return true;
      },
      () => undefined,
    );
    expect(writtenB).toEqual(["B1\n"]);
    expect(q.pending).toBe(1);

    // Stale A drain must not steal B's queue with writeA
    resumeA!();
    expect(writtenA).toEqual(["A1\n"]);
    expect(writtenB).toEqual(["B1\n"]);
    expect(q.pending).toBe(1);

    // B's real drain completes B2
    resumeB!();
    expect(writtenB).toEqual(["B1\n", "B2\n"]);
    expect(q.pending).toBe(0);
  });
});
