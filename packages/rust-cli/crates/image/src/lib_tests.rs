use image::{Rgb, RgbImage, Rgba, RgbaImage};

use super::*;

fn budget(max_raw_bytes: u64, max_dimension: u32) -> Budget {
    Budget {
        max_base64_bytes: max_raw_bytes.div_ceil(3) * 4,
        max_raw_bytes,
        max_dimension,
    }
}

const ROOMY: u64 = 1 << 20;

/// Pixels that do not compress, so the byte budget decides the rung.
fn noise(width: u32, height: u32) -> DynamicImage {
    let mut state = 0x2545_f491_u32;
    DynamicImage::ImageRgba8(RgbaImage::from_fn(width, height, |_, _| {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let [r, g, b, _] = state.to_le_bytes();
        Rgba([r, g, b, 255])
    }))
}

fn png_of(image: &DynamicImage) -> Vec<u8> {
    let mut data = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut data), image::ImageFormat::Png)
        .unwrap();
    data
}

fn jpeg_of(image: &DynamicImage) -> Vec<u8> {
    encode_jpeg(image, 90).unwrap().data
}

#[test]
fn formats_are_sniffed_then_normalized_like_node() {
    assert_eq!(detect(b"\x89PNG\r\n"), Some(PNG));
    assert_eq!(detect(b"\xff\xd8\xff\xe0"), Some(JPEG));
    assert_eq!(detect(b"GIF89a"), Some(GIF));
    assert_eq!(detect(b"RIFF\0\0\0\0WEBPVP8 "), Some(WEBP));
    assert_eq!(detect(b"BM"), None);
    assert_eq!(normalize("image/JPG"), JPEG);
    assert_eq!(normalize("image/bmp"), PNG);
}

#[test]
fn an_image_within_the_budget_is_sent_unchanged() {
    let data = png_of(&noise(8, 6));
    let prepared = prepare(data.clone(), "image/png", &budget(ROOMY, 10)).unwrap();
    assert_eq!(
        prepared,
        Prepared {
            data,
            media_type: PNG,
            dimensions: Some(Dimensions {
                width: 8,
                height: 6,
                original_width: 8,
                original_height: 6,
            }),
            resized: false,
        }
    );
}

#[test]
fn the_sniffed_format_wins_over_the_declared_one() {
    let data = jpeg_of(&noise(4, 4));
    let prepared = prepare(data, "image/png", &budget(ROOMY, 10)).unwrap();
    assert_eq!(prepared.media_type, JPEG);
}

#[test]
fn webp_is_passed_through_or_refused_never_decoded() {
    let mut data = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
    data.resize(64, 7);
    let prepared = prepare(data.clone(), "image/webp", &budget(64, 1)).unwrap();
    assert_eq!(
        (prepared.media_type, prepared.dimensions, prepared.data),
        (WEBP, None, data.clone())
    );
    assert_eq!(
        prepare(data, "image/webp", &budget(63, 1)),
        Err(PrepareError::WebpTooLarge)
    );
}

#[test]
fn empty_and_undecodable_images_fail() {
    assert_eq!(
        prepare(Vec::new(), "image/png", &MODEL),
        Err(PrepareError::Empty)
    );
    assert_eq!(
        prepare(b"\x89PNG not really".to_vec(), "image/png", &MODEL),
        Err(PrepareError::Undecodable)
    );
}

#[test]
fn an_oversized_png_is_bounded_and_sent_as_jpeg() {
    // A PNG never re-encodes as PNG after its own size; 30×10 bounded to 10 px is 10×3 (round(3.33)).
    let data = png_of(&noise(30, 10));
    let prepared = prepare(data, "image/png", &budget(ROOMY, 10)).unwrap();
    assert_eq!(prepared.media_type, JPEG);
    assert_eq!(
        prepared.dimensions,
        Some(Dimensions {
            width: 10,
            height: 3,
            original_width: 30,
            original_height: 10,
        })
    );
    assert!(prepared.resized);
}

#[test]
fn a_png_within_its_size_tries_png_then_jpeg_at_that_size() {
    let image = noise(64, 64);
    let data = png_of(&image);
    let optimized = encode_png(&image).unwrap().data.len() as u64;
    let jpeg = encode_jpeg(&image, 80).unwrap().data.len() as u64;
    assert!(jpeg < optimized);
    // The original does not fit; the optimized PNG does.
    let prepared = prepare(data.clone(), "image/png", &budget(optimized, 64)).unwrap();
    assert!(prepared.data.len() as u64 <= optimized && prepared.media_type == PNG);
    // Neither PNG fits: JPEG at quality 80, same size.
    let prepared = prepare(data, "image/png", &budget(jpeg, 64)).unwrap();
    assert_eq!(prepared.media_type, JPEG);
    assert!(!prepared.resized);
}

#[test]
fn an_oversized_jpeg_is_first_re_encoded_at_jimps_default_quality() {
    let data = jpeg_of(&noise(40, 20));
    let prepared = prepare(data, "image/jpeg", &budget(ROOMY, 20)).unwrap();
    let bounded = resize_to_max_edge(&decode(&jpeg_of(&noise(40, 20))).unwrap(), 20);
    assert_eq!(
        prepared.data,
        encode_jpeg(&bounded, JIMP_DEFAULT_JPEG_QUALITY)
            .unwrap()
            .data
    );
    assert_eq!(
        (
            prepared.dimensions.unwrap().width,
            prepared.dimensions.unwrap().height
        ),
        (20, 10)
    );
}

#[test]
fn smaller_rungs_are_tried_until_one_fits() {
    let image = noise(200, 200);
    let data = png_of(&image);
    // Only a scaled-down JPEG fits.
    let target = encode_jpeg(&resize_to_max_edge(&image, 100), 20)
        .unwrap()
        .data
        .len() as u64;
    let prepared = prepare(data, "image/png", &budget(target, 200)).unwrap();
    let dimensions = prepared.dimensions.unwrap();
    assert!(dimensions.width <= 100 && prepared.media_type == JPEG && prepared.resized);
    assert!(prepared.data.len() as u64 <= target);
}

#[test]
fn nothing_fitting_is_too_large() {
    let data = png_of(&noise(16, 16));
    assert_eq!(
        prepare(data, "image/png", &budget(10, 16)),
        Err(PrepareError::TooLarge)
    );
}

#[test]
fn the_exif_orientation_is_applied_like_jimp() {
    let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 2, Rgb([200, 10, 10])));
    let jpeg = jpeg_of(&image);
    // APP1 Exif segment, big-endian TIFF, one IFD entry: Orientation (0x0112) = 6 (rotate 90° clockwise).
    let mut exif = vec![0xff, 0xe1, 0x00, 0x22];
    exif.extend(b"Exif\0\0MM\0\x2a\0\0\0\x08");
    exif.extend([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
    let data: Vec<u8> = [&jpeg[..2], &exif, &jpeg[2..]].concat();
    let prepared = prepare(data, "image/jpeg", &budget(ROOMY, 10)).unwrap();
    assert_eq!(
        prepared.dimensions,
        Some(Dimensions {
            width: 2,
            height: 4,
            original_width: 2,
            original_height: 4,
        })
    );
}

#[test]
fn scaling_rounds_like_jimp() {
    assert_eq!(js_round(3.5), 4);
    assert_eq!(js_round(0.2), 1);
    let scaled = resize_to_max_edge(&noise(5, 3), 2);
    assert_eq!((scaled.width(), scaled.height()), (2, 1));
    let kept = resize_to_max_edge(&noise(5, 3), 5);
    assert_eq!((kept.width(), kept.height()), (5, 3));
}
