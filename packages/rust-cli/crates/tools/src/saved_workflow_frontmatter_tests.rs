//! Goldens are Node's output: `yaml` 2.9.1 `stringify` of the body `serializeSavedWorkflow` builds (the bodies are in
//! `saved-workflows-store.test.ts` and `saved-workflow-frontmatter-offset.test.ts`).

use super::*;

fn meta_with_args(args: Vec<(&str, ArgDecl)>) -> Meta {
    Meta {
        description: "d".to_owned(),
        when_to_use: None,
        args: Some(args.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()),
    }
}

fn arg(ty: ArgType) -> ArgDecl {
    ArgDecl {
        ty,
        description: None,
        required: None,
        default: None,
    }
}

#[test]
fn the_block_matches_node_for_a_plain_declaration() {
    let meta = Meta {
        description: "Review a pull request".to_owned(),
        when_to_use: Some("When the user asks for a PR review".to_owned()),
        args: Some(vec![(
            "pr".to_owned(),
            ArgDecl {
                ty: ArgType::String,
                description: Some("PR number".to_owned()),
                required: Some(true),
                default: None,
            },
        )]),
    };
    assert_eq!(
        serialize(&meta, "return 1;"),
        "/* zcode-workflow\n\
         description: Review a pull request\n\
         whenToUse: When the user asks for a PR review\n\
         args:\n\
         \x20 pr:\n\
         \x20   type: string\n\
         \x20   description: PR number\n\
         \x20   required: true\n\
         */\n\
         return 1;"
    );
}

#[test]
fn a_number_default_is_written_plain() {
    let mut limit = arg(ArgType::Number);
    limit.default = Some(json!(10));
    let meta = Meta {
        description: "Triage the inbox".to_owned(),
        when_to_use: Some("Every morning".to_owned()),
        args: Some(vec![("limit".to_owned(), limit)]),
    };
    assert_eq!(
        serialize(&meta, ""),
        "/* zcode-workflow\n\
         description: Triage the inbox\n\
         whenToUse: Every morning\n\
         args:\n\
         \x20 limit:\n\
         \x20   type: number\n\
         \x20   default: 10\n\
         */\n"
    );
}

#[test]
fn strings_that_yaml_would_misread_are_quoted_as_node_quotes_them() {
    let cases: [(&str, &str); 12] = [
        ("Deploy: staging a/b", "\"Deploy: staging a/b\""),
        ("Say \"hi\" and 'bye'", "Say \"hi\" and 'bye'"),
        ("  padded  ", "\"  padded  \""),
        ("# not a comment", "\"# not a comment\""),
        ("yes", "yes"),
        ("123", "\"123\""),
        ("null", "\"null\""),
        ("Проверка PR — готово", "Проверка PR — готово"),
        ("- item", "\"- item\""),
        ("? x", "\"? x\""),
        ("[a, b]", "\"[a, b]\""),
        ("{a: 1}", "\"{a: 1}\""),
    ];
    for (text, expected) in cases {
        let meta = Meta {
            description: text.to_owned(),
            when_to_use: None,
            args: None,
        };
        assert_eq!(
            serialize(&meta, ""),
            format!("/* zcode-workflow\ndescription: {expected}\n*/\n"),
            "description {text:?}"
        );
    }
}

#[test]
fn a_string_with_a_colon_and_double_quotes_is_single_quoted() {
    let mut q = arg(ArgType::String);
    q.description = Some("has: colon and \"quote\"".to_owned());
    let meta = meta_with_args(vec![("q", q)]);
    assert_eq!(
        serialize(&meta, ""),
        "/* zcode-workflow\ndescription: d\nargs:\n  q:\n    type: string\n    description: 'has: colon and \"quote\"'\n*/\n"
    );
}

#[test]
fn an_empty_args_declaration_is_written_as_an_empty_flow_map() {
    let meta = Meta {
        description: "d".to_owned(),
        when_to_use: None,
        args: Some(Vec::new()),
    };
    assert_eq!(
        serialize(&meta, ""),
        "/* zcode-workflow\ndescription: d\nargs: {}\n*/\n"
    );
}

#[test]
fn every_argument_type_and_default_is_written_as_node_writes_it() {
    let mut s = arg(ArgType::String);
    s.default = Some(json!("x:y"));
    let mut n = arg(ArgType::Number);
    n.default = Some(json!(3.5));
    let mut b = arg(ArgType::Boolean);
    b.default = Some(json!(true));
    b.required = Some(false);
    let mut j = arg(ArgType::Json);
    j.default = Some(json!({"a": [1, 2], "b": null}));
    let mut z = arg(ArgType::Json);
    z.default = Some(Value::Null);
    let mut e = arg(ArgType::String);
    e.default = Some(json!(""));
    let meta = meta_with_args(vec![
        ("s", s),
        ("n", n),
        ("b", b),
        ("j", j),
        ("z", z),
        ("e", e),
    ]);
    assert_eq!(
        serialize(&meta, ""),
        "/* zcode-workflow\n\
         description: d\n\
         args:\n\
         \x20 s:\n\
         \x20   type: string\n\
         \x20   default: x:y\n\
         \x20 n:\n\
         \x20   type: number\n\
         \x20   default: 3.5\n\
         \x20 b:\n\
         \x20   type: boolean\n\
         \x20   required: false\n\
         \x20   default: true\n\
         \x20 j:\n\
         \x20   type: json\n\
         \x20   default:\n\
         \x20     a:\n\
         \x20       - 1\n\
         \x20       - 2\n\
         \x20     b: null\n\
         \x20 z:\n\
         \x20   type: json\n\
         \x20   default: null\n\
         \x20 e:\n\
         \x20   type: string\n\
         \x20   default: \"\"\n\
         */\n"
    );
}

