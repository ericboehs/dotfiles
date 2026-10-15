// /update — bring a mise-managed pi current, since `pi update` can't.
//
// pi here is installed by mise from the pin in .config/mise/config.toml, so
// `pi update` refuses ("not managed by a global npm install") and only adds
// "Extensions are skipped. Run pi update --extensions". The real work is a
// mise concern: move the pin to the current npm release, install that exact
// version, then reconverge packages the way `mise run bootstrap:pi` already
// does. That script lives in the dotfiles repo as the `update:pi` task; this
// command finds the checkout and runs it.
//
// /update check reports the available version and changes nothing, as the same
// banner pi shows at startup. That banner only says `pi update`, which cannot
// self-update this install, so this extension suppresses it and draws one that
// also names /update.

import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DynamicBorder, VERSION, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, getCapabilities, hyperlink, type AutocompleteItem } from "@earendil-works/pi-tui";

const TASK = "update:pi";
const BANNER_TYPE = "pi-update-available";
const CHANGELOG_URL = "https://pi.dev/changelog";

// The startup availability check spawns `mise run update:pi`, which starts a
// whole npm process (~350ms of CPU). Run inline at session_start, that work
// competes with pi's own first paint. So it waits until boot is done and runs
// at most once per window across every pane, with the result in a stamp
// file. A launch inside the window shows the cached banner without spawning.
const STARTUP_CHECK_DELAY_MS = 15_000;
const STARTUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STAMP_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "update-check.json");

interface CheckStamp {
  at: number;
  from: string;
  to?: string;
}

async function readStamp(): Promise<CheckStamp | null> {
  try {
    const stamp = JSON.parse(await readFile(STAMP_FILE, "utf8")) as CheckStamp;
    return typeof stamp.at === "number" && typeof stamp.from === "string" ? stamp : null;
  } catch {
    return null;
  }
}

async function writeStamp(stamp: CheckStamp): Promise<void> {
  try {
    await mkdir(dirname(STAMP_FILE), { recursive: true });
    await writeFile(STAMP_FILE, `${JSON.stringify(stamp)}\n`);
  } catch {
    // A missing stamp just means the next launch checks again.
  }
}

interface UpdateResult {
  from: string;
  to: string;
  published: string;
  restart: boolean;
  changed: boolean;
  check: boolean;
}

// ~/.config/mise/config.toml is a symlink into the dotfiles checkout, and the
// checkout is the only place the pin and the update:pi task both exist. mise
// run from the project that happens to be open would not find the task.
async function dotfilesRoot(): Promise<string | null> {
  const config = join(homedir(), ".config", "mise", "config.toml");
  let resolved: string;
  try {
    resolved = await realpath(config);
  } catch {
    resolved = "";
  }

  const candidates = [
    resolved ? dirname(resolved) : "",
    join(homedir(), "Code", "github.com", "ericboehs", "dotfiles"),
  ].filter((dir) => dir !== "");

  for (const dir of candidates) {
    const root = await gitTop(dir);
    if (root) return root;
  }
  return null;
}

function gitTop(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() || null : null));
  });
}

