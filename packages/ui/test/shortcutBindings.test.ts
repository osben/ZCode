import { describe, expect, it } from "vitest";
import { SHORTCUT_COMMANDS, isValidShortcutBinding } from "@zcode/shared";
import {
  buildShortcutOverridesAfterAppend,
  buildShortcutOverridesAfterSteal,
  buildShortcutOverridesWithoutBindingAt,
  buildShortcutOverridesWithBindingAt,
  checkShortcutBindingConflict,
  isSamePhysicalBinding,
  RESERVED_BINDINGS,
} from "../src/shortcuts/conflicts.js";
import {
  formatShortcutBindingLabel,
  formatShortcutBindingLabelParts,
} from "../src/shortcuts/label.js";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutEventNoise,
  isShortcutRecordingActive,
  matchesShortcutBinding,
  recordShortcutBinding,
  resolveEffectiveShortcutBindings,
  setShortcutRecordingActive,
  type ShortcutBindingEvent,
} from "../src/shortcuts/bindings.js";

const MAC = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" };
const WIN = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" };
const LINUX = { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" };

/** Build a keyboard event (filling only the fields shortcuts care about). */
function keyEvent(patch: Partial<ShortcutBindingEvent> & { key: string }): ShortcutBindingEvent {
  return {
    code: undefined,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    ...patch,
  };
}

describe("快捷键噪声过滤（IME / 长按）", () => {
  it("IME 组合中（isComposing / Process / Dead / keyCode 229）与 repeat 均视为噪声", () => {
    expect(isShortcutEventNoise(keyEvent({ key: "k", isComposing: true }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "Process" }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "Dead" }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "k", keyCode: 229 }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "k", repeat: true }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "k" }))).toBe(false);
  });

  it("噪声事件不命中任何绑定", () => {
    const macCmdK = keyEvent({ key: "k", code: "KeyK", metaKey: true });
    expect(matchesShortcutBinding(macCmdK, "CmdOrCtrl+k", MAC)).toBe(true);
    expect(matchesShortcutBinding({ ...macCmdK, isComposing: true }, "CmdOrCtrl+k", MAC)).toBe(
      false,
    );
    expect(matchesShortcutBinding({ ...macCmdK, repeat: true }, "CmdOrCtrl+k", MAC)).toBe(false);
  });
});