#[test]
fn the_script_follows_the_block_byte_for_byte() {
    let script = "line one\n\n  indented  \n";
    let text = serialize(
        &Meta {
            description: "d".to_owned(),
            when_to_use: None,
            args: None,
        },
        script,
    );
    assert!(text.ends_with("*/\nline one\n\n  indented  \n"));
    let parsed = parse(&text).expect("the file we wrote parses");
    assert_eq!(parsed.script, script);
}

#[test]
fn a_written_block_reads_back_to_the_same_metadata() {
    let mut limit = arg(ArgType::Number);
    limit.default = Some(json!(10));
    limit.description = Some("a: b".to_owned());
    let mut j = arg(ArgType::Json);
    j.default = Some(json!({"k": ["v", 1, false]}));
    let meta = Meta {
        description: "Triage: the inbox".to_owned(),
        when_to_use: Some("123".to_owned()),
        args: Some(vec![("limit".to_owned(), limit), ("j".to_owned(), j)]),
    };
    let parsed = parse(&serialize(&meta, "return 1;")).expect("parses");
    assert_eq!(parsed.meta, meta);
    assert_eq!(parsed.script, "return 1;");
}

#[test]
fn the_body_line_offset_counts_leading_blanks_the_marker_the_yaml_and_the_terminator() {
    let source = "\n\n/* zcode-workflow\ndescription: x\n*/\nbody\n";
    let parsed = parse(source).expect("parses");
    assert_eq!(parsed.body_line_offset, 5);
    assert_eq!(parsed.script, "body\n");
}

#[test]
fn a_multi_line_args_block_keeps_the_offset_right() {
    let source = "/* zcode-workflow\ndescription: x\nargs:\n  a:\n    type: string\n    required: true\n*/\nreturn 2;";
    let parsed = parse(source).expect("parses");
    // Lines 0 to 6 hold the marker, the YAML and the terminator, so the script starts at line 7.
    assert_eq!(parsed.body_line_offset, 7);
}

#[test]
fn a_missing_marker_is_named() {
    let error = parse("return 1;").unwrap_err();
    assert_eq!(error.reason(), "missing_frontmatter");
    assert_eq!(
        error.detail(),
        "file does not start with the `/* zcode-workflow` metadata block"
    );
}

#[test]
fn an_unterminated_block_is_named() {
    let error = parse("/* zcode-workflow\ndescription: x\nreturn 1;").unwrap_err();
    assert_eq!(error.reason(), "unterminated_frontmatter");
    assert_eq!(error.detail(), "metadata block is never closed with `*/`");
}

#[test]
fn a_body_that_is_not_yaml_is_named() {
    let error = parse("/* zcode-workflow\ndescription: [unclosed\n*/\n").unwrap_err();
    assert_eq!(error.reason(), "invalid_yaml");
}

#[test]
fn a_body_that_is_yaml_but_not_valid_metadata_is_named() {
    let error = parse("/* zcode-workflow\nwhenToUse: x\n*/\n").unwrap_err();
    assert_eq!(error.reason(), "invalid_metadata");
    assert!(error.detail().contains("description"), "{}", error.detail());
}

#[test]
fn an_unknown_metadata_key_is_rejected() {
    let error = parse("/* zcode-workflow\ndescription: x\ndescripton: typo\n*/\n").unwrap_err();
    assert_eq!(error.reason(), "invalid_metadata");
    assert!(error.detail().contains("descripton"), "{}", error.detail());
}

#[test]
fn an_argument_with_an_unknown_type_is_rejected() {
    let error =
        parse("/* zcode-workflow\ndescription: x\nargs:\n  a:\n    type: date\n*/\n").unwrap_err();
    assert_eq!(error.reason(), "invalid_metadata");
}

#[test]
fn an_empty_description_is_rejected() {
    let error = parse("/* zcode-workflow\ndescription: \"\"\n*/\n").unwrap_err();
    assert_eq!(error.reason(), "invalid_metadata");
}

// Goldens below were taken from Node's `yaml` 2.9.1 `stringify` (see the review round of W7-8b).

#[test]
fn nested_sequences_are_written_compact_as_node_writes_them() {
    let mut j = arg(ArgType::Json);
    j.default = Some(json!({"a": [[1, 2], [3], []]}));
    let meta = meta_with_args(vec![("j", j)]);
    assert_eq!(
        serialize(&meta, ""),
        "/* zcode-workflow\ndescription: d\nargs:\n  j:\n    type: json\n    default:\n      a:\n        - - 1\n          - 2\n        - - 3\n        - []\n*/\n"
    );
}

