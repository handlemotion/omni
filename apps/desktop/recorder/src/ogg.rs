//! Ogg pages (RFC 3533), written by hand so the recorder controls exactly when a page reaches
//! the disk, and read back after a crash to cut the file at its last whole page.

use std::sync::OnceLock;

pub const CONTINUED: u8 = 0x01;
pub const BEGINNING: u8 = 0x02;
pub const END: u8 = 0x04;
const HEADER: usize = 27;
const CAPTURE: &[u8; 4] = b"OggS";

fn table() -> &'static [u32; 256] {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0_u32; 256];
        for (i, entry) in (0_u32..).zip(table.iter_mut()) {
            let mut r = i << 24;
            for _ in 0..8 {
                r = if r & 0x8000_0000 == 0 {
                    r << 1
                } else {
                    (r << 1) ^ 0x04c1_1db7
                };
            }
            *entry = r;
        }
        table
    })
}

/// Ogg's checksum: CRC-32, polynomial 0x04c11db7, unreflected, over the page with its CRC zeroed.
pub fn crc(bytes: &[u8]) -> u32 {
    let table = table();
    bytes.iter().fold(0_u32, |crc, &b| {
        (crc << 8) ^ table[usize::from(((crc >> 24) as u8) ^ b)]
    })
}

fn set_crc(page: &mut [u8]) {
    page[22..26].fill(0);
    let sum = crc(page);
    page[22..26].copy_from_slice(&sum.to_le_bytes());
}

/// One page holding `packets` whole (each under 64 KiB, as 20 ms of Opus always is).
pub fn page(serial: u32, sequence: u32, granule: u64, flags: u8, packets: &[Vec<u8>]) -> Vec<u8> {
    let mut lacing = Vec::new();
    for packet in packets {
        lacing.extend(std::iter::repeat_n(255_u8, packet.len() / 255));
        lacing.push((packet.len() % 255) as u8);
    }
    debug_assert!(lacing.len() <= 255, "too many packets for one page");
    let mut out =
        Vec::with_capacity(HEADER + lacing.len() + packets.iter().map(Vec::len).sum::<usize>());
    out.extend_from_slice(CAPTURE);
    out.push(0);
    out.push(flags);
    out.extend_from_slice(&granule.to_le_bytes());
    out.extend_from_slice(&serial.to_le_bytes());
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.push(lacing.len() as u8);
    out.extend_from_slice(&lacing);
    for packet in packets {
        out.extend_from_slice(packet);
    }
    set_crc(&mut out);
    out
}

/// Where a whole, checksummed page sits in a file, and what it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageAt {
    pub offset: usize,
    pub len: usize,
    pub granule: u64,
    pub flags: u8,
}

fn page_at(bytes: &[u8], offset: usize) -> Option<PageAt> {
    let rest = bytes.get(offset..)?;
    if rest.len() < HEADER || &rest[..4] != CAPTURE || rest[4] != 0 {
        return None;
    }
    let segments = usize::from(rest[26]);
    let lacing = rest.get(HEADER..HEADER + segments)?;
    let len = HEADER + segments + lacing.iter().map(|&l| usize::from(l)).sum::<usize>();
    let mut whole = rest.get(..len)?.to_vec();
    let stored = u32::from_le_bytes([whole[22], whole[23], whole[24], whole[25]]);
    whole[22..26].fill(0);
    if crc(&whole) != stored {
        return None;
    }
    let mut granule = [0_u8; 8];
    granule.copy_from_slice(&rest[6..14]);
    Some(PageAt {
        offset,
        len,
        granule: u64::from_le_bytes(granule),
        flags: rest[5],
    })
}

/// The file's whole pages from the start, stopping at the first one that is cut short or
/// damaged: everything before it was written whole.
pub fn pages(bytes: &[u8]) -> Vec<PageAt> {
    let mut found = Vec::new();
    let mut offset = 0;
    while let Some(page) = page_at(bytes, offset) {
        offset += page.len;
        found.push(page);
    }
    found
}

/// What `repair` did to a file the recorder never closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Repaired {
    /// Bytes kept: the file is cut to this length.
    pub len: usize,
    /// The last page's granule position (samples at 48 kHz, pre-skip included).
    pub granule: u64,
}