describe("快捷键通用匹配器：平台隔离与修饰键精确匹配", () => {
  it("CmdOrCtrl 在 mac 匹配 Cmd、在 win/linux 匹配 Ctrl，且平台隔离", () => {
    const macCmdK = keyEvent({ key: "k", code: "KeyK", metaKey: true });
    const winCtrlK = keyEvent({ key: "k", code: "KeyK", ctrlKey: true });
    expect(matchesShortcutBinding(macCmdK, "CmdOrCtrl+k", MAC)).toBe(true);
    expect(matchesShortcutBinding(macCmdK, "CmdOrCtrl+k", WIN)).toBe(false);
    expect(matchesShortcutBinding(winCtrlK, "CmdOrCtrl+k", WIN)).toBe(true);
    expect(matchesShortcutBinding(winCtrlK, "CmdOrCtrl+k", MAC)).toBe(false);
    expect(matchesShortcutBinding(winCtrlK, "CmdOrCtrl+k", LINUX)).toBe(true);
  });

  it("多余修饰键不算命中（精确匹配）", () => {
    const cmdCtrlK = keyEvent({ key: "k", code: "KeyK", metaKey: true, ctrlKey: true });
    expect(matchesShortcutBinding(cmdCtrlK, "CmdOrCtrl+k", MAC)).toBe(false);
    const ctrlShiftJ = keyEvent({ key: "j", code: "KeyJ", ctrlKey: true, shiftKey: true });
    expect(matchesShortcutBinding(ctrlShiftJ, "CmdOrCtrl+j", WIN)).toBe(false);
    expect(matchesShortcutBinding(ctrlShiftJ, "CmdOrCtrl+Shift+j", WIN)).toBe(true);
    // Missing modifiers also do not match
    const plainJ = keyEvent({ key: "j", code: "KeyJ" });
    expect(matchesShortcutBinding(plainJ, "CmdOrCtrl+j", WIN)).toBe(false);
  });

  it("三修饰键组合（CmdOrCtrl+Alt+Shift）精确匹配", () => {
    const event = keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true, shiftKey: true });
    expect(matchesShortcutBinding(event, "CmdOrCtrl+Alt+Shift+b", WIN)).toBe(true);
    expect(matchesShortcutBinding(event, "CmdOrCtrl+Alt+b", WIN)).toBe(false);
    expect(matchesShortcutBinding(event, "CmdOrCtrl+Shift+b", WIN)).toBe(false);
  });

  it("macOS 显式 Ctrl 修饰独立于 CmdOrCtrl", () => {
    const macCtrlP = keyEvent({ key: "p", code: "KeyP", ctrlKey: true });
    expect(matchesShortcutBinding(macCtrlP, "Ctrl+p", MAC)).toBe(true);
    expect(matchesShortcutBinding(macCtrlP, "CmdOrCtrl+p", MAC)).toBe(false);
    // On Windows/Linux Ctrl is synonymous with CmdOrCtrl (recording only produces CmdOrCtrl on those platforms)
    expect(matchesShortcutBinding(macCtrlP, "CmdOrCtrl+p", WIN)).toBe(true);
  });

  it("Shift+字母：event.key 为大写时命中小写基键绑定", () => {
    const shiftP = keyEvent({ key: "P", code: "KeyP", metaKey: true, shiftKey: true });
    expect(matchesShortcutBinding(shiftP, "CmdOrCtrl+Shift+p", MAC)).toBe(true);
    const winShiftBracket = keyEvent({
      key: "{",
      code: "BracketLeft",
      ctrlKey: true,
      shiftKey: true,
    });
    // Shift+[ has event.key "{" on the US layout; the code field provides the fallback match
    expect(matchesShortcutBinding(winShiftBracket, "CmdOrCtrl+Shift+[", WIN)).toBe(true);
  });

  it("macOS Option 参与时 key 被布局改写，event.code 兜底命中", () => {
    const optionCmdB = keyEvent({ key: "ß", code: "KeyB", metaKey: true, altKey: true });
    expect(matchesShortcutBinding(optionCmdB, "CmdOrCtrl+Alt+b", MAC)).toBe(true);
  });

  it("符号键匹配：= - 0 与方括号（zoom 与会话导航命令）", () => {
    const ctrlEqual = keyEvent({ key: "=", code: "Equal", ctrlKey: true });
    expect(matchesShortcutBinding(ctrlEqual, "CmdOrCtrl+=", WIN)).toBe(true);
    const ctrlMinus = keyEvent({ key: "-", code: "Minus", ctrlKey: true });
    expect(matchesShortcutBinding(ctrlMinus, "CmdOrCtrl+-", WIN)).toBe(true);
    const ctrlBracket = keyEvent({ key: "[", code: "BracketLeft", metaKey: true });
    expect(matchesShortcutBinding(ctrlBracket, "CmdOrCtrl+[", MAC)).toBe(true);
  });

  it("AltGr 与 Ctrl+Alt 是同一物理组合，两种写法都命中", () => {
    const altGrQ = keyEvent({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true });
    expect(matchesShortcutBinding(altGrQ, "AltGr+q", WIN)).toBe(true);
    expect(matchesShortcutBinding(altGrQ, "CmdOrCtrl+Alt+q", WIN)).toBe(true);
    // Windows' existing binding Ctrl+Alt+B (toggleSidePane default) is physically ctrl+alt pressed together and must match
    const ctrlAltB = keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(matchesShortcutBinding(ctrlAltB, "CmdOrCtrl+Alt+b", WIN)).toBe(true);
  });

  it("非法绑定串永不命中", () => {
    const ctrlK = keyEvent({ key: "k", code: "KeyK", ctrlKey: true });
    expect(matchesShortcutBinding(ctrlK, "not-a-binding", WIN)).toBe(false);
    expect(matchesShortcutBinding(ctrlK, "CmdOrCtrl+", WIN)).toBe(false);
  });
});

