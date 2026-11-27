use serde_json::json;

use super::*;

#[test]
fn only_a_bare_claude_model_id_is_first_party() {
    assert!(is_first_party_model("claude-opus-5-5"));
    assert!(!is_first_party_model("anthropic/claude-opus-5-5"));
    assert!(!is_first_party_model("glm-5.3"));
}

#[test]
fn an_object_gets_closed_and_constraints_fold_into_the_description() {
    let schema = json!({
        "type": "object",
        "properties": {
            "count": {"type": "integer", "minimum": 1, "maximum": 5},
            "name": {"type": "string", "description": "a name", "minLength": 2, "pattern": "^a", "format": "slug"},
            "when": {"type": "string", "format": "date-time"},
            "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1, "default": []},
        },
        "required": ["count"],
    });
    let strict = to_strict_schema(&schema).expect("eligible");
    assert_eq!(
        strict,
        json!({
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "minimum 1; maximum 5"},
                "name": {"type": "string", "description": "a name (at least 2 characters; must match /^a/; format slug)"},
                "when": {"type": "string", "format": "date-time"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "at least 1 items; default []"},
            },
            "required": ["count"],
            "additionalProperties": false,
        })
    );
}

#[test]
fn an_object_without_properties_gets_an_empty_set() {
    assert_eq!(
        to_strict_schema(&json!({"type": "object"})),
        Some(json!({"type": "object", "additionalProperties": false, "properties": {}}))
    );
}

#[test]
fn whole_numbers_print_without_a_fraction_and_others_keep_theirs() {
    let schema = json!({"type": "number", "minimum": 2.0, "maximum": 2.5});
    assert_eq!(
        to_strict_schema(&schema),
        Some(json!({"type": "number", "description": "minimum 2; maximum 2.5"}))
    );
}

#[test]
fn combinator_branches_are_folded_too() {
    let schema = json!({"anyOf": [{"type": "string", "maxLength": 3}, {"type": "null"}]});
    assert_eq!(
        to_strict_schema(&schema),
        Some(
            json!({"anyOf": [{"type": "string", "description": "at most 3 characters"}, {"type": "null"}]})
        )
    );
}

#[test]
fn shapes_the_subset_cannot_express_make_the_schema_ineligible() {
    for schema in [
        json!({"$ref": "#/$defs/a"}),
        json!({"type": "object", "properties": {"a": {"$ref": "#/$defs/a"}}, "$defs": {}}),
        json!({"type": "array", "prefixItems": [{"type": "string"}]}),
        json!({"type": "object", "additionalProperties": {"type": "string"}}),
        json!({"type": "object", "properties": {"any": {}}}),
        json!({"type": "object", "properties": {"bad": true}}),
        json!(true),
    ] {
        assert_eq!(to_strict_schema(&schema), None, "{schema}");
    }
}
