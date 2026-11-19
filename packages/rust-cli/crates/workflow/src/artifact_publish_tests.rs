//! Artifact publish through fakes (Node `workflow-driver-artifacts.test.ts`, the shape and store cases).

use super::*;
use rust_cli_base::js::json::stringify;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

#[derive(Default)]
struct Fs {
    files: BTreeMap<PathBuf, Vec<u8>>,
    dirs: BTreeSet<PathBuf>,
    links: BTreeMap<PathBuf, PathBuf>,
    reads: Mutex<Vec<PathBuf>>,
    read_override: Option<FsFault>,
}

impl ArtifactFsPort for Fs {
    fn read_file(&self, path: &Path, max_bytes: usize) -> Result<Vec<u8>, FsFault> {
        self.reads.lock().unwrap().push(path.to_path_buf());
        if let Some(fault) = &self.read_override {
            return Err(fault.clone());
        }
        if self.dirs.contains(path) {
            return Err(FsFault::IsDirectory);
        }
        let bytes = self.files.get(path).ok_or(FsFault::NotFound)?;
        if bytes.len() > max_bytes {
            return Err(FsFault::TooLarge);
        }
        Ok(bytes.clone())
    }

    fn real_path(&self, path: &Path) -> Result<PathBuf, FsFault> {
        if let Some(target) = self.links.get(path) {
            return Ok(target.clone());
        }
        if self.files.contains_key(path) || self.dirs.contains(path) {
            return Ok(path.to_path_buf());
        }
        if path == Path::new("/ws/root") {
            return Ok(path.to_path_buf());
        }
        Err(FsFault::NotFound)
    }
}

/// One recorded write: session, tool-call id, tool name, retention, `kind:content-type`, extension, and byte length.
type Written = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    usize,
);

#[derive(Default)]
struct Store {
    binary: bool,
    fail: Option<String>,
    writes: Mutex<Vec<Written>>,
}

impl ArtifactStorePort for Store {
    fn supports_binary(&self) -> bool {
        self.binary
    }

    fn write(&self, write: &StoreWrite<'_>) -> Result<StoreReceipt, String> {
        if let Some(message) = &self.fail {
            return Err(message.clone());
        }
        let (kind, length) = match write.content {
            StoreContent::Text(text) => ("text", text.len()),
            StoreContent::Binary(bytes) => ("binary", bytes.len()),
        };
        self.writes.lock().unwrap().push((
            write.session_id.to_owned(),
            write.tool_call_id.to_owned(),
            write.tool_name.to_owned(),
            write.retention.to_owned(),
            format!("{kind}:{}", write.content_type),
            write.extension.map(str::to_owned),
            length,
        ));
        Ok(StoreReceipt {
            bytes: length,
            uri: format!(
                "zcode-artifact://{}/a-{}",
                write.session_id, write.tool_call_id
            ),
        })
    }
}

fn request(op: &str, id: &str) -> ArtifactPublishRequest {
    ArtifactPublishRequest {
        run_id: "run-1".to_owned(),
        site_id: "site".to_owned(),
        ordinal: 2,
        op: op.to_owned(),
        id: id.to_owned(),
        version: 1,
        path: None,
        content: None,
        opts: None,
    }
}

fn file_request(path: &str, opts: Option<Value>) -> ArtifactPublishRequest {
    let mut req = request("file", "out");
    req.path = Some(path.to_owned());
    req.opts = opts;
    req
}

fn workspace_fs() -> Fs {
    let mut fs = Fs::default();
    fs.dirs.insert(PathBuf::from("/ws/root"));
    fs
}

fn deps<'a>(fs: &'a Fs, store: Option<&'a Store>) -> PublishDeps<'a> {
    PublishDeps {
        fs,
        store: store.map(|s| s as &dyn ArtifactStorePort),
        parent_session_id: Some("sess-parent"),
        cwd: Path::new("/ws/root"),
        now_ms: 1_700_000_000_000,
    }
}

fn error(result: Result<Value, WorkflowError>) -> WorkflowError {
    result.expect_err("an error")
}

// ——— The record and the store write ———

#[test]
fn a_markdown_publish_writes_text_and_returns_the_record_in_node_key_order() {
    let fs = workspace_fs();
    let store = Store::default();
    let mut req = request("markdown", "report");
    req.content = Some("# hi".to_owned());
    req.opts = Some(json!({"title": "Report", "description": "d"}));
    let record = execute_artifact_publish(&deps(&fs, Some(&store)), &req).unwrap();
    assert_eq!(
        stringify(&record),
        "{\"id\":\"report\",\"kind\":\"markdown\",\"version\":1,\"title\":\"Report\",\"description\":\"d\",\
         \"contentType\":\"text/markdown\",\"bytes\":4,\"uri\":\"zcode-artifact://sess-parent/a-run-1:site@2\",\
         \"publishedAt\":1700000000000}"
    );
    let writes = store.writes.lock().unwrap();
    assert_eq!(writes[0].0, "sess-parent");
    assert_eq!(writes[0].1, "run-1:site@2");
    assert_eq!(writes[0].2, "CreateWorkflow");
    assert_eq!(writes[0].3, "project");
    assert_eq!(writes[0].4, "text:text/markdown");
}

