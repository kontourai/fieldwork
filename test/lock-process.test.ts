import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runFieldwork } from "../src/fieldwork.js";
import { tempRoot } from "./helpers.js";

interface WorkerMessage { type: string; code?: string; }

test("a separately spawned contender cannot coexist with a publisher paused before atomic lock publication", async () => {
  const run = await runFieldwork({
    taskPath: "examples/generic/task.json", sourcePath: "examples/generic/source.txt",
    root: await tempRoot("lock-publication-process")
  });
  const children: ChildProcess[] = [];
  let publisherEntered = false;
  try {
    const publisher = spawnWorker(run.runDirectory, "publisher");
    children.push(publisher);
    publisher.on("message", (message: WorkerMessage) => {
      if (message.type === "entered") publisherEntered = true;
    });
    await message(publisher, "publication-ready");

    const contender = spawnWorker(run.runDirectory, "contender");
    children.push(contender);
    await message(contender, "entered");

    const refusal = message(publisher, "error");
    publisher.send({ type: "continue" });
    const refused = await refusal;
    assert.equal(refused.code, "REVIEW_BUSY");
    assert.equal(publisherEntered, false);

    const completed = message(contender, "done");
    contender.send({ type: "release" });
    await completed;
    assert.equal((await readdir(run.runDirectory)).some((name) => name.startsWith(".review.lock")), false);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
});

function spawnWorker(runDirectory: string, role: string): ChildProcess {
  return fork(fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url)), [runDirectory, role], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
}

function message(child: ChildProcess, type: string): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for lock worker message: ${type}`));
    }, 10_000);
    const onMessage = (value: WorkerMessage): void => {
      if (value.type !== type) return;
      cleanup();
      resolve(value);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Lock worker exited before ${type}: ${code}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}
