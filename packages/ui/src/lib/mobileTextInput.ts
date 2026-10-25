import { useEffect, useState } from "react";

const MOBILE_TEXT_INPUT_QUERY = "(max-width: 767px) and (hover: none) and (pointer: coarse)";
const MOBILE_COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";

function getMediaQueryMatches(query: string): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches
  );
}

function subscribeMediaQuery(query: string, listener: (matches: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    listener(false);
    return () => {};
  }

  const mediaQueryList = window.matchMedia(query);
  const update = () => listener(mediaQueryList.matches);
  update();

  // Bugfix: some mobile WebViews / older Safari still only support addListener. Mirror the remote
  // control shell's compatibility approach so the mobile input does not crash at mount when the
  // listener API is missing.
  if (typeof mediaQueryList.addEventListener === "function") {
    mediaQueryList.addEventListener("change", update);
    return () => mediaQueryList.removeEventListener("change", update);
  }

  mediaQueryList.addListener(update);
  return () => mediaQueryList.removeListener(update);
}

function getIsMobileTextInputViewport(): boolean {
  return getMediaQueryMatches(MOBILE_TEXT_INPUT_QUERY);
}

function getIsMobileCompactViewport(): boolean {
  return getMediaQueryMatches(MOBILE_COMPACT_VIEWPORT_QUERY);
}

export function subscribeMobileTextInputViewport(listener: (matches: boolean) => void): () => void {
  return subscribeMediaQuery(MOBILE_TEXT_INPUT_QUERY, listener);
}

export function subscribeMobileCompactViewport(listener: (matches: boolean) => void): () => void {
  return subscribeMediaQuery(MOBILE_COMPACT_VIEWPORT_QUERY, listener);
}

export function useIsMobileTextInputViewport(): boolean {
  const [isMobileTextInputViewport, setIsMobileTextInputViewport] = useState(
    getIsMobileTextInputViewport,
  );

  useEffect(() => subscribeMobileTextInputViewport(setIsMobileTextInputViewport), []);

  return isMobileTextInputViewport;
}

export function useIsMobileCompactViewport(): boolean {
  const [isMobileCompactViewport, setIsMobileCompactViewport] = useState(
    getIsMobileCompactViewport,
  );

  useEffect(() => subscribeMobileCompactViewport(setIsMobileCompactViewport), []);

  return isMobileCompactViewport;
}

export function resolveChatEnterSubmits({
  isMobileTextInputViewport,
  preferEnterNewline,
}: {
  isMobileTextInputViewport: boolean;
  preferEnterNewline: boolean;
}): boolean {
  return !(preferEnterNewline && isMobileTextInputViewport);
}

export function resolveChatEnterShortcut({
  enterSubmits,
}: {
  enterSubmits: boolean;
}): "Enter" | undefined {
  return enterSubmits ? "Enter" : undefined;
}

export function shouldAvoidIosInputFocusZoom({
  isMobileTextInputViewport,
  isWebRemoteControl,
}: {
  isMobileTextInputViewport: boolean;
  isWebRemoteControl: boolean;
}): boolean {
  return isWebRemoteControl && isMobileTextInputViewport;
}

export function resolveMobileInputTextSizeClassName({
  avoidIosInputFocusZoom,
}: {
  avoidIosInputFocusZoom: boolean;
}): "text-ui-base leading-5" | "text-mobile-input-safe leading-6" {
  // Bugfix: iOS Safari / WKWebView auto-zooms the page when focusing an editable input below 16px.
  // text-ui-lg can drop to 14px with user preferences, so mobile remote control must use the fixed
  // 16px platform-compatible token.
  return avoidIosInputFocusZoom ? "text-mobile-input-safe leading-6" : "text-ui-base leading-5";
}
