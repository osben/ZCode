//! Random ids for wire messages that zod validates with `.uuid()`.

/// A random v4 uuid, from the platform's CSPRNG (shared with the run ids of the workflow engine, `rust_cli_platform::ids`).
/// The wire ids correlate messages (a cipher reply, a hook review flow or interaction), so the one source serves both.
pub(crate) fn uuid_v4() -> String {
    rust_cli_platform::ids::uuid_v4()
}