#[test]
fn a_file_publish_reads_the_workspace_file_and_takes_its_type_from_the_extension() {
    let mut fs = workspace_fs();
    fs.files
        .insert(PathBuf::from("/ws/root/sub/report.pdf"), b"%PDF".to_vec());
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let record = execute_artifact_publish(
        &deps(&fs, Some(&store)),
        &file_request("./sub/../sub/report.pdf", None),
    )
    .unwrap();
    assert_eq!(record["contentType"], "application/pdf");
    assert_eq!(record["sourcePath"], "sub/report.pdf");
    assert_eq!(record["bytes"], 4);
    let writes = store.writes.lock().unwrap();
    assert_eq!(writes[0].4, "binary:application/pdf");
    assert_eq!(writes[0].5.as_deref(), Some("pdf"));
}

#[test]
fn an_unknown_or_missing_extension_is_octet_stream_and_is_not_sniffed() {
    let mut fs = workspace_fs();
    fs.files.insert(
        PathBuf::from("/ws/root/data.zzz"),
        b"%PDF-looks-like-pdf".to_vec(),
    );
    fs.files
        .insert(PathBuf::from("/ws/root/Makefile"), b"all:".to_vec());
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let d = deps(&fs, Some(&store));
    assert_eq!(
        execute_artifact_publish(&d, &file_request("data.zzz", None)).unwrap()["contentType"],
        "application/octet-stream"
    );
    assert_eq!(
        execute_artifact_publish(&d, &file_request("Makefile", None)).unwrap()["contentType"],
        "application/octet-stream"
    );
}

#[test]
fn opts_content_type_overrides_the_table_and_parameters_are_refused() {
    let mut fs = workspace_fs();
    fs.files
        .insert(PathBuf::from("/ws/root/a.bin"), b"x".to_vec());
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let d = deps(&fs, Some(&store));
    let ok = execute_artifact_publish(
        &d,
        &file_request("a.bin", Some(json!({"contentType": "application/pdf"}))),
    )
    .unwrap();
    assert_eq!(ok["contentType"], "application/pdf");
    let bad = error(execute_artifact_publish(
        &d,
        &file_request(
            "a.bin",
            Some(json!({"contentType": "text/markdown; charset=utf-8"})),
        ),
    ));
    assert_eq!(bad.code, ErrorCode::DriverError);
    assert!(bad.message.starts_with(
        "artifact.file: opts.contentType 'text/markdown; charset=utf-8' is not a bare MIME type"
    ));
}

// ——— Paths ———

#[test]
fn a_path_that_leaves_the_workspace_is_refused_as_outside_the_workspace() {
    let fs = workspace_fs();
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let err = error(execute_artifact_publish(
        &deps(&fs, Some(&store)),
        &file_request("../x.pdf", None),
    ));
    assert_eq!(err.code, ErrorCode::ArtifactPathOutsideWorkspace);
    assert!(
        err.message
            .starts_with("artifact.file: path '../x.pdf' resolves outside the workspace")
    );
    let absolute = error(execute_artifact_publish(
        &deps(&fs, Some(&store)),
        &file_request("/etc/hosts", None),
    ));
    assert_eq!(absolute.code, ErrorCode::ArtifactPathOutsideWorkspace);
}

#[test]
fn a_symlink_inside_the_workspace_that_points_outside_is_judged_by_its_real_path() {
    let mut fs = workspace_fs();
    fs.links.insert(
        PathBuf::from("/ws/root/id_rsa"),
        PathBuf::from("/home/u/.ssh/id_rsa"),
    );
    fs.files
        .insert(PathBuf::from("/home/u/.ssh/id_rsa"), b"secret".to_vec());
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let err = error(execute_artifact_publish(
        &deps(&fs, Some(&store)),
        &file_request("id_rsa", None),
    ));
    assert_eq!(err.code, ErrorCode::ArtifactPathOutsideWorkspace);
    assert!(
        fs.reads.lock().unwrap().is_empty(),
        "nothing is read from outside"
    );
}

