//! Fork: a conversation share's context in an imported session (specs/fork-rust-imported-history.md, Shared context).

/// The `UserOrigin::Meta` source of the hidden message that holds the share's markdown: Node's
/// `source: "shared_context"` on the stored message.
pub const SOURCE: &str = "shared_context";

/// Node's `shared_context_import` kind of an input's `sharedContextRefs` entry.
pub const REF_KIND: &str = "shared_context_import";
