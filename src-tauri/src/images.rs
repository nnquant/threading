use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};

use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig},
    Engine,
};
use uuid::Uuid;

use crate::models::ImageRef;

const MAX_SIZE: usize = 10 * 1024 * 1024;
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn save(data_path: &Path, data: &str) -> Result<ImageRef, String> {
    let bytes = BASE64
        .decode(data)
        .map_err(|_| "图片数据无法读取。".to_string())?;
    if bytes.is_empty() {
        return Err("图片是空的。".into());
    }
    if bytes.len() > MAX_SIZE {
        return Err("图片不能超过 10 MB。".into());
    }
    let (ext, mime) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("png", "image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        ("jpg", "image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        ("gif", "image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        ("webp", "image/webp")
    } else {
        return Err("只支持 PNG、JPEG、GIF 和 WebP 图片。".into());
    };
    let id = format!("{}.{ext}", Uuid::new_v4());
    let dir = data_path.parent().ok_or("无法保存图片。")?.join("images");
    fs::create_dir_all(&dir).map_err(|_| "无法保存图片。".to_string())?;
    write_image(&dir.join(&id), &bytes).map_err(|_| "无法保存图片。".to_string())?;
    Ok(ImageRef {
        id,
        mime: mime.into(),
        size: bytes.len(),
    })
}

pub(crate) fn write_image(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn valid_id(id: &str) -> bool {
    let Some((uuid, ext)) = id.split_once('.') else {
        return false;
    };
    // Match the contract's exact ASCII pattern; never trim or normalize paths/UUIDs.
    matches!(ext, "png" | "jpg" | "gif" | "webp")
        && uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, byte)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

pub fn read(data_path: &Path, id: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err("图片地址无效。".into());
    }
    let dir = data_path
        .parent()
        .ok_or("图片数据无法读取。")?
        .join("images");
    fs::read(dir.join(id)).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "找不到这张图片，可能已被删除。".into()
        } else {
            "图片数据无法读取。".into()
        }
    })
}
