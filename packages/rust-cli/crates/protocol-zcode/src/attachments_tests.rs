use super::*;
use rust_cli_kernel_api::ids::ArtifactId;

#[test]
fn artifact_uris_round_trip_like_node() {
    let artifact = ArtifactRef {
        session: SessionId::new("sess 1"),
        id: ArtifactId::new("tool-result-abc"),
        purpose: ArtifactPurpose::Attachment,
        media_type: "text/plain".into(),
        size: 1,
    };
    let reference = uri(&artifact);
    assert_eq!(reference, "zcode-artifact://sess%201/tool-result-abc");
    assert_eq!(
        rust_cli_kernel_api::prompt_attachment::parse_artifact_uri(&reference),
        Some((SessionId::new("sess 1"), ArtifactId::new("tool-result-abc")))
    );
}

#[test]
fn data_urls_decode_to_their_bytes_and_mime() {
    let content = format!("data:image/png;base64,{}", base64().encode(b"\x89PNG"));
    assert_eq!(
        from_data_url(content.into_bytes(), "text/plain"),
        (b"\x89PNG".to_vec(), "image/png".to_owned())
    );
    assert_eq!(
        from_data_url(b"plain".to_vec(), "text/plain"),
        (b"plain".to_vec(), "text/plain".to_owned())
    );
}
