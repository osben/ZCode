import type { Terminal } from "@xterm/xterm";

/** Mobile 229 input is committed via native input events, avoiding the race with xterm's periodic textarea reads. */
export function attachTerminalMobileInput(term: Terminal, isWindowsDesktop: boolean) {
  const root = term.element;
  const textarea = term.textarea;
  const mobile =
    /Android|iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isWindowsDesktop || !mobile || !root || !textarea)
    return { handleKeyEvent: () => true, dispose() {} };

  let ownsInput = false;
  let composition: "idle" | "active" | "committing" = "idle";
  const reset = () => {
    ownsInput = false;
  };
  const handleKeyEvent = (event: KeyboardEvent) => {
    // Character-bearing keypresses are sent by xterm; hand ownership back so the following line-break input does not send Enter twice.
    if (event.type === "keypress" && (event.charCode || event.which)) reset();
    if (event.type !== "keydown") return true;
    ownsInput =
      event.keyCode === 229 &&
      !event.isComposing &&
      composition === "idle" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey;
    // Keep xterm's keyDownSeen so the native input after compositionend can deduplicate;
    // only block 229 from starting the timed read. The matching plain input is submitted
    // exclusively in the capture handlers below. Do not preventDefault, preserving the
    // browser's native textarea update.
    return !ownsInput;
  };
  const submit = (event: Event, text: string) => {
    ownsInput = false;
    event.stopPropagation();
    textarea.value = "";
    // Reuse onData's single write path so keep-alive remounts still use the current PTY connection.
    term.input(text, true);
  };
  const onInput = (event: Event) => {
    const input = event as InputEvent;
    if (event.target !== textarea || !ownsInput || composition !== "idle" || input.isComposing)
      return;
    if (input.inputType === "insertText" && input.data) submit(event, input.data);
    // Mobile Enter may arrive as only 229 + insertLineBreak; once we take over 229, Enter semantics must be completed here.
    else if (input.inputType === "insertLineBreak") submit(event, "\r");
    else if (input.inputType === "deleteContentBackward") submit(event, "\x7f");
    else if (input.inputType === "deleteContentForward") submit(event, "\x1b[3~");
    else reset();
  };
  const onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    if (event.target !== textarea || !ownsInput || composition !== "idle" || input.isComposing)
      return;
    // Submitted text never stays in the hidden textarea; a native delete on an empty textarea may
    // produce no input event, so consume deletes in beforeinput to avoid swallowing terminal backspace.
    if (input.inputType === "deleteContentBackward" || input.inputType === "deleteContentForward") {
      event.preventDefault();
      submit(event, input.inputType === "deleteContentBackward" ? "\x7f" : "\x1b[3~");
    }
  };
  const onCompositionStart = () => {
    composition = "active";
    reset();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    // xterm reads the textarea on the tick after compositionend. Until it emits onData, the original
    // composition path still owns the input, preventing an immediately following 229 character from
    // clearing not-yet-committed CJK text.
    composition = event.data ? "committing" : "idle";
  };
  const compositionCommit = term.onData((data) => {
    // PTY status queries are also answered via onData; an ESC control reply must not be treated as committed CJK text.
    if (composition === "committing" && getPlainTerminalInputText(data)) composition = "idle";
  });
  root.addEventListener("beforeinput", onBeforeInput, true);
  root.addEventListener("input", onInput, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("blur", reset);
  textarea.addEventListener("paste", reset);
  return {
    handleKeyEvent,
    dispose() {
      compositionCommit.dispose();
      root.removeEventListener("beforeinput", onBeforeInput, true);
      root.removeEventListener("input", onInput, true);
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      textarea.removeEventListener("blur", reset);
      textarea.removeEventListener("paste", reset);
    },
  };
}

export interface PendingTerminalInputFallback {
  handled: boolean;
  text: string;
}

export interface TerminalInputFallbackKeydownCandidate {
  kind: "text" | "imeCommit";
  text: string | null;
  eventTimeStamp: number;
  recordedAt: number;
}

export interface TerminalInputFallbackHandledData {
  consumed: boolean;
  data: string;
  keydownEventTimeStamp: number;
  kind: "text" | "imeCommit" | "recentData";
  recordedAt: number;
}

export function createPendingTerminalInputFallback(text: string): PendingTerminalInputFallback {
  return {
    handled: false,
    text,
  };
}

function isPlainTerminalInputData(data: string): boolean {
  // Control input such as arrow keys produces ESC sequences, e.g. "\x1b[D".
  // Printable characters inside these sequences must not participate in composed-input fallback matching, or real pending text may be mistaken for already handled.
  return Array.from(data).every((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && code >= 0x20 && code !== 0x7f;
  });
}

function getPlainTerminalInputText(data: string): string | null {
  if (data.includes("\u001b")) {
    return null;
  }

  let text = "";
  for (const char of Array.from(data)) {
    const code = char.codePointAt(0);
    if (code !== undefined && code >= 0x20 && code !== 0x7f) {
      text += char;
    }
  }

  return text.length > 0 ? text : null;
}

