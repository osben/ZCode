import type { LaunchMarks } from "@zcode/shared";

export function shouldReportLaunchToInput(state: {
  isStartupRenderBlocked: boolean;
  welcomeScreenOpen: boolean;
  alreadyReported: boolean;
}): boolean {
  // Gate cleared = RootStartupLoading exited and the input mounted; during welcome the gate is clear but the sign-in page is shown with no input, so it is not “ready for input.”
  return !state.alreadyReported && !state.isStartupRenderBlocked && !state.welcomeScreenOpen;
}

export function readRendererLaunchTimings(): {
  marks: LaunchMarks | null;
  rendererStart: number;
  reactCommit: number;
} | null {
  const w = window as Window & {
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_REACT_COMMIT_AT__?: number;
  };
  const rendererStart = w.__ZCODE_RENDERER_START__;
  const reactCommit = w.__ZCODE_REACT_COMMIT_AT__;
  if (typeof rendererStart !== "number" || typeof reactCommit !== "number") {
    return null;
  }
  return { marks: w.__ZCODE_LAUNCH_MARKS__ ?? null, rendererStart, reactCommit };
}
