use super::*;

fn code(result: Result<(Vec<u8>, String), RpcError>) -> String {
    let error = result.unwrap_err();
    // The Host reads the fault from `data.code` (Node `toProtocolError`) or from the whole message.
    assert_eq!(error.data.as_ref().unwrap()["code"], error.message);
    error.message
}

#[test]
fn artifact_data_urls_decode_like_node_decode_prompt_attachment_data_url() {
    let png = format!("data:image/PNG;base64,{}", base64().encode(b"\x89PNG"));
    assert_eq!(
        decode_data_url(png.as_bytes(), "image/png", 64).unwrap(),
        (b"\x89PNG".to_vec(), "image/png".to_owned())
    );
    // An empty header takes the part's MIME.
    let bare = format!("data:;base64,{}", base64().encode(b"%PDF"));
    assert_eq!(
        decode_data_url(bare.as_bytes(), "application/pdf", 64)
            .unwrap()
            .1,
        "application/pdf"
    );
    // Text is served only when the part also says text/plain (Node's text material).
    let text = format!("data:text/plain;base64,{}", base64().encode(b"hi"));
    assert_eq!(
        decode_data_url(text.as_bytes(), "text/plain", 64)
            .unwrap()
            .0,
        b"hi"
    );
    assert_eq!(
        code(decode_data_url(text.as_bytes(), "text/markdown", 64)),
        "fault.attachment.previewNotMedia"
    );
    let zip = format!("data:application/zip;base64,{}", base64().encode(b"PK"));
    assert_eq!(
        code(decode_data_url(zip.as_bytes(), "application/zip", 64)),
        "fault.attachment.previewNotMedia"
    );
}

#[test]
fn malformed_or_oversized_artifacts_are_refused() {
    for content in [
        "image/png;base64,AAAA",
        "data:image/png,AAAA",
        "data:image/png;base64,AAA",
        "data:image/png;base64,AA=A",
        "data:image/png;base64,AA!A",
        "data:image/png;base64,A===",
    ] {
        assert_eq!(
            code(decode_data_url(content.as_bytes(), "image/png", 64)),
            "fault.attachment.previewArtifactInvalid",
            "{content}"
        );
    }
    let big = format!("data:image/png;base64,{}", base64().encode([0u8; 9]));
    assert_eq!(
        code(decode_data_url(big.as_bytes(), "image/png", 8)),
        "fault.attachment.previewTooLarge"
    );
}
