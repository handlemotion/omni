//! The spool's video: fragmented MP4 as the macOS helper writes it, its header (`ftyp`, `moov`)
//! and then whole fragments (`moof`, `mdat`). Played as it is, so all a crash needs is the file
//! cut after its last whole fragment.

use std::io::{self, Read, Seek, SeekFrom};

/// One top-level box: its type, and its size counting its own header. `None` past the end, or
/// where a header says nothing sensible (a size smaller than the header, a box cut short).
fn next_box(
    reader: &mut (impl Read + Seek),
    at: u64,
    len: u64,
) -> io::Result<Option<([u8; 4], u64)>> {
    if len.saturating_sub(at) < 8 {
        return Ok(None);
    }
    reader.seek(SeekFrom::Start(at))?;
    let mut header = [0_u8; 8];
    reader.read_exact(&mut header)?;
    let [s0, s1, s2, s3, t0, t1, t2, t3] = header;
    let kind = [t0, t1, t2, t3];
    let size = match u32::from_be_bytes([s0, s1, s2, s3]) {
        // A 64-bit size follows the type.
        1 => {
            if len - at < 16 {
                return Ok(None);
            }
            let mut large = [0_u8; 8];
            reader.read_exact(&mut large)?;
            let size = u64::from_be_bytes(large);
            if size < 16 {
                return Ok(None);
            }
            size
        }
        // "To the end of the file": only the writer knows where that was.
        0 => return Ok(None),
        size if size < 8 => return Ok(None),
        size => u64::from(size),
    };
    if size > len - at {
        return Ok(None);
    }
    Ok(Some((kind, size)))
}

/// How many bytes of the video play: up to the end of its last whole fragment's `mdat`, or 0
/// when not even one fragment arrived (a header alone shows nothing).
pub fn playable_len(reader: &mut (impl Read + Seek), len: u64) -> io::Result<u64> {
    let mut at = 0;
    let mut playable = 0;
    while let Some((kind, size)) = next_box(reader, at, len)? {
        at += size;
        if &kind == b"mdat" {
            playable = at;
        }
    }
    Ok(playable)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn boxed(kind: &[u8; 4], body: usize) -> Vec<u8> {
        let mut out = u32::try_from(8 + body).unwrap().to_be_bytes().to_vec();
        out.extend(kind);
        out.extend(std::iter::repeat_n(7, body));
        out
    }

    fn video(parts: &[(&[u8; 4], usize)]) -> Vec<u8> {
        parts.iter().flat_map(|(k, n)| boxed(k, *n)).collect()
    }

    fn playable(bytes: &[u8]) -> u64 {
        playable_len(&mut Cursor::new(bytes), bytes.len() as u64).unwrap()
    }

    // Bug: keeping a fragment cut short by a crash leaves a file the browser stops playing at
    // that point, or refuses outright.
    #[test]
    fn a_fragment_cut_short_is_dropped() {
        let whole = video(&[
            (b"ftyp", 20),
            (b"moov", 600),
            (b"moof", 300),
            (b"mdat", 5000),
        ]);
        let mut cut = whole.clone();
        cut.extend(video(&[(b"moof", 300), (b"mdat", 5000)]));
        cut.truncate(whole.len() + 308 + 1000);
        assert_eq!(playable(&cut), whole.len() as u64);
        assert_eq!(playable(&whole), whole.len() as u64);
    }

    // Bug: a `moof` whose `mdat` never arrived points at frames that are not there.
    #[test]
    fn a_fragment_without_its_frames_is_dropped() {
        let whole = video(&[(b"ftyp", 20), (b"moov", 600), (b"moof", 300), (b"mdat", 50)]);
        let mut more = whole.clone();
        more.extend(boxed(b"moof", 300));
        assert_eq!(playable(&more), whole.len() as u64);
    }

    // Bug: a header with no frames would upload as a video that shows nothing.
    #[test]
    fn a_header_alone_is_no_video() {
        assert_eq!(playable(&video(&[(b"ftyp", 20), (b"moov", 600)])), 0);
        assert_eq!(playable(&[]), 0);
    }

    // Bug: a garbled size (0, or smaller than its header) would loop forever or read past the
    // file; the walk stops there and keeps what came before.
    #[test]
    fn a_garbled_size_ends_the_walk() {
        let whole = video(&[(b"ftyp", 20), (b"moov", 600), (b"moof", 300), (b"mdat", 50)]);
        for size in [0_u32, 3] {
            let mut bad = whole.clone();
            bad.extend(size.to_be_bytes());
            bad.extend(b"moof");
            bad.extend([0; 40]);
            assert_eq!(playable(&bad), whole.len() as u64);
        }
    }
}
