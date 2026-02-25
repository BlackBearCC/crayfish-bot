import child_process from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DesktopControlToolSchema } from "./desktop-control-tool.schema.js";
import { imageResultFromFile, jsonResult, readStringParam, type AnyAgentTool } from "./common.js";

const execFile = promisify(child_process.execFile);

// Platform detection
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const _isLinux = process.platform === "linux";

// Screen cache for getScreenSize
let screenSizeCache: { width: number; height: number } | null = null;

/**
 * Take a screenshot using platform-specific methods
 */
async function takeScreenshot(region?: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<{ path: string; buffer: Buffer }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-screenshot-"));
  const screenshotPath = path.join(tmpDir, "screenshot.png");

  if (isWindows) {
    // Use PowerShell with .NET for Windows screenshot
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
${region ? `
$x = ${region.x}
$y = ${region.y}
$width = ${region.width}
$height = ${region.height}
` : `
$x = $bounds.X
$y = $bounds.Y
$width = $bounds.Width
$height = $bounds.Height
`}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)

$bitmap.Save("${screenshotPath}")
$graphics.Dispose()
$bitmap.Dispose()
`;
    await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
      timeout: 30000,
    });
  } else if (isMac) {
    // Use macOS screencapture
    const args = region
      ? [
          "-x",
          "-R",
          `${region.x},${region.y},${region.width},${region.height}`,
          screenshotPath,
        ]
      : ["-x", screenshotPath];
    await execFile("screencapture", args, { timeout: 30000 });
  } else {
    // Linux - try gnome-screenshot or import (ImageMagick)
    try {
      const args = region
        ? [
            "-f",
            screenshotPath,
            "-a",
            "-x",
            `${region.x}`,
            "-y",
            `${region.y}`,
            "-w",
            `${region.width}`,
            "-h",
            `${region.height}`,
          ]
        : ["-f", screenshotPath];
      await execFile("gnome-screenshot", args, { timeout: 30000 });
    } catch {
      // Fallback to ImageMagick import
      const args = region
        ? [
            "-window",
            "root",
            "-crop",
            `${region.width}x${region.height}+${region.x}+${region.y}`,
            screenshotPath,
          ]
        : ["-window", "root", screenshotPath];
      await execFile("import", args, { timeout: 30000 });
    }
  }

  const buffer = await fs.readFile(screenshotPath);
  return { path: screenshotPath, buffer };
}

/**
 * Get screen size using platform-specific methods
 */
async function getScreenSize(): Promise<{ width: number; height: number }> {
  if (screenSizeCache) {
    return screenSizeCache;
  }

  if (isWindows) {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
Write-Output "$($screen.Bounds.Width),$($screen.Bounds.Height)"
`;
    const { stdout } = await execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", psScript],
      { timeout: 10000 },
    );
    const [width, height] = stdout.trim().split(",").map(Number);
    screenSizeCache = { width, height };
    return screenSizeCache;
  } else if (isMac) {
    const { stdout } = await execFile(
      "system_profiler",
      ["SPDisplaysDataType", "-json"],
      { timeout: 10000 },
    );
    const data = JSON.parse(stdout);
    const display = data?.SPDisplaysDataType?.[0]?.spdisplays_ndrvs?.[0];
    if (display?._spdisplays_pixels) {
      const [width, height] = display._spdisplays_pixels.split(" x ").map(Number);
      screenSizeCache = { width, height };
      return screenSizeCache;
    }
    throw new Error("Could not determine screen size");
  } else {
    // Linux - try xrandr
    try {
      const { stdout } = await execFile("xrandr", ["--current"], { timeout: 10000 });
      const match = stdout.match(/\*\s+(\d+)x(\d+)/);
      if (match) {
        screenSizeCache = { width: Number(match[1]), height: Number(match[2]) };
        return screenSizeCache;
      }
    } catch {
      // ignore
    }
    throw new Error("Could not determine screen size on Linux");
  }
}

/**
 * Get current mouse position
 */
