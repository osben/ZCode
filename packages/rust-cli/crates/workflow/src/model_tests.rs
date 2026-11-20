//! `js_number` writes a JS number the way `JSON.stringify` does: an integral value prints without a fraction.

use super::js_number;

fn text(value: f64) -> String {
    serde_json::to_string(&js_number(value)).expect("a JSON value serializes")
}

#[test]
fn integral_numbers_serialize_as_integers_like_json_stringify() {
    assert_eq!(text(0.0), "0");
    assert_eq!(text(-0.0), "0");
    assert_eq!(text(3.0), "3");
    assert_eq!(text(-17.0), "-17");
    assert_eq!(text(9_007_199_254_740_991.0), "9007199254740991", "2^53 - 1");
}

#[test]
fn fractions_stay_fractions_and_non_finite_values_are_null() {
    assert_eq!(text(1.5), "1.5");
    assert_eq!(text(0.25), "0.25");
    assert_eq!(text(f64::NAN), "null");
    assert_eq!(text(f64::INFINITY), "null");
    assert_eq!(text(f64::NEG_INFINITY), "null");
}

#[test]
fn integral_values_past_the_safe_range_keep_the_float_form() {
    // Past 2^53 the value is not an exact integer in JS either; it still serializes as a number, not null.
    assert!(text(1e300).parse::<f64>().is_ok());
    assert_ne!(text(1e300), "null");
}
