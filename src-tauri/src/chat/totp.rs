//! RFC 6238 TOTP code generation for the `totp_code` tool (2FA for browser
//! agents). The SEED never leaves the keychain / password manager — the tool
//! returns only the current 6/8-digit code, so a code can be dictated to the
//! user or entered by them during the credential-takeover flow without the
//! long-lived secret ever entering a model context.
//!
//! Supported inputs:
//! - raw Base32 (RFC 4648, the Google Authenticator "setup key" format;
//!   spaces/hyphens tolerated — seeds are frequently displayed grouped)
//! - full `otpauth://totp/...` URIs (secret + optional digits/period/algorithm)
//!
//! Algorithms: SHA-1 (the universal default) and SHA-256. SHA-512 is NOT
//! supported — hmac's Sha512 would work but no authenticator in the wild
//! issues SHA-512 seeds; reject with a clear error instead of silently
//! generating a wrong code.

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::Sha256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotpAlgo {
    Sha1,
    Sha256,
}

#[derive(Debug, Clone)]
pub struct TotpConfig {
    pub secret: Vec<u8>,
    pub digits: u32,
    pub period: u64,
    pub algo: TotpAlgo,
}

impl TotpConfig {
    pub fn from_seed(seed: &str, digits: u32, period: u64) -> Result<Self, String> {
        let trimmed = seed.trim();
        if let Some(rest) = trimmed.strip_prefix("otpauth://") {
            let uri = format!("otpauth://{}", rest);
            return parse_otpauth_uri(&uri);
        }
        Ok(TotpConfig {
            secret: decode_base32(trimmed)?,
            digits: digits.clamp(6, 8),
            period: period.clamp(1, 300),
            algo: TotpAlgo::Sha1,
        })
    }
}

/// RFC 4648 Base32 decode (A–Z, 2–7, `=` padding; spaces/hyphens ignored).
/// Deliberately hand-rolled: adding a crate for ~30 lines kept the
/// dependency tree untouched, and the error cases here get bespoke
/// agent-facing messages.
pub fn decode_base32(input: &str) -> Result<Vec<u8>, String> {
    let mut acc: u64 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    let mut seen = 0usize;
    for ch in input.chars() {
        if ch == '=' || ch == ' ' || ch == '-' {
            continue;
        }
        let v = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32,
            '2'..='7' => ch as u32 - '2' as u32 + 26,
            _ => {
                return Err(format!(
                    "invalid Base32 character {ch:?} in TOTP seed — expected A-Z / 2-7"
                ))
            }
        };
        acc = (acc << 5) | v as u64;
        bits += 5;
        seen += 1;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    if seen == 0 {
        return Err("empty TOTP seed".to_string());
    }
    if out.is_empty() {
        return Err("TOTP seed too short to decode".to_string());
    }
    Ok(out)
}

/// Parse an `otpauth://totp/<label>?secret=..&digits=..&period=..&algorithm=..`
/// URI (the QR-code payload format users paste from authenticator apps).
pub fn parse_otpauth_uri(uri: &str) -> Result<TotpConfig, String> {
    let rest = uri
        .strip_prefix("otpauth://totp/")
        .ok_or_else(|| "not an otpauth://totp URI".to_string())?;
    let (_label, query) = match rest.split_once('?') {
        Some((l, q)) => (l, q),
        None => (rest, ""),
    };
    let mut secret = None;
    let mut digits = 6u32;
    let mut period = 30u64;
    let mut algo = TotpAlgo::Sha1;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        match k.to_ascii_lowercase().as_str() {
            "secret" => secret = Some(v.to_string()),
            "digits" => {
                digits = v.parse::<u32>().map_err(|_| format!("bad digits: {v}"))?;
            }
            "period" => {
                period = v.parse::<u64>().map_err(|_| format!("bad period: {v}"))?;
            }
            "algorithm" => {
                algo = match v.to_ascii_uppercase().as_str() {
                    "SHA1" | "SHA-1" => TotpAlgo::Sha1,
                    "SHA256" | "SHA-256" => TotpAlgo::Sha256,
                    other => {
                        return Err(format!(
                            "unsupported TOTP algorithm {other} — only SHA1/SHA256"
                        ))
                    }
                };
            }
            _ => {}
        }
    }
    let secret = decode_base32(&secret.ok_or_else(|| "otpauth URI missing secret=")?)?;
    Ok(TotpConfig {
        secret,
        digits: digits.clamp(6, 8),
        period: period.clamp(1, 300),
        algo,
    })
}

