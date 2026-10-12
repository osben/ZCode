import { describe, expect, it } from "vitest";
import type { ShortcutBindingEvent } from "../src/shortcuts/bindings.js";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
  type ComposerEffectiveBindings,
} from "../src/shortcuts/composerShortcuts.js";
import { getDefaultShortcutBindings } from "@zcode/shared";

/** Builds an Enter-family keyboard event (what the composer plugin receives is the subset of a
 * real KeyboardEvent's fields). */
function enterEvent(patch: Partial<ShortcutBindingEvent> = {}): ShortcutBindingEvent {
  return {
    key: "Enter",
    code: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    ...patch,
  };
}

/** Default effective bindings (no user overrides): composerSend=Enter, composerInsertNewline=Shift+Enter. */
function defaultEffective(): ComposerEffectiveBindings {
  return {
    composerSend: getDefaultShortcutBindings("composerSend"),
    composerInsertNewline: getDefaultShortcutBindings("composerInsertNewline"),
  };
}

/** The Ctrl+Enter camp: rebind send to CmdOrCtrl+Enter (whole-group replacement; bare Enter
 * removed). */
function ctrlEnterEffective(): ComposerEffectiveBindings {
  return { ...defaultEffective(), composerSend: ["CmdOrCtrl+Enter"] };
}

/**
 * Three-platform platformInfo. Every case that asserts across the CmdOrCtrl ↔ explicit Ctrl/meta
 * equivalence boundary must pass these explicitly: by default isAppleKeyboardPlatform() reads the
 * runtime navigator, and node ≥21.2 reports navigator.platform = "MacIntel" on macOS, so a case
 * would run with apple semantics on a mac dev machine and win semantics on Linux CI — the
 * conclusion flips with the host machine.
 */