describe("快捷键录制器", () => {
  it("mac 的 Cmd → CmdOrCtrl；win/linux 的 Ctrl → CmdOrCtrl（跨平台配置可移植）", () => {
    const macCmdP = keyEvent({ key: "p", code: "KeyP", metaKey: true });
    expect(recordShortcutBinding(macCmdP, MAC)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+p",
    });
    const winCtrlP = keyEvent({ key: "p", code: "KeyP", ctrlKey: true });
    expect(recordShortcutBinding(winCtrlP, WIN)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+p",
    });
    const linuxCtrlShiftP = keyEvent({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
    expect(recordShortcutBinding(linuxCtrlShiftP, LINUX)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+Shift+p",
    });
  });

  it("mac 显式 Ctrl 录为 Ctrl+p", () => {
    const macCtrlP = keyEvent({ key: "p", code: "KeyP", ctrlKey: true });
    expect(recordShortcutBinding(macCtrlP, MAC)).toEqual({ kind: "binding", binding: "Ctrl+p" });
  });

  it("Shift+符号用 event.code 反查物理基键（Shift+7 → 7 而非 &）", () => {
    const shift7 = keyEvent({ key: "&", code: "Digit7", ctrlKey: true, shiftKey: true });
    expect(recordShortcutBinding(shift7, WIN)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+Shift+7",
    });
  });

  it("纯 Shift 组合（无其他修饰键）可正常录制", () => {
    const shiftF = keyEvent({ key: "F", code: "KeyF", shiftKey: true });
    expect(recordShortcutBinding(shiftF, WIN)).toEqual({ kind: "binding", binding: "Shift+f" });
    const shift7 = keyEvent({ key: "&", code: "Digit7", shiftKey: true });
    expect(recordShortcutBinding(shift7, WIN)).toEqual({ kind: "binding", binding: "Shift+7" });
    const macShiftF = keyEvent({ key: "F", code: "KeyF", shiftKey: true });
    expect(recordShortcutBinding(macShiftF, MAC)).toEqual({ kind: "binding", binding: "Shift+f" });
    // The matching side hits as well (user scenario: after recording, pressing Shift+F in the main UI triggers the command)
    expect(matchesShortcutBinding(shiftF, "Shift+f", WIN)).toBe(true);
  });

  it("IME 组合事件在录制态用 event.code 反查物理键（中文输入法下 Shift+字母 可录）", () => {
    // When focus is in an editable element, a Chinese IME swallows Shift+letter into composition input,
    // leaving only the isComposing/Process/229 markers — recording is explicit intent, so record by code
    const imeShiftF = keyEvent({ key: "Process", code: "KeyF", shiftKey: true, keyCode: 229 });
    expect(recordShortcutBinding(imeShiftF, WIN)).toEqual({ kind: "binding", binding: "Shift+f" });
    const composingCtrlJ = keyEvent({ key: "j", code: "KeyJ", ctrlKey: true, isComposing: true });
    expect(recordShortcutBinding(composingCtrlJ, WIN)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+j",
    });
    // IME events with no code to look up stay pending (keep waiting for the full combo)
    expect(recordShortcutBinding(keyEvent({ key: "Process" }), WIN)).toEqual({ kind: "pending" });
    // A held repeat does not record even when a code is present
    const repeated = keyEvent({
      key: "Process",
      code: "KeyF",
      shiftKey: true,
      repeat: true,
    });
    expect(recordShortcutBinding(repeated, WIN)).toEqual({ kind: "pending" });
    // The matching side still filters IME events as usual (recording is lenient, matching is strict)
    expect(matchesShortcutBinding(imeShiftF, "Shift+f", WIN)).toBe(false);
  });

  it("纯修饰键按下与 IME 噪声保持 pending（继续等待完整组合）", () => {
    expect(recordShortcutBinding(keyEvent({ key: "Shift", shiftKey: true }), WIN)).toEqual({
      kind: "pending",
    });
    expect(recordShortcutBinding(keyEvent({ key: "Meta", metaKey: true }), MAC)).toEqual({
      kind: "pending",
    });
    expect(recordShortcutBinding(keyEvent({ key: "Process" }), WIN)).toEqual({ kind: "pending" });
  });

  it("平台归一会丢主修饰键的组合拒绝录制（CR-01：不得产出裸单键）", () => {
    // mac's Cmd+Ctrl+K: after normalization both cmdOrCtrl and ctrl are false; the old implementation would record a bare "k"
    const macCmdCtrlK = keyEvent({ key: "k", code: "KeyK", metaKey: true, ctrlKey: true });
    expect(recordShortcutBinding(macCmdCtrlK, MAC)).toEqual({
      kind: "invalid",
      reason: "unsupported-key",
    });
    // win/linux's pure Meta (Win key) +K: also lost in normalization
    const winMetaK = keyEvent({ key: "k", code: "KeyK", metaKey: true });
    expect(recordShortcutBinding(winMetaK, WIN)).toEqual({
      kind: "invalid",
      reason: "unsupported-key",
    });
    // meta+ctrl+shift stacking must not slip past the guard either
    const macCmdCtrlShiftK = keyEvent({
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: true,
      shiftKey: true,
    });
    expect(recordShortcutBinding(macCmdCtrlShiftK, MAC)).toEqual({
      kind: "invalid",
      reason: "unsupported-key",
    });
    // mac pure Cmd / pure Ctrl and win AltGr (Ctrl+Alt) are unaffected
    expect(recordShortcutBinding(keyEvent({ key: "k", code: "KeyK", metaKey: true }), MAC)).toEqual(
      { kind: "binding", binding: "CmdOrCtrl+k" },
    );
    expect(recordShortcutBinding(keyEvent({ key: "k", code: "KeyK", ctrlKey: true }), MAC)).toEqual(
      { kind: "binding", binding: "Ctrl+k" },
    );
    expect(
      recordShortcutBinding(keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }), WIN),
    ).toEqual({ kind: "binding", binding: "CmdOrCtrl+Alt+b" });
  });

  it("纯 Shift+可打印键绑定可判定（CR-02：可编辑目标内需豁免）", () => {
    expect(isShiftOnlyPrintableBinding("Shift+f")).toBe(true);
    expect(isShiftOnlyPrintableBinding("Shift+7")).toBe(true);
    expect(isShiftOnlyPrintableBinding("CmdOrCtrl+Shift+f")).toBe(false);
    expect(isShiftOnlyPrintableBinding("Shift+F1")).toBe(false);
    expect(isShiftOnlyPrintableBinding("CmdOrCtrl+f")).toBe(false);
    // In a DOM-less environment (node unit tests) the editable-target check is always false
    expect(isEditableShortcutEventTarget(null)).toBe(false);
  });

  it("无修饰键的普通键拒绝（no-modifier）；F 键与方向键单键允许录出", () => {
    expect(recordShortcutBinding(keyEvent({ key: "p", code: "KeyP" }), WIN)).toEqual({
      kind: "invalid",
      reason: "no-modifier",
    });
    expect(recordShortcutBinding(keyEvent({ key: "F5", code: "F5" }), WIN)).toEqual({
      kind: "binding",
      binding: "F5",
    });
    expect(recordShortcutBinding(keyEvent({ key: "ArrowUp", code: "ArrowUp" }), WIN)).toEqual({
      kind: "binding",
      binding: "ArrowUp",
    });
  });

  it("录制产物必然是合法规范形式（可直接入 setting.json 与菜单 accelerator）", () => {
    const cases = [
      // Note: the win-platform meta+alt combo is rejected by the CR-01 guard (platform normalization loses the
      // primary modifier); the canonical cmdOrCtrl+alt combo is used here instead
      keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }),
      keyEvent({ key: "[", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
      keyEvent({ key: "=", code: "Equal", ctrlKey: true }),
    ];
    for (const event of cases) {
      const result = recordShortcutBinding(event, WIN);
      expect(result.kind).toBe("binding");
      if (result.kind === "binding") {
        expect(isValidShortcutBinding(result.binding)).toBe(true);
      }
    }
  });
});