async function getMousePosition(): Promise<{ x: number; y: number }> {
  if (isWindows) {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$pos = [System.Windows.Forms.Cursor]::Position
Write-Output "$($pos.X),$($pos.Y)"
`;
    const { stdout } = await execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", psScript],
      { timeout: 10000 },
    );
    const [x, y] = stdout.trim().split(",").map(Number);
    return { x, y };
  } else if (isMac) {
    // macOS doesn't have a built-in way to get mouse position easily
    // Would need a small AppleScript or binary
    throw new Error("get_mouse_position not implemented for macOS yet");
  } else {
    throw new Error("get_mouse_position not implemented for Linux yet");
  }
}

/**
 * Move mouse to position
 */
async function mouseMove(x: number, y: number): Promise<void> {
  if (isWindows) {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})
`;
    await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
      timeout: 10000,
    });
  } else if (isMac) {
    // Use cliclick for macOS
    await execFile("cliclick", [`m:${Math.round(x)},${Math.round(y)}`], {
      timeout: 10000,
    });
  } else {
    // Linux - use xdotool
    await execFile("xdotool", ["mousemove", String(Math.round(x)), String(Math.round(y))], {
      timeout: 10000,
    });
  }
}

/**
 * Perform mouse click
 */
async function mouseClick(
  button: "left" | "right" | "middle" = "left",
  double: boolean = false,
): Promise<void> {
  if (isWindows) {
    const psScript = `
# Use mouse_event API for clicks
$signature=@'
[DllImport("user32.dll",CharSet=CharSet.Auto, CallingConvention=CallingConvention.StdCall)]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
'@

$MouseEvent = Add-Type -memberDefinition $signature -name "MouseEvent" -passThru

${button === "right" ? (double ? `
$MouseEvent::mouse_event(0x00000008, 0, 0, 0, 0)
$MouseEvent::mouse_event(0x00000010, 0, 0, 0, 0)
$MouseEvent::mouse_event(0x00000008, 0, 0, 0, 0)
$MouseEvent::mouse_event(0x00000010, 0, 0, 0, 0)
` : `
$MouseEvent::mouse_event(0x00000008, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
$MouseEvent::mouse_event(0x00000010, 0, 0, 0, 0)
`) : button === "middle" ? `
$MouseEvent::mouse_event(0x00000020, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
$MouseEvent::mouse_event(0x00000040, 0, 0, 0, 0)
` : double ? `
$MouseEvent::mouse_event(0x00000002, 0, 0, 0, 0)
$MouseEvent::mouse_event(0x00000004, 0, 0, 0, 0)
$MouseEvent::mouse_event(0x00000002, 0, 0, 0, 0)
$MouseEvent::mouse_event(0x00000004, 0, 0, 0, 0)
` : `
$MouseEvent::mouse_event(0x00000002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
$MouseEvent::mouse_event(0x00000004, 0, 0, 0, 0)
`}
`;
    await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
      timeout: 10000,
    });
  } else if (isMac) {
    const buttonMap = { left: "c", right: "r", middle: "m" };
    const baseCmd = double ? "dc" : buttonMap[button];
    await execFile("cliclick", [baseCmd], { timeout: 10000 });
  } else {
    const buttonMap = { left: "1", middle: "2", right: "3" };
    const clickArg = double ? "--repeat" : "";
    const args = ["click", clickArg, buttonMap[button]].filter(Boolean);
    await execFile("xdotool", args, { timeout: 10000 });
  }
}

/**
 * Drag mouse from one point to another
 */
async function mouseDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<void> {
  if (isWindows) {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms

# Move to start position
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(fromX)}, ${Math.round(fromY)})
Start-Sleep -Milliseconds 50

# mouse_event API
$signature=@'
[DllImport("user32.dll",CharSet=CharSet.Auto, CallingConvention=CallingConvention.StdCall)]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
'@

$MouseEvent = Add-Type -memberDefinition $signature -name "MouseEvent" -passThru

# Left button down
$MouseEvent::mouse_event(0x00000002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 100

# Move to end position (smooth drag)
$steps = 10
$startX = ${Math.round(fromX)}
$startY = ${Math.round(fromY)}
$endX = ${Math.round(toX)}
$endY = ${Math.round(toY)}

for ($i = 1; $i -le $steps; $i++) {
    $x = $startX + ($endX - $startX) * $i / $steps
    $y = $startY + ($endY - $startY) * $i / $steps
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$x, [int]$y)
    Start-Sleep -Milliseconds 20
}

# Left button up
$MouseEvent::mouse_event(0x00000004, 0, 0, 0, 0)
`;
    await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
      timeout: 10000,
    });
  } else if (isMac) {
    await execFile(
      "cliclick",
      [`dd:${Math.round(fromX)},${Math.round(fromY)}`, `du:${Math.round(toX)},${Math.round(toY)}`],
      { timeout: 10000 },
    );
  } else {
    await execFile(
      "xdotool",
      [
        "mousemove",
        String(Math.round(fromX)),
        String(Math.round(fromY)),
        "mousedown",
        "1",
        "mousemove",
        String(Math.round(toX)),
        String(Math.round(toY)),
        "mouseup",
        "1",
      ],
      { timeout: 10000 },
    );
  }
}

/**
 * Scroll mouse wheel
 */
async function mouseScroll(amount: number): Promise<void> {
  if (isWindows) {
    const psScript = `
$signature=@'
[DllImport("user32.dll",CharSet=CharSet.Auto, CallingConvention=CallingConvention.StdCall)]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, uint dwExtraInfo);
'@

