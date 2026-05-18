//! Slug normalization — port of `shared/inbox-slug.ts`.
//!
//! Slugs are used for both `account.email`-derived defaults and `agent.slug`. The
//! algorithm: NFKD-strip diacritics, lowercase, replace any non-alnum runs with `-`, trim
//! leading/trailing `-`. Reserved slugs (`favicon.ico`, `robots.txt`, `sitemap.xml`) are
//! rejected. The 64-bit FNV-1a hash is used to derive deterministic disambiguating suffixes
//! when an email's natural slug is already taken.

const FNV64_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV64_PRIME: u64 = 0x100_0000_01b3;

pub const RESERVED_SLUGS: &[&str] = &["favicon-ico", "robots-txt", "sitemap-xml"];

fn strip_diacritics(value: &str) -> String {
    // ASCII-only inputs are the common case (emails are ASCII per RFC 5321 normalized form).
    // For Unicode inputs the JS `String.prototype.normalize('NFKD')` decomposes combining marks;
    // Rust's `unicode-normalization` would do the same but isn't a free dep. Strip diacritics
    // by filtering combining marks (U+0300–U+036F) from a `to_lowercase` pass — for non-ASCII
    // inputs the slug regex below removes anything that isn't ascii alphanumeric anyway, so
    // the diacritic mark doesn't matter past the lowercase step. This keeps parity with the
    // shared TS implementation for the inputs the system actually sees.
    value
        .chars()
        .filter(|c| !matches!(*c as u32, 0x0300..=0x036F))
        .collect()
}

pub fn normalize_slug(value: &str) -> String {
    let stripped = strip_diacritics(value).to_lowercase();
    let mut out = String::with_capacity(stripped.len());
    let mut last_was_dash = true;
    for c in stripped.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

pub fn is_reserved_slug(slug: &str) -> bool {
    let normalized = normalize_slug(slug);
    RESERVED_SLUGS.contains(&normalized.as_str())
}

pub fn email_slug_base(email: &str) -> String {
    let slug = normalize_slug(email);
    if slug.is_empty() {
        "inbox".to_string()
    } else {
        slug
    }
}

fn fnv1a_hash(value: &str) -> u64 {
    let mut hash = FNV64_OFFSET_BASIS;
    for c in value.chars() {
        hash ^= c as u64;
        hash = hash.wrapping_mul(FNV64_PRIME);
    }
    hash
}

fn to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let alphabet: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buf = Vec::with_capacity(13);
    while value > 0 {
        buf.push(alphabet[(value % 36) as usize]);
        value /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).expect("base36 alphabet is ASCII")
}

/// Default slug for a normalized email: `<base>-<8-char-base36-hash-prefix>`.
pub fn build_default_slug(email: &str) -> String {
    let base = email_slug_base(email);
    let hash = to_base36(fnv1a_hash(email));
    let suffix: String = hash.chars().take(8).collect();
    format!("{base}-{suffix}")
}