describe("快捷键生效表 resolve", () => {
  it("无覆盖时返回命令表默认绑定", () => {
    const effective = resolveEffectiveShortcutBindings();
    expect(effective.toggleSidebar).toEqual(["CmdOrCtrl+b"]);
    expect(effective.openCommandCenter).toEqual(["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"]);
  });

  it("覆盖为整组替换（双默认绑定同时失效）", () => {
    const effective = resolveEffectiveShortcutBindings({ openCommandCenter: ["CmdOrCtrl+e"] });
    expect(effective.openCommandCenter).toEqual(["CmdOrCtrl+e"]);
  });

  it("非法覆盖条目忽略；全非法时回退默认；未知命令 ID 忽略", () => {
    const effective = resolveEffectiveShortcutBindings({
      toggleSidebar: ["CmdOrCtrl+g", "not-legal!!"],
      newTask: ["garbage"],
      unknownCommand: ["CmdOrCtrl+q"],
    });
    expect(effective.toggleSidebar).toEqual(["CmdOrCtrl+g"]);
    expect(effective.newTask).toEqual(["CmdOrCtrl+n"]);
    expect("unknownCommand" in effective).toBe(false);
  });

  it("显式空数组 = 未设置（不回退默认）——抢绑会把被抢命令清到这个状态", () => {
    const effective = resolveEffectiveShortcutBindings({ toggleSidebar: [] });
    expect(effective.toggleSidebar).toEqual([]);
  });
});

