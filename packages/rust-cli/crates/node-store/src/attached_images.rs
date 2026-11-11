//! Fork: reads back App images and videos whose bytes live in a session artifact (Node's `persistAttachmentDataUrl`
//! shape, written by either runtime). `hydrate` leaves them [`AttachedBody::Omitted`] with [`AttachedFile::stored`] set, because the
//! database thread does no file IO; the store's `load` calls [`resolve`] afterwards, so the model gets the media block.
//!
//! [`AttachedFile::stored`]: rust_cli_kernel_api::message::AttachedFile::stored

use rust_cli_kernel_api::message::{AttachedBody, ContentBlock, ImageSource, Message};
use rust_cli_kernel_api::prompt_attachment::{
    VIDEO_INPUT_MAX_BYTES, image_of_data_url, parse_artifact_uri, video_of_data_url,
};
use rust_cli_kernel_api::store::ArtifactStore;

/// Fills the image or video of each stored attachment of a session's user messages. The artifact may belong to another
/// session: a forked session's parts keep the parent's URIs (Node `clonePartForFork`), and Node reads any stored URI
/// (`filePartDataUrl`). One that is missing, too large (a video) or not a matching data URL stays the metadata reminder.
pub(crate) async fn resolve<S: ArtifactStore + ?Sized>(store: &S, messages: &mut [Message]) {
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
                    Some(source) => match within_budget(source).await {
                        Some(source) => AttachedBody::Image { source },
                        None => continue,
                    },
                    None => continue,
                }
            };
        }
    }
}

/// A stored image as the model may receive it. An attached image was prepared within the model budget when it was sent,
/// but a web-remote upload keeps its original artifact (Node `existingArtifactUri`), which can be larger. Node sends
/// that original back unchecked; here an image over the budget is prepared again with the same ladder, so a cold
/// resume sends the image the first turn sent instead of one the provider refuses. `None` when it cannot be prepared.
async fn within_budget(source: ImageSource) -> Option<ImageSource> {
    use base64::Engine as _;
    let ImageSource::Base64 { media_type, data } = &source else {
        return Some(source);
    };
    if data.len() as u64 <= rust_cli_image::MAX_BASE64_BYTES {
        return Some(source);
    }
    let engine = &base64::engine::general_purpose::STANDARD;
    let bytes = engine.decode(data.as_bytes()).ok()?;
    let declared = media_type.clone();
    // Decoding and encoding are CPU bound.
    let prepared = tokio::task::spawn_blocking(move || {
        rust_cli_image::prepare(bytes, &declared, &rust_cli_image::MODEL)
    })
    .await
    .ok()?
    .ok()?;
    Some(ImageSource::Base64 {
        media_type: prepared.media_type.to_owned(),
        data: engine.encode(&prepared.data),
    })
}
