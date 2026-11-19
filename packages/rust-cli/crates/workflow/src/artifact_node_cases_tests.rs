//! The Node cases of `workflow-driver-artifacts.test.ts` that the existing Rust tests do not state directly. Each test
//! names the Node case it ports. The mapping table is in spec 9.11.

use crate::artifact_publish::{
    ArtifactFsPort, ArtifactStorePort, FsFault, PublishDeps, StoreContent, StoreReceipt,
    StoreWrite, caps, execute_artifact_publish, extension_content_type,
};
use crate::engine_artifacts::ArtifactPublishRequest;
use crate::error::ErrorCode;
use rust_cli_base::js::json::stringify;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A file port that answers `read_file` with a file of `size` bytes and records the `max_bytes` it was asked for.
struct Probe {
    size: usize,
    seen: Mutex<Vec<usize>>,
}

impl ArtifactFsPort for Probe {
    fn read_file(&self, _path: &Path, max_bytes: usize) -> Result<Vec<u8>, FsFault> {
        self.seen.lock().unwrap().push(max_bytes);
        if self.size > max_bytes {
            return Err(FsFault::TooLarge);
        }
        Ok(vec![0; self.size])
    }

    fn real_path(&self, path: &Path) -> Result<PathBuf, FsFault> {
        Ok(path.to_path_buf())
    }
}

#[derive(Default)]
struct Store {
    writes: Mutex<Vec<String>>,
}

impl ArtifactStorePort for Store {
    fn supports_binary(&self) -> bool {
        true
    }

    fn write(&self, write: &StoreWrite<'_>) -> Result<StoreReceipt, String> {
        let bytes = match write.content {
            StoreContent::Text(text) => text.len(),
            StoreContent::Binary(bytes) => bytes.len(),
        };
        self.writes
            .lock()
            .unwrap()
            .push(write.content_type.to_owned());
        Ok(StoreReceipt {
            bytes,
            uri: "zcode-artifact://sess/x".to_owned(),
        })
    }
}

fn deps<'a>(fs: &'a Probe, store: &'a Store) -> PublishDeps<'a> {
    PublishDeps {
        fs,
        store: Some(store),
        parent_session_id: Some("sess_parent"),
        cwd: Path::new("/ws/root"),
        now_ms: 1,
    }
}

fn request(op: &str, id: &str) -> ArtifactPublishRequest {
    ArtifactPublishRequest {
        run_id: "run-1".to_owned(),
        site_id: "artifact#1".to_owned(),
        ordinal: 1,
        op: op.to_owned(),
        id: id.to_owned(),
        version: 1,
        path: None,
        content: None,
        opts: None,
    }
}

fn file_request(path: &str) -> ArtifactPublishRequest {
    let mut req = request("file", "report");
    req.path = Some(path.to_owned());
    req
}

fn error_of(result: Result<Value, crate::error::WorkflowError>) -> crate::error::WorkflowError {
    result.expect_err("an error")
}

/// "cap+1 probe: the port is asked for cap+1 bytes, and exactly cap is allowed". The port receives `cap + 1`, as
/// Node's `readBinaryFile({ maxBytes: cap + 1 })` does.
#[test]
fn probe_case_the_port_is_asked_for_cap_plus_one_and_exactly_cap_is_allowed() {
    let fs = Probe {
        size: caps::MAX_FILE_BYTES,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let record = execute_artifact_publish(&deps(&fs, &store), &file_request("out.bin")).unwrap();
    assert_eq!(*fs.seen.lock().unwrap(), vec![caps::MAX_FILE_BYTES + 1]);
    assert_eq!(record["bytes"], caps::MAX_FILE_BYTES);
}

/// "一个多 1 字节的文件被拒绝": one byte over the cap is refused, never truncated.
#[test]
fn probe_case_one_byte_over_the_cap_is_refused() {
    let fs = Probe {
        size: caps::MAX_FILE_BYTES + 1,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let error = error_of(execute_artifact_publish(
        &deps(&fs, &store),
        &file_request("out.bin"),
    ));
    assert_eq!(error.code, ErrorCode::ArtifactTooLarge);
    assert!(store.writes.lock().unwrap().is_empty());
}

/// "按扩展名表：每个扩展名都映射到表中的类型" (the table of the Node test, all seventeen rows).
#[test]
fn type_case_every_extension_of_the_table_maps_to_its_type() {
    let table = [
        ("pdf", "application/pdf"),
        ("html", "text/html"),
        ("htm", "text/html"),
        ("md", "text/markdown"),
        ("markdown", "text/markdown"),
        ("txt", "text/plain"),
        ("csv", "text/csv"),
        ("json", "application/json"),
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
        ("svg", "image/svg+xml"),
        (
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        (
            "pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        (
            "docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
    ];
    for (extension, content_type) in table {
        assert_eq!(
            extension_content_type(extension),
            Some(content_type),
            ".{extension}"
        );
    }
}

/// "markdown 不读 opts.contentType（这一族恒 text/markdown）".
#[test]
fn markdown_case_the_content_type_option_is_ignored() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let mut req = request("markdown", "summary");
    req.content = Some("# x".to_owned());
    req.opts = Some(json!({"contentType": "text/html"}));
    let record = execute_artifact_publish(&deps(&fs, &store), &req).unwrap();
    assert_eq!(record["contentType"], "text/markdown");
}

/// "opts 是字符串 / 数组 / null 时大声拒绝".
#[test]
fn opts_case_a_string_an_array_or_null_is_refused_and_names_opts() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    for bad in [json!("title"), json!(["title"]), Value::Null] {
        let mut req = request("markdown", "summary");
        req.content = Some(String::new());
        req.opts = Some(bad.clone());
        let error = error_of(execute_artifact_publish(&deps(&fs, &store), &req));
        assert_eq!(error.code, ErrorCode::DriverError, "{bad}");
        assert!(error.message.contains("opts"), "{}", error.message);
    }
}

/// "title / description 必须是 string，绝不强转" for description (the title half is in the unit tests).
#[test]
fn opts_case_a_non_string_description_is_refused_without_coercion() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let mut req = request("markdown", "summary");
    req.content = Some(String::new());
    req.opts = Some(json!({"description": {}}));
    let error = error_of(execute_artifact_publish(&deps(&fs, &store), &req));
    assert_eq!(error.code, ErrorCode::DriverError);
    assert!(
        error.message.contains("opts.description"),
        "{}",
        error.message
    );
}

/// "title / description 超长按上限拒绝而不是截断" for description, and "恰好等于上限放行".
#[test]
fn opts_case_description_over_the_cap_is_refused_and_at_the_cap_is_allowed() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let mut over = request("markdown", "summary");
    over.content = Some(String::new());
    over.opts = Some(json!({"description": "x".repeat(caps::MAX_DESCRIPTION_LENGTH + 1)}));
    assert_eq!(
        error_of(execute_artifact_publish(&deps(&fs, &store), &over)).code,
        ErrorCode::ArtifactTooLarge
    );
    let mut at = request("markdown", "summary");
    at.content = Some(String::new());
    at.opts = Some(json!({"description": "x".repeat(caps::MAX_DESCRIPTION_LENGTH)}));
    let record = execute_artifact_publish(&deps(&fs, &store), &at).unwrap();
    assert_eq!(
        record["description"].as_str().map(str::len),
        Some(caps::MAX_DESCRIPTION_LENGTH)
    );
}

