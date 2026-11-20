use super::*;

#[test]
fn a_written_file_reads_back_and_creates_its_directories() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let path = dir.path().join("a/b/c.txt");
    write_text(&path, "hello\n").expect("write");
    assert_eq!(read_text(&path).expect("read"), "hello\n");
    assert!(is_file(&path));
    assert!(!is_file(&dir.path().join("a")));
    assert_eq!(
        list_file_names(&dir.path().join("a/b")).expect("list"),
        ["c.txt"]
    );
}

#[test]
fn a_missing_directory_lists_as_not_found() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let error = list_file_names(&dir.path().join("absent")).expect_err("absent");
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_regular_file_is_a_file_and_a_broken_link_is_not() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let target = dir.path().join("target.txt");
    write_text(&target, "x").expect("write");
    let link = dir.path().join("link.txt");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    assert!(is_file(&link));
    let broken = dir.path().join("broken.txt");
    std::os::unix::fs::symlink(dir.path().join("absent"), &broken).expect("symlink");
    assert!(!is_file(&broken));
}

// APFS refuses a non-UTF-8 file name (EILSEQ), so this runs where the file system allows one (Linux).
#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn a_non_utf8_name_lists_with_replacement_characters() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::TempDir::new().expect("tempdir");
    let name = OsStr::from_bytes(b"bad\xffname.dwf.ts");
    std::fs::write(dir.path().join(name), "x").expect("write");
    let names = list_file_names(dir.path()).expect("list");
    assert_eq!(names, ["bad\u{FFFD}name.dwf.ts"]);
}
