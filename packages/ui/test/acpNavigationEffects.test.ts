// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ACP_DETECT_NODE_KEY,
  ACP_LOADING_NODE_KEY,
  acpAgentNodeKey,
  acpProviderId,
  buildAcpNavigationGroup,
  type AcpDetectionState,
} from "@/settings/model-provider-section/acpAgentConfig.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { useModelProviderNavigation } from "@/settings/model-provider-section/useModelProviderNavigation.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

const intl = { formatMessage: ({ id }: { id: string }) => id } as never;

function group(
  detection: AcpDetectionState,
  enabledIds: string[] = [],
): ModelProviderNavGroup | null {
  return buildAcpNavigationGroup({
    title: "ACP agents",
    detectLabel: "Detect agents",
    detectingLabel: "Detecting agents",
    detection,
    enabledProviderIds: new Set(enabledIds.map(acpProviderId)),
    managedAgentIds: new Set(enabledIds),
    conflictAgentIds: new Set(),
  });
}

const OPENCODE = {
  agentId: "opencode",
  displayName: "opencode",
  installed: true,
  version: null,
  commandPath: "/bin/opencode",
  spawnArgs: ["acp"],
  loginArgs: [],
  statusArgs: null,
};

const READY_WITH_AGENT: AcpDetectionState = {
  status: "ready",
  agents: [OPENCODE],
  supported: true,
  refreshing: false,
};
const READY_EMPTY: AcpDetectionState = {
  status: "ready",
  agents: [],
  supported: true,
  refreshing: false,
};
const LOADING: AcpDetectionState = {
  status: "loading",
  agents: [],
  supported: true,
  refreshing: true,
};

/** Mirrors the page: selection is real state, so the correction effect can update it. */
function useHarness(params: {
  initialKey: string;
  acpGroup: ModelProviderNavGroup | null;
  acpDetectionPending: boolean;
  setSpy: (key: string | null) => void;
}) {
  const [selectedNodeKey, setSelected] = useState<string | null>(params.initialKey);
  // Stable like the page's useState setter; the hook's effect depends on it.
  const setSelectedNodeKey = useCallback(
    (key: string | null) => {
      params.setSpy(key);
      setSelected(key);
    },
    [params.setSpy],
  );
  const navigation = useModelProviderNavigation({
    presetProviders: [],
    modelProviders: [],
    selectedNodeKey,
    setSelectedNodeKey,
    acpGroup: params.acpGroup,
    acpDetectionPending: params.acpDetectionPending,
    intl,
  });
  return { selectedNodeKey, navigation };
}

describe("ACP selection correction", () => {
  it("keeps an acp-agent selection while the first detection is pending", () => {
    const setSpy = vi.fn();
    const { result } = renderHook(() =>
      useHarness({
        initialKey: acpAgentNodeKey("opencode"),
        acpGroup: group(LOADING),
        acpDetectionPending: true,
        setSpy,
      }),
    );
    expect(result.current.selectedNodeKey).toBe(acpAgentNodeKey("opencode"));
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("corrects an acp-agent selection once detection settles without that agent", () => {
    const setSpy = vi.fn();
    const { result } = renderHook(() =>
      useHarness({
        initialKey: acpAgentNodeKey("opencode"),
        acpGroup: group(READY_EMPTY),
        acpDetectionPending: false,
        setSpy,
      }),
    );
    expect(result.current.selectedNodeKey).not.toBe(acpAgentNodeKey("opencode"));
    expect(setSpy).toHaveBeenCalled();
  });

  it("moves the catalog entry to the first agent once found, without looping", () => {
    const setSpy = vi.fn();
    const { result, rerender } = renderHook(
      ({ acpGroup }: { acpGroup: ModelProviderNavGroup | null }) =>
        useHarness({
          initialKey: ACP_DETECT_NODE_KEY,
          acpGroup,
          acpDetectionPending: false,
          setSpy,
        }),
      { initialProps: { acpGroup: group(READY_EMPTY) } },
    );
    expect(result.current.selectedNodeKey).toBe(ACP_DETECT_NODE_KEY);
    setSpy.mockClear();
    rerender({ acpGroup: group(READY_WITH_AGENT, ["opencode"]) });
    expect(result.current.selectedNodeKey).toBe(acpAgentNodeKey("opencode"));
    expect(setSpy).toHaveBeenCalledTimes(1);
    rerender({ acpGroup: group(READY_WITH_AGENT, ["opencode"]) });
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("does not treat the loading row as a selection to correct away", () => {
    const setSpy = vi.fn();
    const { result } = renderHook(() =>
      useHarness({
        initialKey: ACP_LOADING_NODE_KEY,
        acpGroup: group(LOADING),
        acpDetectionPending: true,
        setSpy,
      }),
    );
    expect(result.current.selectedNodeKey).toBe(ACP_LOADING_NODE_KEY);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
