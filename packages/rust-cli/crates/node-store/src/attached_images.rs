//! Fork: reads back App images whose bytes live in a session artifact (Node's `persistAttachmentDataUrl` shape, written
//! by either runtime). `hydrate` leaves them [`AttachedBody::Omitted`] with [`AttachedFile::stored`] set, because the
//! database thread does no file IO; the store's `load` calls [`resolve`] afterwards, so the model gets the image block.
//!
//! [`AttachedFile::stored`]: rust_cli_kernel_api::message::AttachedFile::stored

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{AttachedBody, ContentBlock, Message};
use rust_cli_kernel_api::prompt_attachment::{image_of_data_url, parse_artifact_uri};
use rust_cli_kernel_api::store::ArtifactStore;

/// Fills the image of each stored attachment of `session`'s user messages. One that is missing, of another session, too
/// large or not an image data URL stays the metadata reminder.
pub(crate) async fn resolve<S: ArtifactStore + ?Sized>(
    store: &S,
    session: &SessionId,
    messages: &mut [Message],
) {
    for message in messages {
        let Message::User(user) = message else {
            continue;
        };
        for block in &mut user.content {
            let ContentBlock::File { file } = block else {
                continue;
            };
            if file.body != AttachedBody::Omitted || !file.mime.starts_with("image/") {
                continue;
            }
            let Some((owner, id)) = file.stored.as_deref().and_then(parse_artifact_uri) else {
                continue;
            };
            if &owner != session {
                continue;
            }
            let Ok(Some(artifact)) = store.find(&owner, &id).await else {
                continue;
            };
            let Ok(content) = store.get(&artifact).await else {
                continue;
            };
            if let Some(source) = String::from_utf8(content)
                .ok()
                .as_deref()
                .and_then(image_of_data_url)
            {
                file.body = AttachedBody::Image { source };
            }
        }
    }
}
