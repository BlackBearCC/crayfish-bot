# Desktop Control Skill

AI桌面控制功能已实现，让AI能够像人一样控制电脑。

## 实现文件

| 文件 | 说明 |
|------|------|
| `skills/desktop-control/SKILL.md` | Skill定义文档 |
| `src/agents/tools/desktop-control-tool.schema.ts` | 工具参数Schema |
| `src/agents/tools/desktop-control-tool.ts` | 工具实现 |

## 功能特性

### 截图
- `action:screenshot` - 全屏截图
- `action:screenshot region:{x,y,width,height}` - 区域截图

### 鼠标控制
- `action:mouse_move x:500 y:300` - 移动鼠标
- `action:mouse_click` - 左键点击（当前位置）
- `action:mouse_click x:500 y:300` - 点击指定位置
- `action:mouse_double_click` - 双击
- `action:mouse_right_click` - 右键点击
- `action:mouse_drag fromX:100 fromY:200 toX:400 toY:200` - 拖拽
- `action:mouse_scroll scrollAmount:5` - 滚轮滚动

### 键盘控制
- `action:type_text text:"Hello World"` - 输入文字
- `action:key_press key:"Enter"` - 按键
- `action:key_press key:"c" modifiers:["ctrl"]` - 组合键

### 信息获取
- `action:get_screen_size` - 获取屏幕分辨率
- `action:get_mouse_position` - 获取鼠标位置

## 平台支持

| 平台 | 支持度 | 说明 |
|------|--------|------|
| Windows | 完整 | PowerShell + .NET实现 |
| macOS | 部分 | 需要安装 cliclick |
| Linux | 部分 | 需要安装 xdotool |

## 安全特性

- **Owner-only**: 只有所有者可以使用此工具（`ownerOnly: true`）
- 需要显式配置才能启用

## 使用示例

```
# 截图查看当前屏幕
desktop action:screenshot

# 点击坐标(500, 300)
desktop action:mouse_click x:500 y:300

# 输入文字
desktop action:type_text text:"Hello"

# 按Enter键
desktop action:key_press key:"Enter"

# 拖拽文件
desktop action:mouse_drag fromX:100 fromY:200 toX:400 toY:200
```

## 工作原理

1. **截图**: 使用平台原生API捕获屏幕
   - Windows: PowerShell + System.Drawing
   - macOS: screencapture命令
   - Linux: gnome-screenshot或ImageMagick

2. **鼠标控制**: 调用系统API
   - Windows: user32.dll mouse_event
   - macOS: cliclick工具
   - Linux: xdotool

3. **键盘控制**: 模拟按键输入
   - Windows: SendKeys
   - macOS: cliclick
   - Linux: xdotool

## 注意事项

1. 多模态大模型直接分析截图，不需要OCR
2. 坐标系统：(0,0)在左上角，X向右，Y向下
3. Windows平台功能最完整
4. macOS和Linux需要额外安装工具
