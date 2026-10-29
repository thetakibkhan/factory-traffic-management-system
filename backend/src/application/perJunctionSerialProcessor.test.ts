import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PerJunctionSerialProcessor } from "./perJunctionSerialProcessor.js";

describe("per-junction serial processor", () => {
  it("serializes work for one junction without blocking another", async () => {
    const processor = new PerJunctionSerialProcessor();
    const events: string[] = [];
    const first = processor.run("A", async () => {
      events.push("a-1-start");
      await delay(5);
      events.push("a-1-end");
    });
    const second = processor.run("A", async () => {
      events.push("a-2-start");
      events.push("a-2-end");
    });
    const otherJunction = processor.run("B", async () => {
      events.push("b-start");
      events.push("b-end");
    });

    await Promise.all([first, second, otherJunction]);

    assert.ok(events.indexOf("a-1-start") < events.indexOf("a-1-end"));
    assert.ok(events.indexOf("a-1-end") < events.indexOf("a-2-start"));
    assert.ok(events.indexOf("a-2-start") < events.indexOf("a-2-end"));
    assert.equal(events.indexOf("b-end") < events.indexOf("a-1-end"), true);
  });

  it("continues queued work after an earlier operation rejects", async () => {
    const processor = new PerJunctionSerialProcessor();
    const failed = processor.run("A", async () => {
      throw new Error("expected failure");
    });
    const following = processor.run("A", async () => "completed");

    await assert.rejects(failed, /expected failure/);
    assert.equal(await following, "completed");
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