describe("快捷键冲突检测（拒绝 + 标红）", () => {
  it("保留键（编辑类 / 刷新 / F 键 / 方向键）拒绝为 reserved", () => {
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+c")).toEqual({
      kind: "reserved",
      binding: "CmdOrCtrl+c",
    });
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+r")).toMatchObject({
      kind: "reserved",
    });
    expect(checkShortcutBindingConflict("toggleSidebar", "F5")).toMatchObject({ kind: "reserved" });
    expect(checkShortcutBindingConflict("toggleSidebar", "ArrowUp")).toMatchObject({
      kind: "reserved",
    });
  });

  it("工具条三键已转正为可配置命令（spec §12.6），不再占用保留黑名单", () => {
    // CR-06's final solution upgraded from "blacklisting" to "promoting into the command table":
    // openModelMenu / cycleSessionMode / cycleThoughtLevel are window-channel commands that users can rebind or
    // clear, so the conflict system takes over naturally.
    expect(RESERVED_BINDINGS.has("CmdOrCtrl+m")).toBe(false);
    expect(RESERVED_BINDINGS.has("CmdOrCtrl+Shift+m")).toBe(false);
    expect(RESERVED_BINDINGS.has("CmdOrCtrl+t")).toBe(false);
    // But the default binding (explicit Ctrl) should still be treated as occupied by conflict detection — preventing other commands from binding the same key
    expect(checkShortcutBindingConflict("toggleSidebar", "Ctrl+m")).toEqual({
      kind: "occupied",
      ownerCommandId: "openModelMenu",
      binding: "Ctrl+m",
    });
  });

  it("冲突检测物理等价归一（新 CR-01）：录制产物与显式 Ctrl 默认绑定互检", () => {
    // Scenario A (the win/linux silent-shadowing path): on win the recorder platform-normalizes ⌃M into
    // "CmdOrCtrl+m", a string unequal to but physically equivalent to openModelMenu's default "Ctrl+m" —
    // it must report occupied rather than silently save
    expect(
      checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+m", undefined, {
        platformInfo: WIN,
      }),
    ).toEqual({
      kind: "occupied",
      ownerCommandId: "openModelMenu",
      binding: "CmdOrCtrl+m",
    });
    // Reverse: the explicit Ctrl string is detected too (identical to openModelMenu's default binding string; hits under both platform semantics)
    expect(checkShortcutBindingConflict("toggleSidebar", "Ctrl+m")).toEqual({
      kind: "occupied",
      ownerCommandId: "openModelMenu",
      binding: "Ctrl+m",
    });
    // AltGr ≡ Ctrl+Alt (win): toggleSidePane's default CmdOrCtrl+Alt+b is occupied by an equivalent variant too
    expect(
      checkShortcutBindingConflict("findInTask", "Ctrl+Alt+b", undefined, { platformInfo: WIN }),
    ).toEqual({
      kind: "occupied",
      ownerCommandId: "toggleSidePane",
      binding: "Ctrl+Alt+b",
    });
  });

  it("macOS ⌘M 为系统菜单 minimize 固定 accelerator，不可被任何命令占用（新 CR-01 场景 B）", () => {
    expect(
      checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+m", undefined, {
        platformInfo: MAC,
      }),
    ).toEqual({ kind: "reserved", binding: "CmdOrCtrl+m" });
    // minimize is a system-level behavior: a composer-scope command bound to ⌘M is equally hard-bound and intercepted as well
    expect(
      checkShortcutBindingConflict("composerSend", "CmdOrCtrl+m", undefined, {
        platformInfo: MAC,
      }),
    ).toEqual({ kind: "reserved", binding: "CmdOrCtrl+m" });
    // mac's explicit Ctrl+m is a different physical key and is unaffected by the minimize defense line (openModelMenu's own default can stay)
    expect(
      checkShortcutBindingConflict("openModelMenu", "Ctrl+m", undefined, { platformInfo: MAC }),
    ).toBeNull();
  });

  it("抢绑清除物理等价条目（新 CR-01）：CmdOrCtrl+m 抢绑后 openModelMenu 默认 Ctrl+m 一并清空", () => {
    // Physical equivalence (CmdOrCtrl ≡ explicit Ctrl) holds only on win/linux, so the platform must be
    // pinned explicitly: with node ≥21.2, navigator.platform on macOS is "MacIntel", and a missing
    // platformInfo would run this case under apple semantics on a mac dev machine (⌘M ≠ ⌃M → no clearing) and
    // fail there while passing on Linux CI.
    // The mac side of ⌘M is covered by the reserved defense line in the previous case; this case only handles
    // win/linux steal-clearing.
    const next = buildShortcutOverridesAfterSteal(undefined, "toggleSidebar", "CmdOrCtrl+m", {
      platformInfo: WIN,
    });
    expect(next.toggleSidebar).toEqual(["CmdOrCtrl+m"]);
    // openModelMenu's default "Ctrl+m" is physically equivalent to CmdOrCtrl+m on win/linux and is cleared to unset after the steal
    expect(next.openModelMenu).toEqual([]);
  });

  it("Web 端 menu 通道命令默认键按保留处理，不提供抢绑（CR-04）", () => {
    // Desktop: a menu-command occupation is occupied and can go through the confirm-then-steal flow
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+n")).toEqual({
      kind: "occupied",
      ownerCommandId: "newTask",
      binding: "CmdOrCtrl+n",
    });
    // Web: a menu-channel command's default key is fixedly consumed by the root-level fallback listener and is rejected as reserved (no steal entry point)
    expect(
      checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+n", undefined, {
        menuChannelReserved: true,
      }),
    ).toEqual({ kind: "reserved", binding: "CmdOrCtrl+n" });
    // A window-channel command's occupation is still occupied on the Web (stealable)
    expect(
      checkShortcutBindingConflict("findInTask", "CmdOrCtrl+b", undefined, {
        menuChannelReserved: true,
      }),
    ).toEqual({
      kind: "occupied",
      ownerCommandId: "toggleSidebar",
      binding: "CmdOrCtrl+b",
    });
  });

  it("已被其他命令占用（含默认绑定）拒绝为 occupied 并给出占用者", () => {
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+n")).toEqual({
      kind: "occupied",
      ownerCommandId: "newTask",
      binding: "CmdOrCtrl+n",
    });
    // When the owner has dual default bindings, either binding counts as occupied
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+Shift+p")).toEqual({
      kind: "occupied",
      ownerCommandId: "openCommandCenter",
      binding: "CmdOrCtrl+Shift+p",
    });
  });

  it("命令自身当前绑定不构成冲突（整组替换语义）", () => {
    expect(checkShortcutBindingConflict("newTask", "CmdOrCtrl+n")).toBeNull();
    expect(checkShortcutBindingConflict("openCommandCenter", "CmdOrCtrl+k")).toBeNull();
  });

  it("命令表默认绑定不得与保留键清单相交（仅 global 作用域，spec §12.2）", () => {
    for (const entry of SHORTCUT_COMMANDS) {
      if (entry.scope === "composer") {
        continue;
      }
      for (const binding of entry.defaultBindings) {
        expect(RESERVED_BINDINGS.has(binding)).toBe(false);
      }
    }
  });

  it("Enter 入全局黑名单但 composer 作用域不受限（spec §12.2）", () => {
    expect(RESERVED_BINDINGS.has("Enter")).toBe(true);
    // A global command rebinding Enter → reserved; a composer command rebinding Enter → unrestricted
    expect(checkShortcutBindingConflict("toggleSidebar", "Enter")).toMatchObject({
      kind: "reserved",
    });
    expect(checkShortcutBindingConflict("composerSend", "Enter")).toBeNull();
    expect(checkShortcutBindingConflict("composerSend", "CmdOrCtrl+Enter")).toBeNull();
  });

  it("冲突检测作用域隔离：composer 与 global 同键互不冲突（spec §12.2）", () => {
    // CmdOrCtrl+k is openCommandCenter's (global) default binding; a composer command binding it is not a conflict
    expect(checkShortcutBindingConflict("composerSend", "CmdOrCtrl+k")).toBeNull();
    // The reverse is isolated too: a global command binding composerSend's default Enter is not occupied but reserved
    expect(checkShortcutBindingConflict("toggleSidebar", "Shift+Enter")).toBeNull();
    // Within the composer scope conflicts are still detected: composerInsertNewline binding composerSend's default key → occupied
    expect(checkShortcutBindingConflict("composerInsertNewline", "Enter")).toEqual({
      kind: "occupied",
      ownerCommandId: "composerSend",
      binding: "Enter",
    });
  });
});

