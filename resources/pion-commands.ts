// pion-commands: Pion's always-on bundled PI extension. Injected into every
// `pi --mode rpc` runtime Pion spawns (`-e <this file>`, see daemon/agent.ts).
//
// Why it exists: pi's built-in `/reload` is handled by the TUI layer, so RPC
// sessions never see it — typed as a prompt it would go straight to the LLM.
// Registering it as an extension command makes pi's RPC prompt path execute
// it (extension commands run immediately, per docs/rpc.md §prompt).
//
// Trust: same contract as kanban-bridge.ts — this file ships with Pion (app
// resource), loads no project-local code, and holds no state.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      // The TUI also blocks reload during compaction; ExtensionContext exposes
      // no compaction state, so busy-streaming is the only guard available here.
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy — wait for the current response to finish before reloading.", "warning");
        return;
      }
      // Terminal for this handler (docs/extensions.md §ctx.reload): the fresh
      // extension instance confirms via session_start below.
      await ctx.reload();
      return;
    },
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "reload") {
      ctx.ui.notify("Reloaded extensions, skills, prompts, themes, and context files.", "info");
    }
  });
}