#[test]
fn a_symlink_inside_the_workspace_to_another_file_inside_is_published() {
    let mut fs = workspace_fs();
    fs.links.insert(
        PathBuf::from("/ws/root/alias.txt"),
        PathBuf::from("/ws/root/real.txt"),
    );
    fs.files
        .insert(PathBuf::from("/ws/root/real.txt"), b"hi".to_vec());
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let record =
        execute_artifact_publish(&deps(&fs, Some(&store)), &file_request("alias.txt", None))
            .unwrap();
    assert_eq!(record["sourcePath"], "alias.txt");
}

#[test]
fn a_missing_path_and_a_directory_are_both_source_missing() {
    let mut fs = workspace_fs();
    fs.dirs.insert(PathBuf::from("/ws/root/dir"));
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let d = deps(&fs, Some(&store));
    assert_eq!(
        error(execute_artifact_publish(
            &d,
            &file_request("nope.pdf", None)
        ))
        .code,
        ErrorCode::ArtifactSourceMissing
    );
    let dir = error(execute_artifact_publish(&d, &file_request("dir", None)));
    assert_eq!(dir.code, ErrorCode::ArtifactSourceMissing);
    assert!(
        dir.message
            .contains("does not exist or is not a regular file")
    );
}

#[test]
fn a_file_over_the_cap_is_rejected_and_never_truncated() {
    let mut fs = workspace_fs();
    fs.files.insert(
        PathBuf::from("/ws/root/big.bin"),
        vec![0; caps::MAX_FILE_BYTES + 1],
    );
    let store = Store {
        binary: true,
        ..Store::default()
    };
    let err = error(execute_artifact_publish(
        &deps(&fs, Some(&store)),
        &file_request("big.bin", None),
    ));
    assert_eq!(err.code, ErrorCode::ArtifactTooLarge);
    assert_eq!(
        err.message,
        "artifact.file: 'big.bin' is over the cap of 20971520 bytes. Publish a smaller artifact (a summary, a \
         slice, or a compressed version)."
    );
}

#[test]
fn a_port_too_large_report_is_the_same_error() {
    let mut fs = workspace_fs();
    fs.files.insert(PathBuf::from("/ws/root/x.bin"), vec![1]);
    fs.read_override = Some(FsFault::TooLarge);
    let store = Store {
        binary: true,
        ..Store::default()
    };
    assert_eq!(
        error(execute_artifact_publish(
            &deps(&fs, Some(&store)),
            &file_request("x.bin", None)
        ))
        .code,
        ErrorCode::ArtifactTooLarge
    );
}

// ——— Markdown size ———

#[test]
fn markdown_is_measured_in_utf8_bytes_and_exactly_the_cap_is_allowed() {
    let fs = workspace_fs();
    let store = Store::default();
    let mut at_cap = request("markdown", "m");
    at_cap.content = Some("a".repeat(caps::MAX_MARKDOWN_BYTES));
    assert!(execute_artifact_publish(&deps(&fs, Some(&store)), &at_cap).is_ok());

    let mut over = request("markdown", "m");
    over.content = Some("a".repeat(caps::MAX_MARKDOWN_BYTES + 1));
    assert_eq!(
        error(execute_artifact_publish(&deps(&fs, Some(&store)), &over)).code,
        ErrorCode::ArtifactTooLarge
    );

    // Two bytes per character: 131,073 characters are 262,146 bytes, over the cap.
    let mut multibyte = request("markdown", "m");
    multibyte.content = Some("\u{00e9}".repeat(131_073));
    assert_eq!(
        error(execute_artifact_publish(
            &deps(&fs, Some(&store)),
            &multibyte
        ))
        .code,
        ErrorCode::ArtifactTooLarge
    );
}

// ——— Options ———

#[test]
fn title_and_description_must_be_strings_and_are_not_coerced() {
    let fs = workspace_fs();
    let store = Store::default();
    let mut req = request("markdown", "m");
    req.content = Some(String::new());
    req.opts = Some(json!({"title": 3}));
    assert_eq!(
        error(execute_artifact_publish(&deps(&fs, Some(&store)), &req)).message,
        "artifact.markdown: opts.title must be a string, got number."
    );
}

#[test]
fn an_over_long_title_is_rejected_and_its_length_is_utf16_units() {
    let fs = workspace_fs();
    let store = Store::default();
    let mut req = request("markdown", "m");
    req.content = Some(String::new());
    // 60 astral characters are 120 UTF-16 units: at the cap, allowed.
    req.opts = Some(json!({"title": "\u{1F600}".repeat(60)}));
    assert!(execute_artifact_publish(&deps(&fs, Some(&store)), &req).is_ok());
    req.opts = Some(json!({"title": "\u{1F600}".repeat(61)}));
    let err = error(execute_artifact_publish(&deps(&fs, Some(&store)), &req));
    assert_eq!(err.code, ErrorCode::ArtifactTooLarge);
    assert_eq!(
        err.message,
        "artifact.markdown: opts.title is 122 characters, over the cap of 120. Shorten it."
    );
}