describe("按键搜索的物理等价比较 isSamePhysicalBinding", () => {
  it("win/linux：CmdOrCtrl ≡ 显式 Ctrl，AltGr 叠加 Alt 位（与冲突检测同口径）", () => {
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+m", { platformInfo: WIN })).toBe(true);
    expect(isSamePhysicalBinding("Ctrl+Alt+b", "AltGr+b", { platformInfo: WIN })).toBe(true);
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "CmdOrCtrl+Shift+m", { platformInfo: WIN })).toBe(
      false,
    );
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+t", { platformInfo: LINUX })).toBe(false);
  });

  it("apple：主修饰（⌘）与 Ctrl 是独立物理键，等价关系随平台翻转", () => {
    // The same pair of strings is equivalent on win and not on mac (⌘M ≠ ⌃M) — the search criterion matches the conflict criterion
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+m", { platformInfo: MAC })).toBe(false);
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+m", { platformInfo: WIN })).toBe(true);
  });

  it("裸命名键（composer 作用域默认）与解析失败串", () => {
    expect(isSamePhysicalBinding("Enter", "Enter")).toBe(true);
    expect(isSamePhysicalBinding("Enter", "Shift+Enter")).toBe(false);
    // An illegal string fails to parse → always unequal (null short-circuit semantics, consistent with conflict detection)
    expect(isSamePhysicalBinding("not-a-binding", "Enter")).toBe(false);
  });
});

