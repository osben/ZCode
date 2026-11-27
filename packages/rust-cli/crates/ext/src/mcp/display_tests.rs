//! Fork: the `mcp_tool` display and the UI descriptor (specs/fork-rust-plugin-ui-tool-result.md, rules 1 to 5).
use serde_json::{Value, json};

use super::{Presentation, display, tool_ui};

fn built(meta: Value, plugin: Option<&str>, output: Value) -> Value {
    let ui = tool_ui(Some(&meta));
    display(
        &Presentation {
            server: "plugin:viewer:docs",
            tool: "open_editor",
            description: Some("  Opens the editor.  "),
            plugin_id: plugin,
            ui: ui.as_ref(),
        },
        &output,
    )
}

fn ui_of(meta: Value, output: Value) -> Value {
    built(meta, Some("viewer@market"), output)["ui"].clone()
}

#[test]
fn resource_uri_comes_from_three_places_in_order() {
    let modern = json!({"ui": {"resourceUri": "ui://a"}, "ui/resourceUri": "ui://b", "openai/outputTemplate": "ui://c"});
    assert_eq!(ui_of(modern, json!({}))["resourceUri"], "ui://a");
    let flat = json!({"ui/resourceUri": " ui://b ", "openai/outputTemplate": "ui://c"});
    assert_eq!(ui_of(flat, json!({}))["resourceUri"], "ui://b");
    let template = json!({"openai/outputTemplate": "ui://c"});
    assert_eq!(ui_of(template, json!({}))["resourceUri"], "ui://c");
    // A wrong scheme or a too long URI is skipped and the next source is read.
    let skipped = json!({"ui": {"resourceUri": "https://x"}, "ui/resourceUri": "ui://b"});
    assert_eq!(ui_of(skipped, json!({}))["resourceUri"], "ui://b");
    let long = format!("ui://{}", "a".repeat(2050));
    assert!(ui_of(json!({"ui": {"resourceUri": long}}), json!({})).is_null());
}

#[test]
fn no_valid_resource_uri_means_no_ui_but_still_a_display() {
    let shown = built(json!({"ui": {"visibility": ["app"]}}), None, json!({}));
    assert_eq!(
        shown,
        json!({"kind": "mcp_tool", "serverName": "plugin:viewer:docs", "toolName": "open_editor",
               "description": "Opens the editor."})
    );
    assert!(tool_ui(None).is_none());
    assert!(tool_ui(Some(&json!("text"))).is_none());
}

#[test]
fn ui_carries_exactly_the_schema_fields_and_never_visibility() {
    let meta = json!({
        "ui": {"resourceUri": "ui://a", "visibility": ["model", "app"], "prefersBorder": false,
               "surface": " panel.one ", "showInline": true,
               "csp": {"connectDomains": ["https://api.test", "https://api.test", "http://example.test", "http://127.0.0.1:9"]}},
        "openai/ui": {"preferredModelDisplayMode": "pip"},
    });
    let ui = ui_of(meta, json!({}));
    assert_eq!(
        ui,
        json!({"pluginId": "viewer@market", "resourceUri": "ui://a", "preferredDisplayMode": "pip",
               "prefersBorder": false,
               "csp": {"connectDomains": ["https://api.test", "http://127.0.0.1:9"]},
               "surface": "panel.one", "showInline": true})
    );
    assert!(ui.get("visibility").is_none());
}

#[test]
fn openai_aliases_fill_the_gaps() {
    let meta = json!({
        "openai/outputTemplate": "ui://a",
        "openai/widgetPrefersBorder": true,
        "openai/widgetShowCodexWidgetInline": true,
        "openai/widgetCSP": {"connect_domains": ["wss://sock.test"], "frameDomains": ["https://f.test"],
                             "base_uri_domains": []},
        "ui": {"showInline": false},
    });
    let ui = ui_of(meta, json!({}));
    assert_eq!(ui["prefersBorder"], true);
    // `ui.showInline: false` wins over the alias, and a false value is not projected.
    assert!(ui.get("showInline").is_none());
    assert_eq!(
        ui["csp"],
        json!({"connectDomains": ["wss://sock.test"], "frameDomains": ["https://f.test"], "baseUriDomains": []})
    );
}

#[test]
fn invalid_surface_and_origins_are_dropped() {
    let meta = json!({"ui": {"resourceUri": "ui://a", "surface": "-bad",
        "csp": {"resourceDomains": ["https://u:p@x.test", "https://x.test/path", "https://x.test?q=1", "https://x.test#h", "ftp://x.test", "nope", 3]}}});
    let ui = ui_of(meta, json!({}));
    assert!(ui.get("surface").is_none());
    assert_eq!(ui["csp"], json!({"resourceDomains": []}));
    let origin = json!({"ui": {"resourceUri": "ui://a", "csp": {"resourceDomains": ["https://x.test:8443/", "https://X.test"]}}});
    assert_eq!(
        ui_of(origin, json!({}))["csp"],
        json!({"resourceDomains": ["https://x.test:8443", "https://x.test"]})
    );
}