$MouseEvent = Add-Type -memberDefinition $signature -name "MouseEvent" -passThru

# WHEEL_DELTA = 120
$delta = ${amount > 0 ? "120" : "-120"}
$MouseEvent::mouse_event(0x00000800, 0, 0, $delta, 0)
`;
    await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
      timeout: 10000,
    });
  } else if (isMac) {
    const direction = amount > 0 ? "up" : "down";
    const times = Math.abs(Math.round(amount / 3));
    for (let i = 0; i < times; i++) {
      await execFile("clickey", [direction], { timeout: 5000 });
    }
  } else {
    await execFile("xdotool", ["click", amount > 0 ? "4" : "5"], { timeout: 10000 });
  }
}

/**
 * Type text like a human
 */
async function typeText(text: string): Promise<void> {
  if (isWindows) {
    // SendKeys special characters that need escaping: ^ % ~ ( ) { } [ ] + @
    const escaped = text
      .replace(/"/g, '`"')
      .replace(/[{}]/g, "{$&}");  // Escape braces by doubling them
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${escaped}")
`;
    await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
      timeout: 10000,
    });
  } else if (isMac) {
    await execFile("cliclick", [`t:"${text.replace(/"/g, '\\"')}"`], { timeout: 10000 });
  } else {
    await execFile("xdotool", ["type", text], { timeout: 10000 });
  }
}

/**
 * Press a key or key combination
 */
