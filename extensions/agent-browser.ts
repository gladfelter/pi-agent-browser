import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

const TOOL_DESCRIPTION = `Browser automation via agent-browser CLI.
Workflow: open URL → snapshot -i (get @refs like @e1) → interact → re-snapshot after page changes.
Batch with 'commands' array or semicolons in 'command' to reduce round-trips.
Commands: open <url>, snapshot -i, click <@ref>, fill <@ref> <text>, type <@ref> <text>, select <@ref> <value>, press <key>, scroll <dir> [px], get text|url|title [@ref], wait <@ref|ms>, screenshot [--full], close.`;

function writeTempFile(content: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-browser-${prefix}-`));
  const file = join(dir, "output.txt");
  writeFileSync(file, content);
  return file;
}

/**
 * Parse a command string that may contain semicolon-separated sub-commands.
 * "open url; snapshot -i; click @e3" → ["open url", "snapshot -i", "click @e3"]
 */
function parseCommands(input: string): string[] {
  const parts = input
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (parts.length <= 1) return [input.trim()];
  return parts;
}

/**
 * Result from running a single agent-browser command.
 */
interface CommandResult {
  ok: boolean;
  output: string;
  action: string;
  details: Record<string, any>;
}

/**
 * Run a single agent-browser command. Handles error output, screenshot
 * path extraction, and progress updates for batch mode.
 */
async function runCommand(
  pi: ExtensionAPI,
  commandStr: string,
  signal: AbortSignal | undefined,
  index: number,
  total: number,
  onUpdate: ((update: string) => void) | undefined,
): Promise<CommandResult> {
  const parts = commandStr.split(/\s+/);
  const action = parts[0].toLowerCase();

  // Send progress update for batches
  if (total > 1 && onUpdate) {
    onUpdate(`[${index + 1}/${total}] Running: ${commandStr}`);
  }

  const result = await pi.exec("agent-browser", parts, {
    signal,
    timeout: 60000,
  });

  if (result.code !== 0) {
    const errorOutput = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      output: errorOutput || `Command failed with exit code ${result.code}`,
      action,
      details: { error: errorOutput, exitCode: result.code, command: commandStr },
    };
  }

  const output = result.stdout.trim();

  // Screenshot: extract path from output
  if (action === "screenshot") {
    const pathMatch = output.match(/saved to (.+)$/i);
    if (pathMatch) {
      return {
        ok: true,
        output,
        action,
        details: { command: commandStr, action, screenshotPath: pathMatch[1].trim() },
      };
    }
  }

  return {
    ok: true,
    output,
    action,
    details: { command: commandStr, action },
  };
}

/**
 * Read a screenshot file and return a base64 image content block.
 */
function readScreenshotBlock(
  screenshotPath: string,
): { type: "image"; data: string; mimeType: string } | null {
  try {
    const imageData = readFileSync(screenshotPath);
    const base64 = imageData.toString("base64");
    const ext = extname(screenshotPath).toLowerCase();
    const mimeType =
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp"
      : "image/png";
    return { type: "image", data: base64, mimeType };
  } catch {
    return null;
  }
}

/**
 * Apply truncation to output and return formatted text.
 * If truncated, saves full output to a temp file and includes a notice.
 */
function formatTruncatedOutput(output: string, action: string): string {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let text = truncation.content;
  if (truncation.truncated) {
    const tempFile = writeTempFile(output, action);
    text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    text += ` Full output saved to: ${tempFile}]`;
  }
  return text;
}

async function ensureInstalled(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  const check = await pi.exec("which", ["agent-browser"], { timeout: 5000 });
  if (check.code === 0 && check.stdout.trim()) {
    return true;
  }

  // Not found — prompt user
  if (!ctx.hasUI) {
    return false;
  }

  const ok = await ctx.ui.confirm(
    "agent-browser not found",
    "Install agent-browser globally with npm? (npm install -g agent-browser)"
  );
  if (!ok) {
    return false;
  }

  ctx.ui.notify("Installing agent-browser...", "info");
  const install = await pi.exec("npm", ["install", "-g", "agent-browser"], { timeout: 120000 });
  if (install.code !== 0) {
    ctx.ui.notify(`Installation failed: ${install.stderr}`, "error");
    return false;
  }

  // Also run install for Chromium
  ctx.ui.notify("Downloading Chromium...", "info");
  const chromium = await pi.exec("agent-browser", ["install"], { timeout: 120000 });
  if (chromium.code !== 0) {
    ctx.ui.notify(`Chromium install failed: ${chromium.stderr}`, "error");
    return false;
  }

  ctx.ui.notify("agent-browser installed successfully!", "info");
  return true;
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: TOOL_DESCRIPTION,
    parameters: Type.Object({
      command: Type.Optional(
        Type.String({
          description:
            "Single command string. Semicolons auto-batch: 'open url; snapshot -i; click @e3'. Prefer 'commands' for multi-step.",
        })
      ),
      commands: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Batch: array of commands run sequentially in one call. PREFER this for multi-step (open, snapshot, fill, click, etc). Fail-fast on errors.",
        })
      ),
    }),

    renderCall(args: { command?: string; commands?: string[] }, theme: any) {
      const cmds = args.commands ?? (args.command ? [args.command] : []);
      if (cmds.length <= 1) {
        const text =
          theme.fg("toolTitle", theme.bold("browser ")) +
          theme.fg("accent", cmds[0] || "");
        return new Text(text, 0, 0);
      }
      const text =
        theme.fg("toolTitle", theme.bold(`browser (${cmds.length} commands) `)) +
        theme.fg("accent", cmds[0] + (cmds.length > 1 ? ` … +${cmds.length - 1}` : ""));
      return new Text(text, 0, 0);
    },

    renderResult(
      result: any,
      { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
      theme: any,
    ) {
      // Partial streaming update during batch execution
      if (isPartial) {
        const details = result.details || {};
        const progress = details._progress || "Running...";
        return new Text(theme.fg("warning", progress), 0, 0);
      }

      const details = result.details || {};
      const batchResults: CommandResult[] = details._batchResults || [];

      // ── Batch result rendering (multiple commands) ──
      if (batchResults.length > 0) {
        const lines: string[] = [];
        let errors = 0;
        let screenshots = 0;
        let totalRefs = 0;

        for (const r of batchResults) {
          if (!r.ok) {
            errors++;
            if (expanded) {
              lines.push(
                theme.fg("error", `  ✗ ${r.action}: ${r.output.slice(0, 80)}`)
              );
            }
          } else if (r.action === "screenshot") {
            screenshots++;
            lines.push(theme.fg("success", "  ✓ Screenshot saved"));
          } else if (r.action === "snapshot") {
            const refCount = (r.output.match(/@e\d+/g) || []).length;
            totalRefs += refCount;
            lines.push(
              theme.fg("success", `  ✓ ${refCount} interactive elements`)
            );
          } else {
            const firstLine = r.output.split("\n")[0] || "(no output)";
            const etc = r.output.includes("\n") ? "…" : "";
            lines.push(
              theme.fg("dim", `  ✓ ${firstLine.slice(0, 80)}${etc}`)
            );
          }
        }

        let summary = theme.fg(
          "success",
          `Batch: ${batchResults.length} commands`
        );
        if (errors > 0) summary += theme.fg("error", `, ${errors} failed`);
        if (screenshots > 0) summary += `, ${screenshots} screenshots`;
        if (totalRefs > 0) summary += `, ${totalRefs} elements`;

        if (expanded && lines.length > 0) {
          summary += "\n" + lines.join("\n");
        }
        return new Text(summary, 0, 0);
      }

      // ── Error ──
      if (result.isError || details.error) {
        const errorText =
          details.error || result.content?.[0]?.text || "Error";
        return new Text(theme.fg("error", errorText), 0, 0);
      }

      const action = details.action || "";
      const content = result.content?.[0]?.text || "";

      // ── Screenshot ──
      if (action === "screenshot") {
        return new Text(
          theme.fg(
            "success",
            `Screenshot saved: ${details.screenshotPath || "unknown"}`
          ),
          0,
          0
        );
      }

      // ── Snapshot — show element count ──
      if (action === "snapshot") {
        const refCount = (content.match(/@e\d+/g) || []).length;
        let text = theme.fg("success", `${refCount} interactive elements`);
        if (details.truncated) {
          text += theme.fg("warning", " (truncated)");
        }
        if (expanded) {
          text += "\n" + theme.fg("dim", content);
        }
        return new Text(text, 0, 0);
      }

      // ── Default — compact output ──
      if (expanded) {
        return new Text(theme.fg("dim", content), 0, 0);
      }

      // Compact: first line only
      const firstLine = content.split("\n")[0] || "(no output)";
      const truncated = content.includes("\n") ? "…" : "";
      return new Text(theme.fg("dim", firstLine + truncated), 0, 0);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const installed = await ensureInstalled(pi, ctx);
      if (!installed) {
        return {
          content: [
            {
              type: "text",
              text: "agent-browser is not installed. Install manually with: npm install -g agent-browser && agent-browser install",
            },
          ],
          details: { error: "not-installed" },
          isError: true,
        };
      }

      // ── Resolve commands ──
      // commands[] array takes priority, then command string (with smart ; parsing)
      let cmds: string[];
      if (params.commands && params.commands.length > 0) {
        cmds = params.commands.filter((c: string) => c.trim().length > 0);
      } else if (params.command) {
        cmds = parseCommands(params.command);
      } else {
        return {
          content: [
            {
              type: "text",
              text: "No command provided. Use 'command' for a single command, 'commands' for an array, or separate with semicolons.",
            },
          ],
          details: { error: "no-command" },
          isError: true,
        };
      }

      if (cmds.length === 0) {
        return {
          content: [{ type: "text", text: "Empty command list." }],
          details: { error: "empty-command" },
          isError: true,
        };
      }

      // ── Single command fast path (backward compatible) ──
      if (cmds.length === 1) {
        const commandStr = cmds[0];
        const r = await runCommand(pi, commandStr, signal, 0, 1, onUpdate);

        if (!r.ok) {
          return {
            content: [{ type: "text", text: r.output }],
            details: {
              error: r.details.error,
              exitCode: r.details.exitCode,
              command: commandStr,
            },
            isError: true,
          };
        }

        const output = r.output;
        const action = r.action;

        // Screenshot: read file, return as image
        if (action === "screenshot" && r.details.screenshotPath) {
          const imgBlock = readScreenshotBlock(r.details.screenshotPath);
          if (imgBlock) {
            return {
              content: [
                {
                  type: "text",
                  text: `Screenshot saved: ${r.details.screenshotPath}`,
                },
                imgBlock,
              ],
              details: {
                command: commandStr,
                action,
                screenshotPath: r.details.screenshotPath,
              },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Screenshot saved to ${r.details.screenshotPath} but could not read file`,
              },
            ],
            details: {
              command: commandStr,
              action,
              screenshotPath: r.details.screenshotPath,
              readError: "failed to read screenshot file",
            },
          };
        }

        // Apply truncation to large outputs
        const resultText = formatTruncatedOutput(output, action);
        return {
          content: [{ type: "text", text: resultText || "(no output)" }],
          details: {
            command: commandStr,
            action,
            truncated: resultText !== output,
          },
        };
      }

      // ── Batch mode (multiple commands) ──
      const batchResults: CommandResult[] = [];
      const contentBlocks: any[] = [];
      let hadError = false;
      let lastScreenshotPath: string | null = null;

      for (let i = 0; i < cmds.length; i++) {
        // Check for abort between commands
        if (signal?.aborted) {
          batchResults.push({
            ok: false,
            output: "Aborted",
            action: "batch",
            details: { error: "aborted" },
          });
          break;
        }

        const r = await runCommand(pi, cmds[i], signal, i, cmds.length, onUpdate);
        batchResults.push(r);

        if (!r.ok) {
          hadError = true;
          contentBlocks.push({
            type: "text",
            text: `[${i + 1}/${cmds.length}] ✗ ${cmds[i]}\n${r.output}\n`,
          });
          // Stop on first error to avoid compounding failures
          break;
        }

        // Screenshot: read file and add as image block
        if (r.action === "screenshot" && r.details.screenshotPath) {
          lastScreenshotPath = r.details.screenshotPath;
          const imgBlock = readScreenshotBlock(lastScreenshotPath);
          if (imgBlock) {
            contentBlocks.push(imgBlock);
          }
        }

        // Snapshot: apply truncation
        if (r.action === "snapshot") {
          const snapshotText = formatTruncatedOutput(r.output, "snapshot");
          contentBlocks.push({
            type: "text",
            text: `[${i + 1}/${cmds.length}] snapshot -i\n${snapshotText}`,
          });
        } else if (r.action !== "screenshot") {
          // Other commands: include output
          const firstLine = r.output.split("\n")[0] || "(no output)";
          const etc = r.output.includes("\n") ? "…" : "";
          contentBlocks.push({
            type: "text",
            text: `[${i + 1}/${cmds.length}] ${cmds[i]}\n${firstLine}${etc}`,
          });
        }
      }

      // Build a compact text summary
      const summaryParts: string[] = [];
      const ok = batchResults.filter((r) => r.ok).length;
      const failed = batchResults.filter((r) => !r.ok).length;
      summaryParts.push(`Executed ${batchResults.length} of ${cmds.length} commands`);
      if (failed > 0) summaryParts.push(`${failed} failed`);

      const lastSnapshot = batchResults
        .filter((r) => r.ok && r.action === "snapshot")
        .pop();
      if (lastSnapshot) {
        const refCount = (lastSnapshot.output.match(/@e\d+/g) || []).length;
        summaryParts.push(`${refCount} interactive elements in last snapshot`);
      }

      if (lastScreenshotPath) {
        summaryParts.push(`screenshot: ${lastScreenshotPath}`);
      }

      // Prepend the summary as the first content block
      contentBlocks.unshift({
        type: "text",
        text: summaryParts.join(" | "),
      });

      return {
        content: contentBlocks,
        details: {
          _batchResults: batchResults,
          _batch: true,
          _commands: cmds,
          _ok: ok,
          _failed: failed,
        },
        isError: hadError && batchResults.every((r) => !r.ok),
      };
    },
  });

  // Clean up browser on session exit
  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      await pi.exec("agent-browser", ["close"], { timeout: 5000 });
    } catch {
      // Ignore — browser may already be closed
    }
  });
}