const MAC = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" };
const WIN = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" };
const LINUX = { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" };

describe("composer 作用域键位解析（spec §12.3）", () => {
  it("默认表：裸 Enter 发送、Shift+Enter 换行", () => {
    expect(resolveComposerKeyAction(enterEvent(), defaultEffective())).toBe("send");
    expect(resolveComposerKeyAction(enterEvent({ shiftKey: true }), defaultEffective())).toBe(
      "newline",
    );
  });

  it("改绑后：CmdOrCtrl+Enter 发送、裸 Enter 未命中交主链回退换行（Ctrl+Enter 党场景）", () => {
    const effective = ctrlEnterEffective();
    // CmdOrCtrl normalization is platform-dependent; pin win explicitly (the mac ⌘/⌃ branches are
    // in the three-platform matrix below)
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, WIN)).toBe("send");
    // Bare Enter no longer hits send → the resolver returns null to the main chain; the main
    // chain's bare-Enter send branch uses the shouldBareEnterFallThroughToNewline pre-check to
    // fall through to newline (spec §12.3)
    expect(resolveComposerKeyAction(enterEvent(), effective, WIN)).toBeNull();
    expect(shouldBareEnterFallThroughToNewline(effective)).toBe(true);
  });

  it("Shift+Enter 党零改动：默认表下裸 Enter 仍发送", () => {
    expect(shouldBareEnterFallThroughToNewline(defaultEffective())).toBe(false);
  });

  it("非 Enter 事件默认表不命中（开放策略下改绑非 Enter 键才会命中，SG-09）", () => {
    // Default bindings are all Enter-family: non-Enter keys do not hit → the main chain handles
    // them as usual
    expect(
      resolveComposerKeyAction(enterEvent({ key: "k", code: "KeyK" }), defaultEffective()),
    ).toBe(null);
    // Unified open policy (SG-09): after composerSend is rebound to a non-Enter key (e.g. F9), it
    // still triggers
    const f9Effective: ComposerEffectiveBindings = {
      ...defaultEffective(),
      composerSend: ["F9"],
    };
    expect(
      resolveComposerKeyAction(enterEvent({ key: "F9", code: "F9", ctrlKey: false }), f9Effective),
    ).toBe("send");
    // Unbound non-Enter keys still do not hit
    expect(
      resolveComposerKeyAction(enterEvent({ key: "F9", code: "F9" }), defaultEffective()),
    ).toBe(null);
    // Newline is equally open: after composerInsertNewline is rebound to F2, F2 triggers newline
    const f2Newline: ComposerEffectiveBindings = {
      ...defaultEffective(),
      composerInsertNewline: ["F2"],
    };
    expect(
      resolveComposerKeyAction(enterEvent({ key: "F2", code: "F2", shiftKey: false }), f2Newline),
    ).toBe("newline");
  });

  it("未绑定（显式空数组）时解析器全部未命中，主链前置检查落换行", () => {
    const effective: ComposerEffectiveBindings = {
      composerSend: [],
      composerInsertNewline: [],
    };
    expect(resolveComposerKeyAction(enterEvent(), effective)).toBeNull();
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective)).toBeNull();
    expect(resolveComposerKeyAction(enterEvent({ shiftKey: true }), effective)).toBeNull();
    expect(shouldBareEnterFallThroughToNewline(effective)).toBe(true);
  });

  it("默认状态下未命中的修饰组合返回 null（主链反转投递/换行语义不受影响）", () => {
    // Ctrl+Enter is not in any composer binding by default: an unmodified-combination miss must
    // not swallow onModifiedSubmit (reverse dispatch) or Lexical's default newline
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), defaultEffective())).toBeNull();
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), defaultEffective())).toBeNull();
  });

  // ============================================================================
  // Three-platform semantics matrix (spec §12: all platform differences converge in the kernel's
  // CmdOrCtrl normalization; the scope layer is platform-agnostic)
  // ============================================================================

  it("mac：默认表裸 Enter 发送、Shift+Enter 换行；Cmd+Enter 不命中（主链反转投递语义保留）", () => {
    expect(resolveComposerKeyAction(enterEvent(), defaultEffective(), MAC)).toBe("send");
    expect(resolveComposerKeyAction(enterEvent({ shiftKey: true }), defaultEffective(), MAC)).toBe(
      "newline",
    );
    // On mac, CmdOrCtrl normalizes to Cmd: Cmd+Enter is not in the default bindings (bare Enter
    // carries no modifier), so it must fall back to the main chain for reverse dispatch
    // (onModifiedSubmit accepts metaKey)
    expect(
      resolveComposerKeyAction(enterEvent({ metaKey: true }), defaultEffective(), MAC),
    ).toBeNull();
    // mac has no Win-key equivalent; Option (alt)+Enter likewise misses the default bindings
    expect(
      resolveComposerKeyAction(enterEvent({ altKey: true }), defaultEffective(), MAC),
    ).toBeNull();
  });

  it("mac：改绑 CmdOrCtrl+Enter 后 Cmd+Enter 发送，显式 Ctrl+Enter 不命中（保留系统编辑区语义）", () => {
    const effective = ctrlEnterEffective();
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), effective, MAC)).toBe("send");
    // Explicit Ctrl on mac is a separate modifier (reserved for system Emacs editing); if the
    // user did not bind it, it is not bound → main chain
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, MAC)).toBeNull();
    expect(shouldBareEnterFallThroughToNewline(effective)).toBe(true);
  });

  it("win/linux：Ctrl+Enter 命中 CmdOrCtrl 改绑；Win/Super+Enter 被裸键守卫挡住", () => {
    const effective = ctrlEnterEffective();
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, WIN)).toBe("send");
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, LINUX)).toBe("send");
    // Bare-key bindings require the primary modifier to be up: meta (Win/Super)+Enter hits no
    // binding
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), effective, WIN)).toBeNull();
    expect(
      resolveComposerKeyAction(enterEvent({ metaKey: true }), defaultEffective(), LINUX),
    ).toBeNull();
  });
});