async function keyPress(key: string, modifiers: string[] = []): Promise<void> {
  const keyMap: Record<string, string> = {
    // Windows Virtual Key Codes
    Enter: "{ENTER}",
    Return: "{ENTER}",
    Tab: "{TAB}",
    Escape: "{ESC}",
    Esc: "{ESC}",
    Space: " ",
    Backspace: "{BACKSPACE}",
    Delete: "{DELETE}",
    Del: "{DELETE}",
    Insert: "{INSERT}",
    Home: "{HOME}",
    End: "{END}",
    PageUp: "{PGUP}",
    PageDown: "{PGDN}",
    Left: "{LEFT}",
    Right: "{RIGHT}",
    Up: "{UP}",
    Down: "{DOWN}",
    F1: "{F1}",
    F2: "{F2}",
    F3: "{F3}",
    F4: "{F4}",
    F5: "{F5}",
    F6: "{F6}",
    F7: "{F7}",
    F8: "{F8}",
    F9: "{F9}",
    F10: "{F10}",
    F11: "{F11}",
    F12: "{F12}",
    Ctrl: "^",
    Control: "^",
    Alt: "%",
    Shift: "+",
    Win: "#",
    Command: "#",
  };

  if (isWindows) {
    // Use keyMap for Windows SendKeys format
    const mappedKey = keyMap[key] || key;
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${mappedKey}")
`;
    await execFile("powershell.exe", ["-NoProfile", "-Command", psScript], {
      timeout: 10000,
    });
  } else if (isMac) {
    // Map keys for cliclick
    const modifierMap: Record<string, string> = {
      ctrl: "c",
      alt: "a",
      shift: "s",
      cmd: "m",
      command: "m",
      win: "m",
    };

    const modString = modifiers.map((m) => modifierMap[m.toLowerCase()] || "").join("");
    const keyString = key.toLowerCase();

    await execFile("cliclick", [`kd:${modString}${keyString}`, `ku:${modString}${keyString}`], {
      timeout: 10000,
    });
  } else {
    const modMap: Record<string, string> = {
      ctrl: "ctrl",
      alt: "alt",
      shift: "shift",
      super: "super",
    };
    const modString = modifiers.map((m) => modMap[m.toLowerCase()] || m).join("+");
    const keyCombo = modString ? `${modString}+${key}` : key;

    await execFile("xdotool", ["key", keyCombo], { timeout: 10000 });
  }
}

export function createDesktopControlTool(): AnyAgentTool {
  return {
    label: "Desktop Control",
    name: "desktop",
    description: [
      "Control the computer desktop GUI like a human user - screenshot, mouse, keyboard operations.",
      "Screenshot: Capture the screen to see current state. Use for visual feedback.",
      "Mouse: Move, click (left/right/middle), double-click, drag, scroll.",
      "Keyboard: Type text or press specific keys.",
      "Coordinates: (0,0) is top-left, X increases right, Y increases down.",
      "Best practice: screenshot first, then click/type based on what you see.",
      "Platform support: Windows (full), macOS (partial), Linux (partial).",
    ].join(" "),
    parameters: DesktopControlToolSchema,
    ownerOnly: true, // Security: only owner can control the desktop
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) ?? "";

      switch (action) {
        case "screenshot": {
          const region =
            typeof params.region === "object" && params.region !== null
              ? (params.region as { x: number; y: number; width: number; height: number })
              : undefined;

          const { path: screenshotPath, buffer: _buffer } = await takeScreenshot(region);

          // Clean up temp file after sending
          const cleanup = () => {
            fs.rm(path.dirname(screenshotPath), { recursive: true, force: true }).catch(() => {});
          };

          try {
            const result = await imageResultFromFile({
              label: "desktop:screenshot",
              path: screenshotPath,
              details: { action, region },
            });
            // Schedule cleanup after response is sent
            setTimeout(cleanup, 5000);
            return result;
          } catch (error) {
            cleanup();
            throw error;
          }
        }

        case "mouse_move": {
          const x = Number(params.x);
          const y = Number(params.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error("x and y coordinates required");
          }
          await mouseMove(x, y);
          return jsonResult({ ok: true, action, x, y });
        }

        case "mouse_click":
        case "mouse_double_click":
        case "mouse_right_click": {
          const x = Number(params.x);
          const y = Number(params.y);
          const buttonStr = readStringParam(params, "button") ?? "left";
          const button =
            action === "mouse_right_click"
              ? "right"
              : (buttonStr as "left" | "right" | "middle");
          const double = action === "mouse_double_click" || Boolean(params.double);

          // Move first if coordinates provided
          if (Number.isFinite(x) && Number.isFinite(y)) {
            await mouseMove(x, y);
          }

          await mouseClick(button, double);
          return jsonResult({
            ok: true,
            action,
            button,
            double,
            ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}),
          });
        }

        case "mouse_drag": {
          const fromX = Number(params.fromX);
          const fromY = Number(params.fromY);
          const toX = Number(params.toX);
          const toY = Number(params.toY);

          if (!Number.isFinite(fromX) || !Number.isFinite(fromY) || !Number.isFinite(toX) || !Number.isFinite(toY)) {
            throw new Error("fromX, fromY, toX, toY coordinates required");
          }

          await mouseDrag(fromX, fromY, toX, toY);
          return jsonResult({ ok: true, action, fromX, fromY, toX, toY });
        }

        case "mouse_scroll": {
          const amount = Number(params.scrollAmount ?? 3);
          const x = Number(params.x);
          const y = Number(params.y);

          // Move to position first if provided
          if (Number.isFinite(x) && Number.isFinite(y)) {
            await mouseMove(x, y);
          }

          await mouseScroll(amount);
          return jsonResult({ ok: true, action, amount });
        }

        case "key_press": {
          const key = readStringParam(params, "key", { required: true }) ?? "";
          const modifiers = Array.isArray(params.modifiers)
            ? params.modifiers.map(String)
            : [];

          if (!key) {
            throw new Error("key parameter required");
          }

          await keyPress(key, modifiers);
          return jsonResult({ ok: true, action, key, modifiers });
        }

        case "type_text": {
          const text = readStringParam(params, "text", { required: true }) ?? "";
          if (!text) {
            throw new Error("text parameter required");
          }

          await typeText(text);
          return jsonResult({ ok: true, action, textLength: text.length });
        }

        case "get_screen_size": {
          const size = await getScreenSize();
          return jsonResult({ ok: true, action, ...size });
        }

        case "get_mouse_position": {
          const pos = await getMousePosition();
          return jsonResult({ ok: true, action, ...pos });
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