describe("拆行多绑定构建器（spec §8：一个命令多组键，行级操作）", () => {
  // openCommandCenter's default dual bindings: CmdOrCtrl+k / CmdOrCtrl+Shift+p
  it("追加：默认键 + 已有覆盖全部保留，新键排尾", () => {
    const next = buildShortcutOverridesAfterAppend(undefined, "openCommandCenter", "CmdOrCtrl+g");
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+k", "CmdOrCtrl+Shift+p", "CmdOrCtrl+g"]);
    // Appending to an overridden command is based on the effective list (override = whole-group replacement semantics)
    const replaced = buildShortcutOverridesAfterAppend(
      { openCommandCenter: ["Ctrl+y"] },
      "openCommandCenter",
      "CmdOrCtrl+g",
    );
    expect(replaced.openCommandCenter).toEqual(["Ctrl+y", "CmdOrCtrl+g"]);
    // Appending to unassigned (explicit []) = the first entry
    const fromEmpty = buildShortcutOverridesAfterAppend(
      { toggleSidebar: [] },
      "toggleSidebar",
      "CmdOrCtrl+b",
    );
    expect(fromEmpty.toggleSidebar).toEqual(["CmdOrCtrl+b"]);
  });

  it("删除：移除指定条，删空落显式 []（未分配），不影响其他命令", () => {
    const next = buildShortcutOverridesWithoutBindingAt(undefined, "openCommandCenter", 0);
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    const last = buildShortcutOverridesWithoutBindingAt(
      { openCommandCenter: ["CmdOrCtrl+k"], toggleSidebar: ["CmdOrCtrl+b"] },
      "openCommandCenter",
      0,
    );
    // Deleting down to empty = unassigned (no fallback to defaults); other commands' entries are preserved as-is
    expect(last.openCommandCenter).toEqual([]);
    expect(last.toggleSidebar).toEqual(["CmdOrCtrl+b"]);
  });

  it("替换：指定位置换新键，其余条目（含默认键）保留", () => {
    const next = buildShortcutOverridesWithBindingAt(
      undefined,
      "openCommandCenter",
      1,
      "CmdOrCtrl+g",
    );
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+k", "CmdOrCtrl+g"]);
    // Replacing entry 0 with no overrides also preserves the remaining default keys
    const first = buildShortcutOverridesWithBindingAt(undefined, "openCommandCenter", 0, "Ctrl+y");
    expect(first.openCommandCenter).toEqual(["Ctrl+y", "CmdOrCtrl+Shift+p"]);
  });
});

