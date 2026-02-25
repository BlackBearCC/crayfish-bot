---
name: desktop-control
description: Control the computer desktop like a human - screenshot, mouse, keyboard operations for GUI automation.
homepage: https://github.com/openclaw/openclaw
metadata:
  {
    "openclaw":
      {
        "emoji": "🖥️",
        "requires": {},
        "os": ["win32", "darwin", "linux"],
      },
  }
---

# Desktop Control

Control the computer desktop GUI like a human user. This tool allows the AI to:

- Take screenshots to see what's on screen
- Move and click the mouse
- Type text and press keys
- Drag and drop elements

## Actions

| Action | Description |
|--------|-------------|
| `screenshot` | Capture the entire screen or a specific region |
| `mouse_move` | Move mouse to x,y coordinates |
| `mouse_click` | Click at current position or specific coordinates |
| `mouse_double_click` | Double-click at position |
| `mouse_right_click` | Right-click at position |
| `mouse_drag` | Drag from one point to another |
| `mouse_scroll` | Scroll up/down at position |
| `key_press` | Press a specific key or key combination |
| `type_text` | Type text like a human |
| `get_screen_size` | Get screen resolution |
| `get_mouse_position` | Get current mouse coordinates |

## Usage Examples

### Take a screenshot
```
desktop action:screenshot
```

### Click on coordinates
```
desktop action:mouse_click x:500 y:300
```

### Type text
```
desktop action:type_text text:"Hello World"
```

### Press a key
```
 desktop action:key_press key:"Enter"
```

### Drag and drop
```
desktop action:mouse_drag fromX:100 fromY:200 toX:400 toY:200
```

## Coordinate System

- Origin (0,0) is at the **top-left** of the screen
- X increases to the right
- Y increases downward

## Security

This tool requires explicit user approval for each operation when used by non-owner users. The tool is owner-only by default for security reasons.

## Platform Support

- ✅ Windows (primary support)
- ✅ macOS (via nut.js)
- ✅ Linux (via nut.js)

## Implementation Notes

Screenshots are automatically resized and compressed to stay within token limits for multimodal LLMs. No OCR is performed - the AI directly analyzes the screenshot visually.
