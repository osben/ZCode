//! Fork: prepares an attached image for the model (specs/fork-agent-runtime-selection.md "Image preparation"). A port of
//! Node's `prepareJimpImageForModel` (`adapters/src/image/jimp-compression.ts`): the same budgets, format rules and
//! candidate ladder; the encoders differ from Jimp's, so the bytes (and in a borderline case the chosen rung) can too.
//!
//! The work is CPU bound and synchronous: callers run it off the async threads.

use std::io::Cursor;

use image::codecs::gif::GifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, ImageDecoder, ImageReader};

/// Node `READ_IMAGE_MAX_BASE64_BYTES`.
pub const MAX_BASE64_BYTES: u64 = 5 * 1024 * 1024;
/// Node `READ_IMAGE_TARGET_BYTES`: floor(5 MiB × 3 / 4).
pub const MAX_RAW_BYTES: u64 = MAX_BASE64_BYTES * 3 / 4;
/// Node `MAX_IMAGE_ATTACHMENT_DIMENSION`.
pub const MAX_DIMENSION: u32 = 2000;

const PNG: &str = "image/png";
const JPEG: &str = "image/jpeg";
const GIF: &str = "image/gif";
const WEBP: &str = "image/webp";

const JPEG_QUALITY_STEPS: [u8; 4] = [80, 60, 40, 20];
const PROGRESSIVE_SCALE_FACTORS: [f64; 3] = [0.75, 0.5, 0.25];
const AGGRESSIVE_JPEG_MAX_EDGES: [u32; 6] = [1000, 800, 600, 400, 300, 200];
/// Jimp's default JPEG quality (`@jimp/js-jpeg`), used when an image is only re-encoded after bounding.
const JIMP_DEFAULT_JPEG_QUALITY: u8 = 100;

/// What the model may receive (Node `ImageBudget`, no token cap for attachments).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub max_base64_bytes: u64,
    pub max_raw_bytes: u64,
    pub max_dimension: u32,
}

/// The budget of an attached image.
pub const MODEL: Budget = Budget {
    max_base64_bytes: MAX_BASE64_BYTES,
    max_raw_bytes: MAX_RAW_BYTES,
    max_dimension: MAX_DIMENSION,
};

impl Budget {
    /// Node `fitsImageBudget`.
    fn fits(&self, data: &[u8]) -> bool {
        let raw = data.len() as u64;
        raw <= self.max_raw_bytes && raw.div_ceil(3) * 4 <= self.max_base64_bytes
    }
}

/// The pixel sizes Node reports in `metadata.image` (none for a WebP image, which is never decoded).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
}

/// The image to send (Node `ImagePrepareForModelResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub data: Vec<u8>,
    pub media_type: &'static str,
    pub dimensions: Option<Dimensions>,
    /// The pixel size changed.
    pub resized: bool,
}

/// Why an image could not be prepared (Node `createImageProcessorError` codes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrepareError {
    /// `empty`.
    Empty,
    /// `processing_failed`: the bytes do not decode.
    Undecodable,
    /// `unsupported`: a WebP image over the budget (it is never transcoded).
    WebpTooLarge,
    /// `too_large`: no candidate fits.
    TooLarge,
}

impl std::fmt::Display for PrepareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PrepareError::Empty => "image file is empty",
            PrepareError::Undecodable => "unable to decode image data",
            PrepareError::WebpTooLarge => "WebP image exceeds the model image budget",
            PrepareError::TooLarge => "unable to compress image within the model image budget",
        })
    }
}

impl std::error::Error for PrepareError {}

/// Node `detectImageMediaType`.
pub fn detect(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some(PNG)
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(JPEG)
    } else if data.starts_with(b"GIF") {
        Some(GIF)
    } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        Some(WEBP)
    } else {
        None
    }
}

/// Node `normalizeMediaType`.
fn normalize(media_type: &str) -> &'static str {
    match media_type.to_ascii_lowercase().as_str() {
        "image/jpg" | "image/jpeg" => JPEG,
        "image/gif" => GIF,
        "image/webp" => WEBP,
        _ => PNG,
    }
}

/// Node `prepareJimpImageForModel`: the original when it is within the budget and the size limit, else the first
/// candidate of the ladder that fits.
pub fn prepare(data: Vec<u8>, media_type: &str, budget: &Budget) -> Result<Prepared, PrepareError> {
    if data.is_empty() {
        return Err(PrepareError::Empty);
    }
    let source = normalize(detect(&data).unwrap_or(media_type));
    if source == WEBP {
        // Node `prepareWebpPassthrough`: no decoder, so no pixel check either.
        if !budget.fits(&data) {
            return Err(PrepareError::WebpTooLarge);
        }
        return Ok(Prepared {
            data,
            media_type: WEBP,
            dimensions: None,
            resized: false,
        });
    }
    let image = decode(&data).ok_or(PrepareError::Undecodable)?;
    let (original_width, original_height) = (image.width(), image.height());
    let within = longest_edge(&image) <= budget.max_dimension;
    if within && budget.fits(&data) {
        return Ok(Prepared {
            data,
            media_type: source,
            dimensions: Some(Dimensions {
                width: original_width,
                height: original_height,
                original_width,
                original_height,
            }),
            resized: false,
        });
    }
    let candidate = first_fitting(&image, source, within, budget).ok_or(PrepareError::TooLarge)?;
    Ok(Prepared {
        resized: (candidate.width, candidate.height) != (original_width, original_height),
        dimensions: Some(Dimensions {
            width: candidate.width,
            height: candidate.height,
            original_width,
            original_height,
        }),
        data: candidate.data,
        media_type: candidate.media_type,
    })
}

