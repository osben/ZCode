/**
 * Detail pane of one ACP agent in Model Settings: enable switch and status,
 * launch configuration, login helpers, and a roundtrip test. Raw ACP frames
 * stay behind the collapsed disclosure of AcpAgentFrames.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AcpAgentLoginResult,
  AcpAgentStatusReport,
  AcpAgentSummary,
  AcpAgentTestResult,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { AcpAgentFrames } from "./AcpAgentFrames.js";
import { AcpAgentMark } from "./AcpAgentMark.js";
import { ProviderStatusIndicator, type ProviderStatusKind } from "./ProviderStatusIndicator.js";
import {
  defaultAcpAgentFormValues,
  resolveAcpAgentStatusKind,
  formatAcpEnvLines,
  joinAcpArgs,
  parseAcpEnvLines,
  splitAcpArgs,
  acpProviderId,
  type AcpAgentFormValues,
  type AcpSavedAccess,
} from "./acpAgentConfig.js";

type BusyKind = "enable" | "save" | "disable" | "test" | null;

interface AcpAgentStatusState {
  readonly loading: boolean;
  readonly report?: AcpAgentStatusReport;
  readonly error?: string;
}

/** Same rhythm as the Model settings detail: a separator, then a text-ui-base section title. */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border pt-4">
      <h3 className="text-ui-base font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function AcpAgentDetail({
  agent,
  enabled,
  conflict,
  savedAccess,
  scanError,
  onRescan,
  rescanning,
  onEnable,
  onUpdate,
  onDisable,
}: {
  agent: AcpAgentSummary;
  enabled: boolean;
  /** Another personal provider already uses the `acp:<agentId>` id. */
  conflict: boolean;
  /** Saved access of an existing ACP provider (form prefill). */
  savedAccess?: AcpSavedAccess;
  /** Last failed detection scan; shown with a retry action. */
  scanError?: string;
  onRescan: () => void;
  rescanning: boolean;
  onEnable: (form: AcpAgentFormValues) => Promise<void>;
  onUpdate: (form: AcpAgentFormValues) => Promise<void>;
  onDisable: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const t = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id: `settings.modelProvider.acp.${id}` }, values),
    [intl],
  );

  const defaults = defaultAcpAgentFormValues(agent);
  const [command, setCommand] = useState(() => savedAccess?.command ?? defaults.command);
  const [argsText, setArgsText] = useState(() => joinAcpArgs(savedAccess?.args ?? defaults.args));
  const [envText, setEnvText] = useState(() => formatAcpEnvLines(savedAccess?.env ?? {}));
  // The provider settings view (carrying `savedAccess`) can arrive after this
  // pane mounted with detection defaults. Seed the form from the first
  // defined `savedAccess` unless the user already edited a field, so "Save
  // changes" never persists defaults over the saved command/args/env.
  const [formEdited, setFormEdited] = useState(false);
  const [savedAccessSeeded, setSavedAccessSeeded] = useState(savedAccess !== undefined);
  useEffect(() => {
    if (formEdited || savedAccessSeeded || savedAccess === undefined) return;
    setSavedAccessSeeded(true);
    setCommand(savedAccess.command);
    setArgsText(joinAcpArgs(savedAccess.args));
    setEnvText(formatAcpEnvLines(savedAccess.env));
  }, [formEdited, savedAccessSeeded, savedAccess]);
  const editCommand: typeof setCommand = (value) => {
    setFormEdited(true);
    setCommand(value);
  };
  const editArgsText: typeof setArgsText = (value) => {
    setFormEdited(true);
    setArgsText(value);
  };
  const editEnvText: typeof setEnvText = (value) => {
    setFormEdited(true);
    setEnvText(value);
  };
  // Status/login must follow the executable the user configured, so read the
  // latest command without re-running the mount-time status probe per keystroke.
  const commandRef = useRef(command);
  commandRef.current = command;
  const [busy, setBusy] = useState<BusyKind>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AcpAgentTestResult | null>(null);
  const [status, setStatus] = useState<AcpAgentStatusState | null>(null);
  const [loginResult, setLoginResult] = useState<AcpAgentLoginResult | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const envParse = parseAcpEnvLines(envText);
  const currentForm = useCallback(
    (): AcpAgentFormValues => ({
      command,
      args: splitAcpArgs(argsText),
      env: envParse.env,
    }),
    [command, argsText, envParse.env],
  );

  const loadStatus = useCallback(async () => {
    setStatus({ loading: true });
    try {
      const configured = commandRef.current.trim();
      const report = await providerSettingsService.getAcpAgentStatus({
        agentId: agent.agentId,
        ...(configured.length > 0 ? { command: configured } : {}),
      });
      setStatus({ loading: false, report });
    } catch (error) {
      logger.warn("[AcpAgentCard] login status check failed", error);
      setStatus({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [providerSettingsService, agent.agentId]);

  // Depend on a boolean, not the array: every rescan delivers a new `statusArgs` array for the same agent.
  const hasStatusArgs = agent.statusArgs !== null && agent.statusArgs !== undefined;
  useEffect(() => {
    if (hasStatusArgs) void loadStatus();
  }, [agent.agentId, hasStatusArgs, loadStatus]);

  const runAction = useCallback(
    async (kind: Exclude<BusyKind, "test" | null>, action: () => Promise<void>) => {
      setBusy(kind);
      setActionError(null);
      try {
        await action();
      } catch (error) {
        logger.warn(`[AcpAgentCard] ${kind} failed`, error);
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const runTest = useCallback(async () => {
    setBusy("test");
    setActionError(null);
    setTestResult(null);
    try {
      const form = currentForm();
      const result = await providerSettingsService.testAcpAgent({
        agentId: agent.agentId,
        ...(form.command.trim().length > 0 ? { command: form.command.trim() } : {}),
        args: form.args,
        env: form.env,
      });
      setTestResult(result);
    } catch (error) {
      logger.warn("[AcpAgentCard] test failed", error);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [providerSettingsService, agent.agentId, currentForm]);

  const startLogin = useCallback(async () => {
    setLoginBusy(true);
    setActionError(null);
    try {
      const configured = commandRef.current.trim();
      const result = await providerSettingsService.startAcpAgentLogin({
        agentId: agent.agentId,
        ...(configured.length > 0 ? { command: configured } : {}),
      });
      setLoginResult(result);
    } catch (error) {
      logger.warn("[AcpAgentCard] login failed", error);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoginBusy(false);
    }
  }, [providerSettingsService, agent.agentId]);

  const copyLoginCommand = useCallback(async () => {
    const command = loginResult?.command;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      logger.warn("[AcpAgentCard] clipboard write failed", error);
    }
  }, [loginResult?.command]);

  const statusLine = (() => {
    if (!status) return null;
    if (status.loading) return <Spinner className="size-3" />;
    if (status.error) return <span className="text-destructive">{status.error}</span>;
    const report = status.report;
    if (!report || !report.supported) return <span>{t("loginUnsupported")}</span>;
    const output = report.output?.split(/\r?\n/).find((line) => line.trim().length > 0);
    return (
      <span className="min-w-0 truncate" title={report.output ?? ""}>
        {output && output.trim().length > 0 ? output : `exit ${report.exitCode ?? "?"}`}
      </span>
    );
  })();

  // Dot semantics match provider rows: active = enabled and not in conflict.
  const statusKind: ProviderStatusKind = resolveAcpAgentStatusKind({
    enabled,
    installed: agent.installed,
    conflict,
  });
  const statusLabelId =
    statusKind === "ready"
      ? "settings.modelProvider.readyStatus"
      : statusKind === "unavailable"
        ? "settings.modelProvider.unavailableStatus"
        : "settings.modelProvider.disabledStatus";
  const switchLabel = t(enabled ? "disableAgentLabel" : "enableAgentLabel", {
    name: agent.displayName,
  });
  const switchDisabled = busy !== null || (!enabled && (command.trim().length === 0 || conflict));

  return (
    <div className="flex min-w-0 flex-col" data-acp-agent-card={agent.agentId}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <AcpAgentMark agentId={agent.agentId} name={agent.displayName} size="header" />
          <div className="min-w-0">
            <div className="truncate text-ui-lg font-semibold text-foreground">
              {agent.displayName}
            </div>
            <div className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground-subtle">
              {agent.version ? <span className="shrink-0">{agent.version}</span> : null}
              <span className="min-w-0 truncate" title={agent.commandPath ?? ""}>
                {agent.commandPath}
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle">
            <ProviderStatusIndicator status={statusKind} />
            <span>{intl.formatMessage({ id: statusLabelId })}</span>
          </span>
          <Switch
            className="after:-inset-x-1"
            data-testid="acp-agent-enabled-switch"
            aria-label={switchLabel}
            checked={enabled}
            disabled={switchDisabled}
            onCheckedChange={(next) => {
              if (next) {
                void runAction("enable", () => onEnable(currentForm()));
              } else {
                void runAction("disable", onDisable);
              }
            }}
          />
        </div>
      </div>

      {conflict ? (
        <p role="alert" className="mt-3 text-ui-sm text-destructive">
          {t("conflict", { providerId: acpProviderId(agent.agentId) })}
        </p>
      ) : null}

      {scanError ? (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-destructive"
        >
          <span>{t("scanFailed", { message: scanError })}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={rescanning}
            onClick={onRescan}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}

      <DetailSection title={t("sectionLaunch")}>
        <div className="flex flex-col gap-3">
          <div>
            <label
              htmlFor={`acp-command-${agent.agentId}`}
              className="mb-1 block text-ui-base text-foreground-subtle"
            >
              {t("command")}
            </label>
            <Input
              id={`acp-command-${agent.agentId}`}
              size="lg"
              value={command}
              spellCheck={false}
              onChange={(event) => editCommand(event.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor={`acp-args-${agent.agentId}`}
              className="mb-1 block text-ui-base text-foreground-subtle"
            >
              {t("arguments")}
            </label>
            <Input
              id={`acp-args-${agent.agentId}`}
              size="lg"
              value={argsText}
              spellCheck={false}
              onChange={(event) => editArgsText(event.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor={`acp-env-${agent.agentId}`}
              className="mb-1 block text-ui-base text-foreground-subtle"
            >
              {t("environment")}
            </label>
            <Textarea
              id={`acp-env-${agent.agentId}`}
              rows={3}
              value={envText}
              spellCheck={false}
              placeholder="KEY=value"
              className="rounded-lg border-input-border bg-input font-mono text-ui-base placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0"
              onChange={(event) => editEnvText(event.target.value)}
            />
            {envParse.invalidLines.length > 0 ? (
              <p role="alert" className="mt-1 text-ui-sm text-destructive">
                {t("envInvalid", { lines: envParse.invalidLines.join(", ") })}
              </p>
            ) : null}
          </div>
        </div>
        {enabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void runAction("save", () => onUpdate(currentForm()))}
            >
              {busy === "save" ? <Spinner className="me-1 size-3" /> : null}
              {t("saveChanges")}
            </Button>
          </div>
        ) : null}
      </DetailSection>

      <DetailSection title={t("sectionLogin")}>
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle">
          <span className="shrink-0">{t("loginStatus")}:</span>
          {statusLine}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={status?.loading === true}
            onClick={() => void loadStatus()}
          >
            {t("checkLogin")}
          </Button>
          {agent.loginArgs.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loginBusy}
              onClick={() => void startLogin()}
            >
              {loginBusy ? <Spinner className="me-1 size-3" /> : null}
              {t("login")}
            </Button>
          ) : null}
        </div>

        {loginResult ? (
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm">
            {loginResult.opened ? (
              <p className="text-foreground-subtle">
                {t("loginOpened", { command: loginResult.command })}
              </p>
            ) : (
              <>
                <p className="text-foreground-subtle">{t("loginManual")}</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-ui-sm">
                    {loginResult.command}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copyLoginCommand()}
                  >
                    {copied ? t("copied") : t("copy")}
                  </Button>
                </div>
                {loginResult.error ? (
                  <p role="alert" className="mt-1 text-destructive">
                    {loginResult.error}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </DetailSection>

      <DetailSection title={t("sectionTest")}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void runTest()}
          >
            {busy === "test" ? <Spinner className="me-1 size-3" /> : null}
            {busy === "test" ? t("testing") : t("test")}
          </Button>
        </div>
        {testResult ? (
          <div className="flex flex-col gap-2">
            <p
              role={testResult.ok ? undefined : "alert"}
              className={`text-ui-sm ${testResult.ok ? "text-foreground" : "text-destructive"}`}
            >
              {testResult.ok
                ? t("testOk", { duration: testResult.durationMs })
                : t("testFailed", { message: testResult.error?.message ?? t("unknownError") })}
            </p>
            {testResult.stderrTail ? (
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ui-sm">
                {testResult.stderrTail}
              </pre>
            ) : null}
            <AcpAgentFrames
              frames={testResult.frames}
              dropped={testResult.framesDropped}
              title={t("frames", { count: testResult.frames.length })}
              droppedLabel={t("framesDropped", { count: testResult.framesDropped })}
            />
          </div>
        ) : null}
      </DetailSection>

      {actionError ? (
        <p role="alert" className="mt-4 text-ui-sm text-destructive">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