/// Generate the code for `at_unix` (unix seconds). Hot path of `totp_code`.
pub fn generate(cfg: &TotpConfig, at_unix: u64) -> Result<String, String> {
    let counter = at_unix / cfg.period;
    let msg = counter.to_be_bytes();
    let mac: Vec<u8> = match cfg.algo {
        TotpAlgo::Sha1 => {
            let mut m = Hmac::<Sha1>::new_from_slice(&cfg.secret)
                .map_err(|e| format!("HMAC init failed: {e}"))?;
            m.update(&msg);
            m.finalize().into_bytes().to_vec()
        }
        TotpAlgo::Sha256 => {
            let mut m = Hmac::<Sha256>::new_from_slice(&cfg.secret)
                .map_err(|e| format!("HMAC init failed: {e}"))?;
            m.update(&msg);
            m.finalize().into_bytes().to_vec()
        }
    };
    // RFC 4226 §5.3 dynamic truncation.
    let offset = (*mac.last().ok_or("empty HMAC")?) & 0x0f;
    let bin = u32::from_be_bytes([
        mac[offset as usize] & 0x7f,
        mac[offset as usize + 1],
        mac[offset as usize + 2],
        mac[offset as usize + 3],
    ]);
    let modulus = 10u64.pow(cfg.digits);
    Ok(format!("{:0width$}", bin as u64 % modulus, width = cfg.digits as usize))
}

/// Seconds remaining in the current window — surfaced to the agent so it can
/// tell the user whether the code is about to rotate.
pub fn valid_for(cfg: &TotpConfig, at_unix: u64) -> u64 {
    cfg.period - (at_unix % cfg.period)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B test seed ("12345678901234567890" in ASCII),
    // Base32-encoded as authenticators display it.
    const SEED_SHA1: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    // 32-byte variant (RFC 6238 Appendix B: ASCII "123456789012345678901
    // 23456789012") for SHA-256.
    const SEED_SHA256: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";

    #[test]
    fn rfc6238_sha1_reference_vectors() {
        let cfg = TotpConfig::from_seed(SEED_SHA1, 8, 30).unwrap();
        // T=59s -> 94287082 (8-digit SHA1 vector).
        assert_eq!(generate(&cfg, 59).unwrap(), "94287082");
        assert_eq!(generate(&cfg, 1111111109).unwrap(), "07081804");
        assert_eq!(generate(&cfg, 1234567890).unwrap(), "89005924");
    }

    #[test]
    fn rfc6238_sha256_reference_vectors() {
        let cfg = TotpConfig {
            secret: decode_base32(SEED_SHA256).unwrap(),
            digits: 8,
            period: 30,
            algo: TotpAlgo::Sha256,
        };
        assert_eq!(generate(&cfg, 59).unwrap(), "46119246");
        assert_eq!(generate(&cfg, 1111111109).unwrap(), "68084774");
    }

    #[test]
    fn six_digit_output_and_window_math() {
        let cfg = TotpConfig::from_seed(SEED_SHA1, 6, 30).unwrap();
        let code = generate(&cfg, 59).unwrap();
        assert_eq!(code.len(), 6);
        assert_eq!(code, "287082"); // trailing 6 of the 8-digit vector
        assert_eq!(valid_for(&cfg, 59), 1);
        assert_eq!(valid_for(&cfg, 60), 30);
    }

    #[test]
    fn base32_tolerates_grouping_and_rejects_garbage() {
        let grouped = format!(
            "{} {} {}",
            &SEED_SHA1[0..8],
            &SEED_SHA1[8..16],
            &SEED_SHA1[16..]
        );
        let cfg = TotpConfig::from_seed(&grouped, 6, 30).unwrap();
        assert_eq!(generate(&cfg, 59).unwrap(), "287082");
        assert!(decode_base32("abc1!").is_err(), "1 is not Base32");
        assert!(decode_base32("  --  ").is_err(), "empty after separators");
    }

    #[test]
    fn otpauth_uri_parses_params() {
        let uri = "otpauth://totp/GitHub:me%40x.io?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub&digits=8&period=60&algorithm=SHA256";
        let cfg = TotpConfig::from_seed(uri, 6, 30).unwrap();
        assert_eq!(cfg.digits, 8);
        assert_eq!(cfg.period, 60);
        assert_eq!(cfg.algo, TotpAlgo::Sha256);
        assert_eq!(generate(&cfg, 59).unwrap().len(), 8);
        // URI params win over the tool-call defaults — the seed above is 16
        // chars so it must still decode.
        let minimal = TotpConfig::from_seed("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ", 6, 30).unwrap();
        assert_eq!(minimal.digits, 6);
        assert_eq!(minimal.algo, TotpAlgo::Sha1);
        assert!(TotpConfig::from_seed("otpauth://totp/x?digits=6", 6, 30).is_err());
    }

    #[test]
    fn sha512_is_rejected_not_misgenerated() {
        let err = TotpConfig::from_seed(
            "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA512",
            6,
            30,
        )
        .unwrap_err();
        assert!(err.contains("SHA512"));
    }
}
