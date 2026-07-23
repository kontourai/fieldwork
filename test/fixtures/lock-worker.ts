import { withRunReviewLock } from "../../src/run-store.js";

const [runDirectory, role] = process.argv.slice(2);
let paused = false;

function send(type: string, code?: string): void {
  process.send?.({ type, code });
}
function waitFor(type: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown): void => {
      if ((message as { type?: string })?.type !== type) return;
      process.off("message", listener);
      resolve();
    };
    process.on("message", listener);
  });
}

try {
  await withRunReviewLock(
    runDirectory,
    async () => {
      send("entered");
      await waitFor("release");
    },
    role === "publisher" ? {
      beforePublish: async () => {
        if (paused) return;
        paused = true;
        send("publication-ready");
        await waitFor("continue");
      }
    } : {}
  );
  send("done");
} catch (error) {
  send("error", (error as { code?: string }).code);
}
