export function WebRemoteControlRepairNoticeScreen({ message }: { message: string }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground"
      style={{ minHeight: "100dvh" }}
    >
      <main
        role="alert"
        className="w-full max-w-md rounded-xl border border-card-border bg-card p-5 shadow-sm"
      >
        <p className="text-ui-sm leading-6 text-foreground">{message}</p>
      </main>
    </div>
  );
}