/// Cuts `bytes` after its last whole page and marks that page as the stream's end, so a file
/// left by a crash plays to the last moment that reached the disk. Already-closed files are left
/// as they are. `None` when not even the two header pages are whole.
pub fn repair(bytes: &mut Vec<u8>) -> Option<Repaired> {
    let found = pages(bytes);
    let last = *found.get(1).and(found.last())?;
    let end = last.offset + last.len;
    bytes.truncate(end);
    if last.flags & END == 0 && found.len() > 2 {
        let page = &mut bytes[last.offset..end];
        page[5] |= END;
        set_crc(page);
    }
    Some(Repaired {
        len: end,
        granule: last.granule,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(pages_of: &[(u64, u8)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (sequence, &(granule, flags)) in (0_u32..).zip(pages_of) {
            out.extend(page(
                7,
                sequence,
                granule,
                flags,
                &[vec![sequence as u8; 300], vec![1; 20]],
            ));
        }
        out
    }

    // Bug: a wrong checksum makes every player reject the file, so the whole recording is lost.
    #[test]
    fn the_checksum_is_oggs() {
        // The CRC of "123456789" under Ogg's parameters (CRC-32/MPEG-2 with init 0).
        assert_eq!(crc(b"123456789"), 0x89a1_897f);
    }

    // Bug: a packet of exactly 255 bytes needs a 0 lacing value after it, or it runs into the
    // next packet and the decoder reads garbage.
    #[test]
    fn a_255_byte_packet_ends_with_a_zero_lacing() {
        let bytes = page(1, 0, 0, 0, &[vec![9; 255], vec![8; 3]]);
        assert_eq!(
            &bytes[26..30],
            &[3, 255, 0, 3],
            "segment count, then the lacing"
        );
        assert_eq!(bytes[30..].len(), 258);
        assert_eq!(pages(&bytes).len(), 1);
    }

    // Bug: a crash mid-write leaves half a page; kept, it would make the file unreadable.
    #[test]
    fn a_cut_page_is_dropped_and_the_last_whole_one_ends_the_stream() {
        let mut bytes = stream(&[(0, BEGINNING), (0, 0), (960, 0), (1920, 0)]);
        let whole = bytes.len();
        let last_start = pages(&bytes)[3].offset;
        bytes.truncate(whole - 10);
        let repaired = repair(&mut bytes).unwrap();
        assert_eq!(
            repaired,
            Repaired {
                len: last_start,
                granule: 960
            }
        );
        let after = pages(&bytes);
        assert_eq!(after.len(), 3, "every whole page is kept");
        assert_eq!(after[2].flags & END, END);
    }

    // Bug: repairing a file twice (the app opened twice after a crash) must not change it again.
    #[test]
    fn repair_is_idempotent() {
        let mut bytes = stream(&[(0, BEGINNING), (0, 0), (960, 0)]);
        repair(&mut bytes).unwrap();
        let once = bytes.clone();
        repair(&mut bytes).unwrap();
        assert_eq!(bytes, once);
    }

    // Bug: a flipped byte inside a page (a torn write) would be uploaded as if it were audio.
    #[test]
    fn a_damaged_page_ends_the_good_part() {
        let mut bytes = stream(&[(0, BEGINNING), (0, 0), (960, 0), (1920, 0)]);
        let third = pages(&bytes)[2];
        bytes[third.offset + 40] ^= 0xff;
        assert_eq!(repair(&mut bytes).unwrap().granule, 0);
        assert_eq!(pages(&bytes).len(), 2);
    }

    // Bug: a file with no audio page at all must not be marked ended inside its headers.
    #[test]
    fn headers_alone_are_not_rewritten_and_less_is_nothing() {
        let mut bytes = stream(&[(0, BEGINNING), (0, 0)]);
        let before = bytes.clone();
        assert!(repair(&mut bytes).is_some());
        assert_eq!(bytes, before);
        let mut short = stream(&[(0, BEGINNING)]);
        assert_eq!(repair(&mut short), None);
    }
}