function getHandledFallbackData(params: {
  candidate: TerminalInputFallbackKeydownCandidate;
  data: string;
}): string | null {
  if (params.candidate.kind === "imeCommit") {
    // When third-party IMEs such as Sogou submit a candidate with Enter, xterm's onData may combine Chinese text and
    // the Enter control character in the same chunk (for example, "中文\r"). Treating the whole chunk as non-plain would make
    // the later textarea-input fallback write the Chinese text again; extract printable text only on the IME commit-key path.
    return getPlainTerminalInputText(params.data);
  }

  if (!isPlainTerminalInputData(params.data) || params.candidate.text !== params.data) {
    return null;
  }

  return params.data;
}

export function createTerminalInputFallbackKeydownCandidate(params: {
  eventTimeStamp: number;
  key: string;
  now: number;
}): TerminalInputFallbackKeydownCandidate | null {
  if (params.key === "Enter" || params.key === "Process") {
    // Third-party Chinese IMEs such as Sogou commonly use Enter/Process to commit candidates on Windows.
    // xterm may already have sent the Chinese text through onData, while textarea input then retains the same composed text;
    // keep the commit-key timestamp here so later plain onData can deduplicate with the same-frame input and avoid another fallback write.
    return {
      eventTimeStamp: params.eventTimeStamp,
      kind: "imeCommit",
      recordedAt: params.now,
      text: null,
    };
  }

  if (params.key.length !== 1 || !isPlainTerminalInputData(params.key)) {
    return null;
  }

  return {
    eventTimeStamp: params.eventTimeStamp,
    kind: "text",
    recordedAt: params.now,
    text: params.key,
  };
}

export function markTerminalInputFallbackHandled(
  pending: readonly PendingTerminalInputFallback[],
  data: string,
): void {
  const handledText = isPlainTerminalInputData(data) ? data : getPlainTerminalInputText(data);
  if (!handledText) {
    return;
  }

  let remainingData = handledText;
  for (const item of pending) {
    if (item.handled || item.text.length === 0) {
      continue;
    }
    const index = remainingData.indexOf(item.text);
    if (index === -1) {
      continue;
    }
    item.handled = true;
    remainingData = remainingData.slice(0, index) + remainingData.slice(index + item.text.length);
  }
}

export function recordTerminalInputFallbackHandledData(params: {
  candidate: TerminalInputFallbackKeydownCandidate | null;
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): {
  history: TerminalInputFallbackHandledData[];
  usedCandidate: boolean;
} {
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const candidate = params.candidate;
  if (!candidate || params.now - candidate.recordedAt > params.maxAgeMs) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  const data = getHandledFallbackData({ candidate, data: params.data });
  if (!data) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  return {
    history: [
      ...retainedHistory,
      {
        consumed: false,
        data,
        keydownEventTimeStamp: candidate.eventTimeStamp,
        kind: candidate.kind,
        recordedAt: params.now,
      },
    ],
    usedCandidate: true,
  };
}

export function recordTerminalInputFallbackRecentData(params: {
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): TerminalInputFallbackHandledData[] {
  // When Sogou commits a candidate, xterm may first write the Chinese text through onData and then dispatch
  // textarea composed input; this path has no stable keydown candidate, so deduplicate using a very short recentData window.
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const data = isPlainTerminalInputData(params.data)
    ? params.data
    : getPlainTerminalInputText(params.data);
  if (!data) {
    return retainedHistory;
  }

  return [
    ...retainedHistory,
    {
      consumed: false,
      data,
      keydownEventTimeStamp: params.now,
      kind: "recentData",
      recordedAt: params.now,
    },
  ];
}

export function consumeTerminalInputFallbackHandledData(params: {
  history: readonly TerminalInputFallbackHandledData[];
  inputEventTimeStamp: number;
  maxAgeMs: number;
  maxInputDelayMs: number;
  now: number;
  pending: PendingTerminalInputFallback;
}): void {
  const matched = params.history.find(
    (item) =>
      !item.consumed &&
      params.now - item.recordedAt <= params.maxAgeMs &&
      params.pending.text === item.data &&
      (item.kind === "recentData"
        ? params.now - item.recordedAt <= params.maxInputDelayMs
        : params.inputEventTimeStamp >= item.keydownEventTimeStamp &&
          params.inputEventTimeStamp - item.keydownEventTimeStamp <=
            (item.kind === "imeCommit" ? params.maxAgeMs : params.maxInputDelayMs)),
  );
  if (!matched) {
    return;
  }

  matched.consumed = true;
  params.pending.handled = true;
}

export function resolveTerminalInputFallbackAction(params: {
  pending: PendingTerminalInputFallback;
  textareaValue: string;
}): {
  shouldClearTextarea: boolean;
  shouldWrite: boolean;
} {
  const hasTextareaValue = params.textareaValue.length > 0;
  const shouldWrite = !params.pending.handled && hasTextareaValue;
  return {
    shouldClearTextarea: hasTextareaValue && (params.pending.handled || shouldWrite),
    shouldWrite,
  };
}
