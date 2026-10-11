import type { IPlatformService, Locale, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";

export function UpdateStatusWindowRoot({
  platform,
  initialLocale,
  onRequestClose,
}: {
  platform: IPlatformService;
  initialLocale: Locale;
  onRequestClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        onRequestClose();
      }
    },
    [onRequestClose],
  );

  useEffect(() => {
    const disposers: Array<() => void> = [];
    const eventRevision = () => {
      revisionRef.current += 1;
      return revisionRef.current;
    };

    // The standalone update window does not have the main window’s app chrome state, so it must fetch a
    // getUpdateState snapshot itself; use revision at the same time to keep an old snapshot from overwriting a newer live event.
    const snapshotRevision = revisionRef.current;
    void platform.getUpdateState?.().then((payload) => {
      if (revisionRef.current !== snapshotRevision) {
        return;
      }
      setUpdateState(payload);
    });

    disposers.push(
      platform.onUpdateStateChanged?.((payload) => {
        eventRevision();
        setUpdateState(payload);
      }) ?? (() => {}),
    );
    disposers.push(
      platform.onUpdateReady((version) => {
        setReadyVersion(version);
      }),
    );
    disposers.push(
      platform.onApplicationLocaleChanged?.((nextLocale) => {
        setLocale(nextLocale);
      }) ?? (() => {}),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [platform]);

  return (
    <div className="min-h-screen bg-transparent text-foreground">
      {/* The standalone update window does not mount the workspace settings/broadcast service, so it cannot rely only on the startup locale.
          When the main window changes language, the main process pushes the latest resolved locale; rebuild the Provider here so dialog text follows immediately. */}
      <ZCodeIntlProvider key={locale} initialLocale={locale}>
        <UpdateStatusDialogController
          platform={platform}
          version={readyVersion}
          updateState={updateState}
          open={open}
          onOpenChange={handleOpenChange}
          edgeToEdge
          showOverlay={false}
        />
        <ConfirmDialogHost />
      </ZCodeIntlProvider>
    </div>
  );
}