#[test]
fn numbers_are_written_with_javascript_string_conversion() {
    let mut j = arg(ArgType::Json);
    j.default = Some(json!([
        1e21,
        1e-7,
        1.5e-7,
        0.000001,
        -2.5e-9,
        1.2345678901234568e20
    ]));
    let meta = meta_with_args(vec![("j", j)]);
    let text = serialize(&meta, "");
    assert!(text.contains("      - 1e+21\n      - 1e-7\n      - 1.5e-7\n      - 0.000001\n      - -2.5e-9\n      - 123456789012345680000\n"), "{text}");
}

#[test]
fn u0085_is_double_quoted_and_the_other_line_separators_stay_plain_as_node_writes_them() {
    let meta = |text: &str| Meta {
        description: text.to_owned(),
        when_to_use: None,
        args: None,
    };
    assert_eq!(
        serialize(&meta("a\u{85}b"), ""),
        "/* zcode-workflow\ndescription: \"a\u{85}b\"\n*/\n"
    );
    assert_eq!(
        serialize(&meta("a\u{2028}b"), ""),
        "/* zcode-workflow\ndescription: a\u{2028}b\n*/\n"
    );
    assert_eq!(
        serialize(&meta("a\u{2029}b"), ""),
        "/* zcode-workflow\ndescription: a\u{2029}b\n*/\n"
    );
}

#[test]
fn an_argument_description_may_be_empty_but_a_block_description_may_not() {
    let mut q = arg(ArgType::String);
    q.description = Some(String::new());
    let meta = meta_with_args(vec![("q", q)]);
    let parsed = parse(&serialize(&meta, "")).expect("an empty argument description parses");
    assert_eq!(parsed.meta, meta);
    let error = parse("/* zcode-workflow\ndescription: \"\"\n*/\n").unwrap_err();
    assert_eq!(error.reason(), "invalid_metadata");
}

#[test]
fn a_byte_order_mark_before_the_block_is_ignored() {
    let parsed = parse("\u{feff}/* zcode-workflow\ndescription: x\n*/\nbody").expect("parses");
    assert_eq!(parsed.script, "body");
    assert_eq!(parsed.body_line_offset, 3);
}

#[test]
fn a_second_yaml_document_is_named_with_its_line_as_node_names_it() {
    let error = parse("/* zcode-workflow\ndescription: x\n---\ndescription: y\n*/\n").unwrap_err();
    assert_eq!(error.reason(), "invalid_yaml");
    assert_eq!(
        error.detail(),
        "Source contains multiple documents; please use YAML.parseAllDocuments() at line 2, column 1:\n\ndescription: x\n---\n^\n"
    );
}

#[test]
fn yaml_core_booleans_and_nulls_are_quoted_as_node_quotes_them() {
    for word in [
        "True", "TRUE", "False", "FALSE", "Null", "NULL", "true", "null", "~",
    ] {
        let meta = Meta {
            description: word.to_owned(),
            when_to_use: None,
            args: None,
        };
        assert_eq!(
            serialize(&meta, ""),
            format!("/* zcode-workflow\ndescription: \"{word}\"\n*/\n"),
            "{word}"
        );
    }
}

// Review round (post-merge): round-trip red tests for characters a YAML line reader may fold or reject.

fn description_round_trips(text: &str) -> String {
    let meta = Meta {
        description: text.to_owned(),
        when_to_use: None,
        args: None,
    };
    let written = serialize(&meta, "");
    let parsed =
        parse(&written).unwrap_or_else(|e| panic!("{text:?} does not parse: {e:?}\n{written}"));
    assert_eq!(parsed.meta.description, text, "{written}");
    written
}

#[test]
fn a_line_separator_or_paragraph_separator_round_trips_in_plain_and_quoted_forms() {
    for text in ["a\u{2028}b", "a\u{2029}b", "a\u{2028}\"b", "a\u{2029}'\"b"] {
        description_round_trips(text);
    }
}

#[test]
fn nel_with_a_double_quote_is_double_quoted_never_single_quoted() {
    description_round_trips("a\u{85}b");
    let written = description_round_trips("a\u{85}\"b");
    assert_eq!(
        written,
        "/* zcode-workflow\ndescription: \"a\u{85}\\\"b\"\n*/\n"
    );
}

#[test]
fn c1_controls_round_trip_and_are_written_as_hex_escapes() {
    for code in (0x80u32..=0x9f).filter(|c| *c != 0x85) {
        let c = char::from_u32(code).unwrap();
        let written = description_round_trips(&format!("a{c}b"));
        assert!(
            written.contains(&format!("\\x{code:02X}")),
            "U+{code:04X} not escaped: {written:?}"
        );
        assert!(!written.contains(c), "raw U+{code:04X} in {written:?}");
        let quoted = description_round_trips(&format!("a{c}\"b"));
        assert!(
            quoted.contains(&format!("\\x{code:02X}")),
            "U+{code:04X} in quotes not escaped: {quoted:?}"
        );
    }
}
