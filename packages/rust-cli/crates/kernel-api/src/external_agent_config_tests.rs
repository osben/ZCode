use serde_json::json;

use super::*;

/// Node's `canonicalExternalAgentConfig` field order with `null` for an absent agent field.
#[test]
fn options_keep_the_canonical_shape() {
    let options = vec![ExternalAgentConfigOption {
        id: "model".into(),
        name: "Model".into(),
        description: None,
        category: Some("model".into()),
        current_value: "m1".into(),
        options: vec![ExternalAgentConfigValue {
            value: "m1".into(),
            name: "Model 1".into(),
            description: None,
            group: None,
        }],
    }];
    let encoded = options_to_json(&options);
    assert_eq!(
        encoded.to_string(),
        r#"[{"id":"model","name":"Model","description":null,"category":"model","currentValue":"m1","options":[{"value":"m1","name":"Model 1","description":null,"group":null}]}]"#
    );
    assert_eq!(options_from_json(&encoded), Some(options.clone()));
    assert!(options[0].offers("m1"));
    assert!(!options[0].offers("m2"));
    assert_eq!(options[0].value_name("m1"), "Model 1");
    assert_eq!(options[0].value_name("m9"), "m9");
}

#[test]
fn a_malformed_list_reads_as_none() {
    assert_eq!(options_from_json(&json!({"id": "model"})), None);
    assert_eq!(options_from_json(&json!([{"id": "model"}])), None);
}