/// "非法 id（字符集 / 超长）是接线错误，报 DriverError": the over-long id, and the slash.
#[test]
fn id_case_an_over_long_or_slashed_id_is_a_driver_error() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let mut long = request("markdown", &"i".repeat(caps::MAX_ID_LENGTH + 1));
    long.content = Some(String::new());
    assert_eq!(
        error_of(execute_artifact_publish(&deps(&fs, &store), &long)).code,
        ErrorCode::DriverError
    );
    let mut slash = request("markdown", "bad/slash");
    slash.content = Some(String::new());
    assert_eq!(
        error_of(execute_artifact_publish(&deps(&fs, &store), &slash)).code,
        ErrorCode::DriverError
    );
}

/// "payload 缺席或类型不对同样大声失败": a file with no path, a markdown with no content.
#[test]
fn payload_case_a_missing_path_or_content_fails_loudly() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let no_path = request("file", "report");
    assert_eq!(
        error_of(execute_artifact_publish(&deps(&fs, &store), &no_path)).code,
        ErrorCode::DriverError
    );
    let no_content = request("markdown", "summary");
    assert_eq!(
        error_of(execute_artifact_publish(&deps(&fs, &store), &no_content)).code,
        ErrorCode::DriverError
    );
}

/// "装配没有 store 时，两个内容成员都以 ArtifactStoreUnavailable 拒绝" (the markdown half; the file half is a unit test).
#[test]
fn store_case_markdown_with_no_store_is_unavailable() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let d = PublishDeps {
        fs: &fs,
        store: None,
        parent_session_id: Some("sess_parent"),
        cwd: Path::new("/ws/root"),
        now_ms: 1,
    };
    let mut req = request("markdown", "summary");
    req.content = Some("x".to_owned());
    assert_eq!(
        error_of(execute_artifact_publish(&d, &req)).code,
        ErrorCode::ArtifactStoreUnavailable
    );
}

/// "工作区相对路径的点段归一后保留子目录出处" with the sourcePath and the text type of a note.
#[test]
fn file_case_dot_segments_normalize_and_keep_the_subdirectory_source() {
    let fs = Probe {
        size: 2,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let record =
        execute_artifact_publish(&deps(&fs, &store), &file_request("./a/b/../b/note.txt")).unwrap();
    assert_eq!(record["sourcePath"], "a/b/note.txt");
    assert_eq!(record["contentType"], "text/plain");
}

/// "markdown 的记录没有 sourcePath" and "它的写入参数是 text/markdown、CreateWorkflow、project".
#[test]
fn markdown_case_the_record_has_no_source_path_and_the_write_is_text() {
    let fs = Probe {
        size: 0,
        seen: Mutex::new(Vec::new()),
    };
    let store = Store::default();
    let mut req = request("markdown", "summary");
    req.content = Some("# 结论".to_owned());
    req.opts = Some(json!({"title": "小结"}));
    let record = execute_artifact_publish(&deps(&fs, &store), &req).unwrap();
    assert!(record.get("sourcePath").is_none());
    assert_eq!(store.writes.lock().unwrap()[0], "text/markdown");
    // The serialized record keeps Node's key order without a sourcePath key.
    assert!(!stringify(&record).contains("sourcePath"));
}
