/**
 * One ACP agent card in Model Settings: status, activation, command/args/env
 * form, roundtrip test with raw frames, and login/status affordances.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AcpAgentLoginResult,
  AcpAgentStatusReport,
  AcpAgentSummary,
  AcpAgentTestResult,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { AcpAgentFrames } from "./AcpAgentFrames.js";
import {
  defaultAcpAgentFormValues,
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

export function AcpAgentCard({
  agent,
  enabled,
  conflict,
  savedAccess,
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
  // card mounted with detection defaults. Seed the form from the first
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

  useEffect(() => {
    if (agent.statusArgs) void loadStatus();
  }, [agent.statusArgs, loadStatus]);

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

  return (
    <div
      className="rounded-lg border border-border bg-card p-4"
      data-acp-agent-card={agent.agentId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-base font-medium text-foreground">{agent.displayName}</span>
        {agent.version ? (
          <span className="text-ui-sm text-foreground-subtle">{agent.version}</span>
        ) : null}
        {enabled ? <Badge variant="secondary">{t("enabled")}</Badge> : null}
        <span
          className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle"
          title={agent.commandPath ?? ""}
        >
          {agent.commandPath}
        </span>
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
          {enabled ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy !== null}
                onClick={() => void runAction("save", () => onUpdate(currentForm()))}
              >
                {busy === "save" ? <Spinner className="me-1 size-3" /> : null}
                {t("saveChanges")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void runAction("disable", onDisable)}
              >
                {busy === "disable" ? <Spinner className="me-1 size-3" /> : null}
                {t("disable")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy !== null || command.trim().length === 0 || conflict}
              onClick={() => void runAction("enable", () => onEnable(currentForm()))}
            >
              {busy === "enable" ? <Spinner className="me-1 size-3" /> : null}
              {t("enable")}
            </Button>
          )}
        </div>
      </div>

      {conflict ? (
        <p className="mt-2 text-ui-sm text-destructive">
          {t("conflict", { providerId: acpProviderId(agent.agentId) })}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle">
        <span>{t("loginStatus")}:</span>
        {statusLine}
        <Button
          type="button"
          size="sm"
          variant="ghost"
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
        <div className="mt-2 rounded-md border border-border bg-surface px-3 py-2 text-ui-sm">
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
                <p className="mt-1 text-destructive">{loginResult.error}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer select-none text-ui-sm text-foreground-subtle">
          {t("advanced")}
        </summary>
        <div className="mt-3 grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`acp-command-${agent.agentId}`}>{t("command")}</Label>
            <Input
              id={`acp-command-${agent.agentId}`}
              value={command}
              spellCheck={false}
              onChange={(event) => editCommand(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`acp-args-${agent.agentId}`}>{t("arguments")}</Label>
            <Input
              id={`acp-args-${agent.agentId}`}
              value={argsText}
              spellCheck={false}
              onChange={(event) => editArgsText(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`acp-env-${agent.agentId}`}>{t("environment")}</Label>
            <Textarea
              id={`acp-env-${agent.agentId}`}
              rows={3}
              value={envText}
              spellCheck={false}
              className="font-mono text-ui-sm"
              onChange={(event) => editEnvText(event.target.value)}
            />
            {envParse.invalidLines.length > 0 ? (
              <p className="text-ui-sm text-destructive">
                {t("envInvalid", { lines: envParse.invalidLines.join(", ") })}
              </p>
            ) : null}
          </div>
        </div>
      </details>

      {testResult ? (
        <div className="mt-3 space-y-2">
          <p className={`text-ui-sm ${testResult.ok ? "text-foreground" : "text-destructive"}`}>
            {testResult.ok
              ? t("testOk", { duration: testResult.durationMs })
              : t("testFailed", { message: testResult.error?.message ?? t("unknownError") })}
          </p>
          {testResult.stderrTail ? (
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-ui-sm">
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

      {actionError ? <p className="mt-2 text-ui-sm text-destructive">{actionError}</p> : null}
    </div>
  );
}