#[test]
fn unknown_opts_keys_are_ignored_and_a_non_object_opts_is_refused() {
    let fs = workspace_fs();
    let store = Store::default();
    let mut req = request("markdown", "m");
    req.content = Some(String::new());
    req.opts = Some(json!({"unknown": true}));
    assert!(execute_artifact_publish(&deps(&fs, Some(&store)), &req).is_ok());
    req.opts = Some(json!([]));
    assert_eq!(
        error(execute_artifact_publish(&deps(&fs, Some(&store)), &req)).message,
        "artifact.markdown: opts must be an options object, got array. Pass an object or omit the argument."
    );
}

#[test]
fn an_invalid_id_is_a_driver_error_because_it_is_a_wiring_error() {
    let fs = workspace_fs();
    let store = Store::default();
    let mut req = request("markdown", "bad id");
    req.content = Some(String::new());
    let err = error(execute_artifact_publish(&deps(&fs, Some(&store)), &req));
    assert_eq!(err.code, ErrorCode::DriverError);
    assert_eq!(
        err.message,
        "artifact.markdown: id 'bad id' is not a valid artifact id. Use at most 64 characters from [A-Za-z0-9_.-]."
    );
}

// ——— Store ———

#[test]
fn no_store_is_refused_before_any_file_is_read() {
    let mut fs = workspace_fs();
    fs.files
        .insert(PathBuf::from("/ws/root/a.pdf"), b"x".to_vec());
    let err = error(execute_artifact_publish(
        &deps(&fs, None),
        &file_request("a.pdf", None),
    ));
    assert_eq!(err.code, ErrorCode::ArtifactStoreUnavailable);
    assert_eq!(
        err.message,
        "artifact.file: cannot publish \"out\" because this assembly has no artifact store."
    );
    assert!(
        fs.reads.lock().unwrap().is_empty(),
        "no source is read without a store"
    );
}

#[test]
fn a_text_only_store_publishes_markdown_but_refuses_files() {
    let mut fs = workspace_fs();
    fs.files
        .insert(PathBuf::from("/ws/root/a.pdf"), b"x".to_vec());
    let store = Store::default();
    let d = deps(&fs, Some(&store));
    let err = error(execute_artifact_publish(&d, &file_request("a.pdf", None)));
    assert_eq!(err.code, ErrorCode::ArtifactStoreUnavailable);
    assert_eq!(
        err.message,
        "artifact.file: cannot publish \"out\" because this assembly's artifact store does not support binary writes."
    );
    let mut md = request("markdown", "m");
    md.content = Some("x".to_owned());
    assert!(execute_artifact_publish(&d, &md).is_ok());
}

#[test]
fn a_store_without_a_parent_session_is_unavailable_and_nothing_is_guessed() {
    let fs = workspace_fs();
    let store = Store::default();
    let mut d = deps(&fs, Some(&store));
    d.parent_session_id = None;
    let mut md = request("markdown", "m");
    md.content = Some("x".to_owned());
    let err = error(execute_artifact_publish(&d, &md));
    assert_eq!(err.code, ErrorCode::ArtifactStoreUnavailable);
    assert!(err.message.ends_with("(parent session id not wired)."));
    assert!(store.writes.lock().unwrap().is_empty());
}

#[test]
fn a_store_write_failure_is_a_driver_error_that_carries_the_reason() {
    let fs = workspace_fs();
    let store = Store {
        fail: Some("disk full".to_owned()),
        ..Store::default()
    };
    let mut md = request("markdown", "m");
    md.content = Some("x".to_owned());
    let err = error(execute_artifact_publish(&deps(&fs, Some(&store)), &md));
    assert_eq!(err.code, ErrorCode::DriverError);
    assert_eq!(
        err.message,
        "artifact.markdown: writing \"m\" v1 to the artifact store failed: disk full"
    );
}

// ——— Pure helpers ———

#[test]
fn the_extension_table_and_the_file_extension_rule_match_node() {
    assert_eq!(extension_content_type("md"), Some("text/markdown"));
    assert_eq!(
        extension_content_type("xlsx"),
        Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    );
    assert_eq!(extension_content_type("bin"), None);
    assert_eq!(
        file_extension(Path::new("archive.tar.gz")),
        Some("gz".to_owned())
    );
    assert_eq!(file_extension(Path::new(".gitignore")), None);
    assert_eq!(file_extension(Path::new("Makefile")), None);
    assert_eq!(file_extension(Path::new("trailing.")), None);
    assert_eq!(
        file_extension(Path::new("Report.PDF")),
        Some("pdf".to_owned())
    );
    assert_eq!(file_extension(Path::new("report.v2 final")), None);
}