describe("快捷键二次确认抢绑", () => {
  it("抢绑后目标命令绑新键，被抢命令默认绑定被清空为「未设置」", () => {
    // findInTask steals toggleSidebar's default CmdOrCtrl+b
    const next = buildShortcutOverridesAfterSteal(undefined, "findInTask", "CmdOrCtrl+b");
    expect(next.findInTask).toEqual(["CmdOrCtrl+b"]);
    expect(next.toggleSidebar).toEqual([]);
    const effective = resolveEffectiveShortcutBindings(next);
    expect(effective.findInTask).toEqual(["CmdOrCtrl+b"]);
    expect(effective.toggleSidebar).toEqual([]);
  });

  it("被抢命令是多默认绑定时只移除被抢的那条，其余保留", () => {
    // Steals openCommandCenter's first default CmdOrCtrl+k
    const next = buildShortcutOverridesAfterSteal(undefined, "toggleTerminal", "CmdOrCtrl+k");
    expect(next.toggleTerminal).toEqual(["CmdOrCtrl+k"]);
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
  });

  it("抢绑在既有覆盖之上叠加，不丢失无关命令的覆盖", () => {
    const next = buildShortcutOverridesAfterSteal(
      { toggleSidebar: ["CmdOrCtrl+g"] },
      "findInTask",
      "CmdOrCtrl+j", // toggleTerminal default
    );
    expect(next.toggleSidebar).toEqual(["CmdOrCtrl+g"]); // Unrelated override preserved
    expect(next.findInTask).toEqual(["CmdOrCtrl+j"]);
    expect(next.toggleTerminal).toEqual([]); // Cleared by the steal
  });

  it("多绑定命令行级抢绑：replace 只换目标条，其余绑定保留（CR-01）", () => {
    // replace entry 0: CmdOrCtrl+Shift+p must be preserved and not swallowed by a whole-group replacement
    const replaceFirst = buildShortcutOverridesAfterSteal(
      undefined,
      "toggleTerminal",
      "CmdOrCtrl+k",
      { mode: "replace", bindingIndex: 0 },
    );
    expect(replaceFirst.toggleTerminal).toEqual(["CmdOrCtrl+k"]);
    expect(replaceFirst.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    // replace entry 1: openCommandCenter's existing CmdOrCtrl+k is removed as the conflicting key, leaving the second entry
    const replaceSecond = buildShortcutOverridesAfterSteal(
      undefined,
      "toggleTerminal",
      "CmdOrCtrl+k",
      { mode: "replace", bindingIndex: 1 },
    );
    expect(replaceSecond.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
  });

  it("多绑定命令行级抢绑：未分配录第一条（append）与缺省旧行为", () => {
    // bindingIndex null (unassigned placeholder recording) → append semantics; toggleTerminal's default CmdOrCtrl+j is preserved
    const appendSteal = buildShortcutOverridesAfterSteal(
      undefined,
      "toggleTerminal",
      "CmdOrCtrl+k",
      { mode: "replace", bindingIndex: null },
    );
    expect(appendSteal.toggleTerminal).toEqual(["CmdOrCtrl+j", "CmdOrCtrl+k"]);
    expect(appendSteal.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    // add mode → appended to the end of the existing list
    const addSteal = buildShortcutOverridesAfterSteal(undefined, "toggleTerminal", "CmdOrCtrl+k", {
      mode: "add",
      bindingIndex: null,
    });
    expect(addSteal.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    // Omitted (mode not passed) keeps the old whole-group replacement behavior; existing callers are unaffected
    const legacy = buildShortcutOverridesAfterSteal(undefined, "toggleTerminal", "CmdOrCtrl+k");
    expect(legacy.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
  });
});

describe("快捷键录制态抑制", () => {
  it("setShortcutRecordingActive 开关可读", () => {
    expect(isShortcutRecordingActive()).toBe(false);
    setShortcutRecordingActive(true);
    expect(isShortcutRecordingActive()).toBe(true);
    setShortcutRecordingActive(false);
    expect(isShortcutRecordingActive()).toBe(false);
  });
});

describe("快捷键展示 label", () => {
  it("macOS 符号风格，修饰键按 ⌃⌥⇧⌘ 顺序", () => {
    expect(formatShortcutBindingLabel("CmdOrCtrl+k", MAC)).toBe("⌘ K");
    expect(formatShortcutBindingLabel("CmdOrCtrl+Shift+p", MAC)).toBe("⇧ ⌘ P");
    expect(formatShortcutBindingLabel("CmdOrCtrl+Alt+b", MAC)).toBe("⌥ ⌘ B");
    expect(formatShortcutBindingLabel("Ctrl+p", MAC)).toBe("⌃ P");
  });

  it("Windows/Linux 文字风格", () => {
    expect(formatShortcutBindingLabel("CmdOrCtrl+k", WIN)).toBe("Ctrl+K");
    expect(formatShortcutBindingLabel("CmdOrCtrl+Alt+Shift+b", LINUX)).toBe("Ctrl+Alt+Shift+B");
    expect(formatShortcutBindingLabel("Ctrl+p", WIN)).toBe("Ctrl+P");
  });

  it("zoom 语义：= 显示为 +，- 保持", () => {
    expect(formatShortcutBindingLabel("CmdOrCtrl+=", WIN)).toBe("Ctrl++");
    expect(formatShortcutBindingLabel("CmdOrCtrl+-", WIN)).toBe("Ctrl+-");
  });

  it("逐键 token：与 label 同序同义，键帽逐个渲染（spec §8）", () => {
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+Shift+p", MAC)).toEqual(["⇧", "⌘", "P"]);
    expect(formatShortcutBindingLabelParts("Ctrl+Alt+Shift+b", LINUX)).toEqual([
      "Ctrl",
      "Alt",
      "Shift",
      "B",
    ]);
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+Enter", MAC)).toEqual(["⌘", "Enter"]);
    // Re-joined tokens match the label string: a single source of truth for the two display paths
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+k", MAC).join(" ")).toBe(
      formatShortcutBindingLabel("CmdOrCtrl+k", MAC),
    );
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+k", WIN).join("+")).toBe(
      formatShortcutBindingLabel("CmdOrCtrl+k", WIN),
    );
    // An illegal string is returned as a single token as-is
    expect(formatShortcutBindingLabelParts("not-a-binding", WIN)).toEqual(["not-a-binding"]);
  });
});