#[test]
fn result_fields_are_json_text_and_is_error_is_marked() {
    let output = json!({
        "structuredContent": {"b": 1, "a": [true, null]},
        "_meta": {"k": "v"},
        "content": [{"type": "text", "text": "hi"}],
        "isError": true,
    });
    let ui = ui_of(json!({"ui": {"resourceUri": "ui://a"}}), output);
    assert_eq!(ui["structuredContent"], "{\"b\":1,\"a\":[true,null]}");
    assert_eq!(ui["widgetMeta"], "{\"k\":\"v\"}");
    assert_eq!(ui["content"], "[{\"type\":\"text\",\"text\":\"hi\"}]");
    assert_eq!(ui["isError"], true);
    assert!(ui.get("truncated").is_none());
    // `content` counts only as an array; null and a missing key are omitted; `isError: false` is not projected.
    let plain = ui_of(
        json!({"ui": {"resourceUri": "ui://a"}}),
        json!({"content": "text", "structuredContent": null, "isError": false}),
    );
    assert!(plain.get("content").is_none());
    assert!(plain.get("structuredContent").is_none());
    assert!(plain.get("isError").is_none());
}

#[test]
fn an_oversized_field_is_dropped_whole_and_counted() {
    let big = "x".repeat(65 * 1024);
    let widget = "y".repeat(17 * 1024);
    let output = json!({
        "structuredContent": {"s": big},
        "_meta": {"w": widget},
        "content": [{"type": "text", "text": "ok"}],
    });
    let ui = ui_of(json!({"ui": {"resourceUri": "ui://a"}}), output.clone());
    assert!(ui.get("structuredContent").is_none());
    assert!(ui.get("widgetMeta").is_none());
    assert_eq!(ui["content"], "[{\"type\":\"text\",\"text\":\"ok\"}]");
    assert_eq!(ui["truncated"], true);
    let omitted = serde_json::to_string(&output["structuredContent"])
        .unwrap()
        .len()
        + serde_json::to_string(&output["_meta"]).unwrap().len();
    assert_eq!(ui["truncatedBytes"], omitted);
    // The limit is in bytes: 9000 two-byte characters are 18 KB of text, over the 16 KiB widget limit.
    let multi = "é".repeat(9 * 1000);
    let at = ui_of(
        json!({"ui": {"resourceUri": "ui://a"}}),
        json!({"_meta": {"w": multi}}),
    );
    assert_eq!(at["truncated"], true);
}

#[test]
fn plugin_id_falls_back_to_the_server_name_and_names_are_bounded() {
    let meta = json!({"ui": {"resourceUri": "ui://a"}});
    assert_eq!(
        built(meta.clone(), None, json!({}))["ui"]["pluginId"],
        "plugin:viewer:docs"
    );
    // Node binds `pluginId ?? serverName` and drops `ui` when the bounded id is empty.
    assert!(
        built(meta.clone(), Some("  "), json!({}))
            .get("ui")
            .is_none()
    );
    let ui = tool_ui(Some(&meta));
    let long = "é".repeat(300);
    let description = "d".repeat(5000);
    let shown = display(
        &Presentation {
            server: &long,
            tool: "t",
            description: Some(&description),
            plugin_id: None,
            ui: ui.as_ref(),
        },
        &json!({}),
    );
    assert_eq!(shown["serverName"].as_str().unwrap().chars().count(), 256);
    assert_eq!(shown["description"].as_str().unwrap().len(), 4096);
    assert_eq!(
        shown["ui"]["pluginId"].as_str().unwrap().chars().count(),
        256
    );
    // An empty server or tool name is no display.
    let none = display(
        &Presentation {
            server: " ",
            tool: "t",
            description: None,
            plugin_id: None,
            ui: None,
        },
        &json!({}),
    );
    assert!(none.is_null());
}

#[test]
fn a_cut_never_splits_a_surrogate_pair() {
    // 255 units of "a" then an astral character (two units): the pair does not fit in 256 units.
    let name = format!("{}{}", "a".repeat(255), "\u{1F600}");
    let shown = display(
        &Presentation {
            server: &name,
            tool: "t",
            description: None,
            plugin_id: None,
            ui: None,
        },
        &json!({}),
    );
    assert_eq!(shown["serverName"], "a".repeat(255));
}
