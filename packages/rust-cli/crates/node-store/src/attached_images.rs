//! Fork: reads back App images and videos whose bytes live in a session artifact (Node's `persistAttachmentDataUrl`
//! shape, written by either runtime). `hydrate` leaves them [`AttachedBody::Omitted`] with [`AttachedFile::stored`] set, because the
//! database thread does no file IO; the store's `load` calls [`resolve`] afterwards, so the model gets the media block.
//!
//! [`AttachedFile::stored`]: rust_cli_kernel_api::message::AttachedFile::stored

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{AttachedBody, ContentBlock, Message};
use rust_cli_kernel_api::prompt_attachment::{
    VIDEO_INPUT_MAX_BYTES, image_of_data_url, parse_artifact_uri, video_of_data_url,
};
use rust_cli_kernel_api::store::ArtifactStore;

/// Fills the image or video of each stored attachment of `session`'s user messages. One that is missing, of another
/// session, too large or not a matching data URL stays the metadata reminder.
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
            let video = file.mime.starts_with("video/");
            if file.body != AttachedBody::Omitted || !(video || file.mime.starts_with("image/")) {
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
            // A data URL of a video over the limit is not loaded at all (base64 plus its header).
            if video && artifact.size > VIDEO_INPUT_MAX_BYTES.div_ceil(3) * 4 + 1024 {
                continue;
            }
            let Ok(content) = store.get(&artifact).await else {
                continue;
            };
            let Ok(content) = String::from_utf8(content) else {
                continue;
            };
            file.body = if video {
                match video_of_data_url(&content) {
                    Some(source) => AttachedBody::Video { source },
                    None => continue,
                }
            } else {
                match image_of_data_url(&content) {
                    Some(source) => AttachedBody::Image { source },
                    None => continue,
                }
            };
        }
    }
}