function runTask(
  cwd: string,
  check: boolean,
  onLine: (line: string) => void,
): Promise<{ code: number; output: string }> {
  const env = { ...process.env };
  if (check) env.PI_UPDATE_CHECK = "1";

  return new Promise((resolve) => {
    const child = spawn("mise", ["run", TASK], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let buf = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (buf.trim()) onLine(buf.trim());
      resolve({ code, output });
    };
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      buf += text;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
        nl = buf.indexOf("\n");
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => {
      const missing = err.message.includes("ENOENT");
      output += missing
        ? "update:pi: mise is not on PATH\n"
        : `update:pi: failed to start mise: ${err.message}\n`;
      finish(missing ? 127 : 1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

function parseResult(output: string): UpdateResult | null {
  const line = output.match(/^update:pi: result (.+)$/m)?.[1];
  if (!line) return null;
  const fields = new Map<string, string>();
  for (const token of line.split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const from = fields.get("from");
  const to = fields.get("to");
  if (!from || !to) return null;
  return {
    from,
    to,
    published: fields.get("published") ?? "",
    restart: fields.get("restart") === "yes",
    changed: fields.get("changed") === "yes",
    check: fields.get("check") === "yes",
  };
}

// The publish timestamp tells whether a release is still inside the window
// mise's minimum_release_age would normally hide — worth seeing before a restart.
function age(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function bannerLines(version: string, theme: Theme): { title: string; changelog: string } {
  const title =
    theme.bold(theme.fg("warning", "Update Available")) +
    "\n" +
    theme.fg("muted", `New version ${version} is available. Run `) +
    theme.fg("accent", "pi update") +
    theme.fg("muted", " or ") +
    theme.fg("accent", "/update");
  const url = getCapabilities().hyperlinks
    ? hyperlink(theme.fg("accent", CHANGELOG_URL), CHANGELOG_URL)
    : theme.fg("accent", CHANGELOG_URL);
  return { title, changelog: theme.fg("muted", "Changelog: ") + url };
}

function renderBanner(version: string, theme: Theme): Container {
  const { title, changelog } = bannerLines(version, theme);
  const border = () => new DynamicBorder((text) => theme.fg("warning", text));
  const box = new Container();
  box.addChild(border());
  box.addChild(new Text(title, 1, 0));
  box.addChild(new Text(changelog, 1, 0));
  box.addChild(border());
  return box;
}

function bannerContent(version: string): string {
  return [
    "Update Available",
    `New version ${version} is available. Run pi update or /update`,
    `Changelog: ${CHANGELOG_URL}`,
  ].join("\n");
}

function summary(result: UpdateResult, ok: boolean): { text: string; level: "info" | "warning" | "error" } {
  if (!ok) return { text: "pi update failed", level: "error" };
  const fresh = result.published && result.published !== "none" ? age(result.published) : "";
  const when = fresh ? `, published ${fresh}` : "";
  if (result.restart) {
    return {
      text: `pi ${result.to} installed${when} — restart pi to run it; the pin change is uncommitted`,
      level: "warning",
    };
  }
  return { text: `pi ${result.from} is current; packages reconverged`, level: "info" };
}

export default function (pi: ExtensionAPI) {
  // pi draws its own "Update Available" banner from run(), after extensions
  // load. Its instruction is only `pi update`, which refuses on this install.
  // Skip that check so the banner below is the one that shows.
  if (!process.env.PI_OFFLINE) process.env.PI_SKIP_VERSION_CHECK = "1";

  let announcedFor: string | undefined;

  const showBanner = (version: string): void => {
    pi.sendMessage({
      customType: BANNER_TYPE,
      content: bannerContent(version),
      display: true,
      details: { version },
    });
  };

  pi.registerMessageRenderer(BANNER_TYPE, (message, _options, theme) => {
    const version = (message.details as { version?: unknown } | undefined)?.version;
    if (typeof version !== "string" || version === "") return undefined;
    return renderBanner(version, theme);
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || process.env.PI_OFFLINE || announcedFor) return;
    const announce = (to: string | undefined): void => {
      if (!to || to === VERSION || announcedFor === to) return;
      announcedFor = to;
      showBanner(to);
    };
    void (async () => {
      try {
        // A stamp from this same pi version inside the window is current enough.
        const stamp = await readStamp();
        if (stamp && stamp.from === VERSION && Date.now() - stamp.at < STARTUP_CHECK_INTERVAL_MS) {
          announce(stamp.to);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_CHECK_DELAY_MS).unref());
        // Another pane may have checked while this one waited.
        const again = await readStamp();
        if (again && again.from === VERSION && Date.now() - again.at < STARTUP_CHECK_INTERVAL_MS) {
          announce(again.to);
          return;
        }
        await writeStamp({ at: Date.now(), from: VERSION });
        const root = await dotfilesRoot();
        if (!root) return;
        const { code, output } = await runTask(root, true, () => {});
        const result = code === 0 ? parseResult(output) : null;
        if (!result) return;
        await writeStamp({ at: Date.now(), from: VERSION, to: result.changed ? result.to : undefined });
        if (result.changed) announce(result.to);
      } catch {
        // A failed availability check is not worth a startup error. /update still works.
      }
    })();
  });

  pi.registerCommand("update", {
    description: "Update pi and its packages (mise-managed install)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      const item: AutocompleteItem = {
        value: "check",
        label: "check",
        description: "Show what would change, touch nothing",
      };
      return item.value.startsWith(prefix) ? [item] : [];
    },
    handler: async (args, ctx) => {
      const stash = globalThis as { __piUpdateRunning?: boolean };
      if (stash.__piUpdateRunning) {
        if (ctx.hasUI) ctx.ui.notify("An update is already running", "warning");
        return;
      }

      const check = args.trim() === "check";
      const root = await dotfilesRoot();
      if (!root) {
        if (ctx.hasUI) ctx.ui.notify("Can't find the dotfiles checkout that pins pi", "error");
        return;
      }

      stash.__piUpdateRunning = true;
      if (ctx.hasUI) ctx.ui.setStatus("update", check ? "pi update: checking…" : "pi update: running…");
      try {
        const { code, output } = await runTask(root, check, (line) => {
          if (ctx.hasUI) ctx.ui.setStatus("update", line);
        });

        const result = parseResult(output);
        if (code === 0 && result?.check) {
          if (result.changed) {
            announcedFor = result.to;
            showBanner(result.to);
          } else if (ctx.hasUI) {
            ctx.ui.notify(`pi ${result.from} is current`, "info");
          }
          return;
        }

        const { text, level } = result
          ? summary(result, code === 0)
          : { text: code === 0 ? "pi update done" : "pi update failed", level: code === 0 ? "info" as const : "error" as const };
        if (ctx.hasUI) ctx.ui.notify(text, level);

        // The task's own stdout is the record: version jump, the pin diff, and
        // whether bootstrap:pi converged. A fence keeps the diff's leading
        // dashes from being read as a markdown list.
        pi.sendMessage({
          customType: "pi-update",
          content: ["```", output.trim() || "(no output)", "```"].join("\n"),
          display: true,
        });

        // A newer pi is on disk but this process is the old one; reloading
        // would only re-read extensions into the process that needs replacing.
        // When the version didn't move, a reload picks up reconverged packages.
        if (code === 0 && result && !result.restart && !result.check) {
          await ctx.reload();
        }
      } finally {
        stash.__piUpdateRunning = false;
        if (ctx.hasUI) ctx.ui.setStatus("update", undefined);
      }
    },
  });
}