/// Jimp `fromBuffer`: decode, then apply the EXIF orientation (`attemptExifRotate`).
fn decode(data: &[u8]) -> Option<DynamicImage> {
    let mut decoder = ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder.orientation().ok();
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    if let Some(orientation) = orientation {
        image.apply_orientation(orientation);
    }
    Some(image)
}

struct Candidate {
    data: Vec<u8>,
    media_type: &'static str,
    width: u32,
    height: u32,
}

fn longest_edge(image: &DynamicImage) -> u32 {
    image.width().max(image.height())
}

/// JS `Math.round` of a non-negative number, at least 1 (Jimp `resize`).
fn js_round(value: f64) -> u32 {
    ((value + 0.5).floor() as u32).max(1)
}

/// Node `resizeToMaxEdge`: Jimp `scaleToFit` into a `max_edge` square with bicubic sampling.
fn resize_to_max_edge(image: &DynamicImage, max_edge: u32) -> DynamicImage {
    if longest_edge(image) <= max_edge {
        return image.clone();
    }
    let (width, height) = (f64::from(image.width()), f64::from(image.height()));
    let factor = f64::from(max_edge) / width.max(height);
    image.resize_exact(
        js_round(width * factor),
        js_round(height * factor),
        FilterType::CatmullRom,
    )
}

fn candidate(image: &DynamicImage, media_type: &'static str, data: Vec<u8>) -> Candidate {
    Candidate {
        data,
        media_type,
        width: image.width(),
        height: image.height(),
    }
}

fn encode_jpeg(image: &DynamicImage, quality: u8) -> Option<Candidate> {
    let mut data = Vec::new();
    // JPEG has no alpha: Jimp's encoder drops it too.
    let rgb = DynamicImage::ImageRgb8(image.to_rgb8());
    rgb.write_with_encoder(JpegEncoder::new_with_quality(&mut data, quality))
        .ok()?;
    Some(candidate(image, JPEG, data))
}

/// Jimp's PNG encoder writes RGBA (`inputHasAlpha` defaults to true) at deflate level 9.
fn encode_png(image: &DynamicImage) -> Option<Candidate> {
    let mut data = Vec::new();
    let rgba = DynamicImage::ImageRgba8(image.to_rgba8());
    let encoder =
        PngEncoder::new_with_quality(&mut data, CompressionType::Best, PngFilter::Adaptive);
    rgba.write_with_encoder(encoder).ok()?;
    Some(candidate(image, PNG, data))
}

fn encode_gif(image: &DynamicImage) -> Option<Candidate> {
    let mut data = Vec::new();
    let rgba = image.to_rgba8();
    GifEncoder::new(&mut data)
        .encode(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(candidate(image, GIF, data))
}

/// Node `encodeCandidate` with Jimp's default options for the format.
fn encode_as(image: &DynamicImage, media_type: &'static str) -> Option<Candidate> {
    match media_type {
        JPEG => encode_jpeg(image, JIMP_DEFAULT_JPEG_QUALITY),
        GIF => encode_gif(image),
        _ => encode_png(image),
    }
}

fn fit(candidate: Option<Candidate>, budget: &Budget) -> Option<Candidate> {
    candidate.filter(|candidate| budget.fits(&candidate.data))
}

/// Node `findJpegQualityCandidate`.
fn jpeg_ladder(image: &DynamicImage, budget: &Budget) -> Option<Candidate> {
    JPEG_QUALITY_STEPS
        .iter()
        .find_map(|quality| fit(encode_jpeg(image, *quality), budget))
}

/// Node `findFormatPreservingCandidate`.
fn format_preserving(image: &DynamicImage, source: &str, budget: &Budget) -> Option<Candidate> {
    match source {
        PNG => fit(encode_png(image), budget),
        JPEG => jpeg_ladder(image, budget),
        GIF => fit(encode_gif(image), budget),
        _ => None,
    }
}

/// Node `findFirstFittingCandidate`, rung for rung.
fn first_fitting(
    image: &DynamicImage,
    source: &'static str,
    within: bool,
    budget: &Budget,
) -> Option<Candidate> {
    // Node: a PNG gets one lossless attempt at its own size, then only JPEG.
    let preserve = source != PNG;
    if within && let Some(candidate) = format_preserving(image, source, budget) {
        return Some(candidate);
    }
    let bounded = resize_to_max_edge(image, budget.max_dimension);
    let bounding_changed = (bounded.width(), bounded.height()) != (image.width(), image.height());
    if preserve
        && bounding_changed
        && let Some(candidate) = fit(encode_as(&bounded, source), budget)
    {
        return Some(candidate);
    }
    if !within
        && preserve
        && let Some(candidate) = format_preserving(&bounded, source, budget)
    {
        return Some(candidate);
    }
    if let Some(candidate) = jpeg_ladder(&bounded, budget) {
        return Some(candidate);
    }
    for scale in PROGRESSIVE_SCALE_FACTORS {
        let edge = js_round(f64::from(longest_edge(&bounded)) * scale);
        let scaled = resize_to_max_edge(&bounded, edge);
        if preserve && let Some(candidate) = format_preserving(&scaled, source, budget) {
            return Some(candidate);
        }
        if let Some(candidate) = jpeg_ladder(&scaled, budget) {
            return Some(candidate);
        }
    }
    AGGRESSIVE_JPEG_MAX_EDGES.iter().find_map(|edge| {
        let scaled = resize_to_max_edge(image, (*edge).min(budget.max_dimension));
        fit(encode_jpeg(&scaled, 20), budget)
    })
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
